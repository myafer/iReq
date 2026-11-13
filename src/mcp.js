'use strict';

/**
 * MCP（Model Context Protocol）服务端：把 iReq 的抓包 / Mock / 弱网能力暴露成工具，
 * 让 AI 客户端（本机或经 stdio 桥）能读流量、建规则、改弱网。
 *
 * 传输：Streamable HTTP（POST /mcp，JSON-RPC 2.0，单条或批量）。
 * 授权：Authorization: Bearer <ireq_mcp_...>，令牌由界面生成，只存哈希（见 mcp-auth.js）。
 * 协议：只声明 tools 能力（无 resources / prompts / sampling），因此无需会话状态。
 */

const os = require('os');
const { normalize: normalizeNetworkSim } = require('./network-sim');
const { replay } = require('./replay');
const { McpAuth } = require('./mcp-auth');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 1024 * 1024; /* MCP 请求体上限：1MB，够大也够安全 */
const MAX_TEXT = 64 * 1024; /* 单次返回的正文上限，避免把上下文塞爆 */

const pkg = require('../package.json');

/* ---------------- 小工具 ---------------- */

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function clip(text, limit = MAX_TEXT) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit), truncated: true };
}

function requireString(args, key, { max = 2000, allowEmpty = false } = {}) {
  const v = args[key];
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) {
    throw new ToolError(`缺少参数 ${key}（字符串）`);
  }
  if (v.length > max) throw new ToolError(`参数 ${key} 过长（上限 ${max} 字符）`);
  return v;
}

function optString(args, key, max = 2000) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`参数 ${key} 必须是字符串`);
  if (v.length > max) throw new ToolError(`参数 ${key} 过长（上限 ${max} 字符）`);
  return v;
}

function optInt(args, key, { min = -Infinity, max = Infinity } = {}) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`参数 ${key} 必须是数字`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function optBool(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`参数 ${key} 必须是布尔值`);
  return v;
}

class ToolError extends Error {}

/* ---------------- 参数 schema 片段 ---------------- */

const S = {
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description) => ({ type: 'boolean', description }),
};

/* ---------------- 工具定义 ---------------- */

const TOOLS = [
  {
    name: 'ireq_status',
    title: 'iReq 运行状态',
    description:
      '查看 iReq 代理与控制台状态：端口、局域网地址、已抓流量条数、规则数量、证书信任、安全模式、HTTP/2 与弱网开关。排查「为什么抓不到包」时先调这个。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const s = ctx.server;
      const flows = s.store.stats();
      const rules = s.rules.list();
      return {
        version: pkg.version,
        proxy: {
          port: s.proxy ? s.proxy.port : null,
          running: Boolean(s.proxy),
          lan: lanAddresses(),
          stats: s.proxy ? s.proxy.stats : {},
        },
        console: {
          port: s.port,
          url: `http://127.0.0.1:${s.port}`,
          mcp_endpoint: `http://127.0.0.1:${s.port}/mcp`,
        },
        capture: s.config.capture !== false,
        mock_enabled: s.config.mockEnabled !== false,
        h2_enabled: s.config.h2Enabled !== false,
        mitm_ports: s.config.mitmPorts || [443],
        ca_trusted: s.config.caTrusted !== false,
        safe_mode: Boolean(s._safeMode && s._safeMode()),
        passthrough: s.config.passthrough || [],
        rules: { total: rules.length, enabled: rules.filter((r) => r.enabled).length },
        flows: { in_memory: flows.count || flows.total || 0, ...flows },
        network_sim: normalizeNetworkSim(s.config.networkSim),
        data_dir: s.dataDir || null,
      };
    },
  },

  {
    name: 'list_flows',
    title: '查询抓包流量',
    description:
      '按关键词 / 方法 / 状态码 / 域名 / 应用筛选最近的请求，返回精简列表（含 id、URL、状态、耗时、应用）。关键词匹配 URL、应用名、IP、设备；状态码支持 2xx / 404 / error 等写法。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: S.str('关键词，匹配 URL / 应用名 / IP / 设备'),
        method: S.str('HTTP 方法，如 GET / POST'),
        status: S.str('状态码筛选：2xx / 4xx / 500 / ok / error / json（内容类型）'),
        host: S.str('域名精确匹配，如 api.example.com'),
        app: S.str('应用名（可逗号分隔多个）'),
        only_mocked: S.bool('只看被 Mock 命中的请求'),
        limit: S.int('返回条数，默认 50，最大 200', { minimum: 1, maximum: 200 }),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const flows = ctx.server.store.list({
        query: optString(args, 'query', 200) || '',
        method: optString(args, 'method', 20) || '',
        status: optString(args, 'status', 40) || '',
        host: optString(args, 'host', 200) || '',
        app: optString(args, 'app', 200) || '',
        onlyMocked: optBool(args, 'only_mocked') === true,
        limit: optInt(args, 'limit', { min: 1, max: 200 }) || 50,
      });
      return {
        count: flows.length,
        flows: flows.map((f) => ({
          id: f.id,
          time: new Date(f.ts || Date.now()).toISOString(),
          method: f.method,
          url: f.url,
          status: f.status,
          duration_ms: f.duration,
          size: f.resSize,
          app: f.app || null,
          client_ip: f.clientIp || null,
          mocked: Boolean(f.mocked),
          content_type: f.resContentType || null,
          error: f.error || null,
        })),
      };
    },
  },

  {
    name: 'get_flow',
    title: '读取单条流量详情',
    description:
      '按 id 读取一条请求的完整信息：请求/响应头、请求体、响应体、耗时、命中规则。二进制响应只给大小，除非 include_binary=true。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('流量 id（list_flows 返回的 id）'),
        body: S.str('要正文的部分：auto（默认）/ none / request / response / both', {
          enum: ['auto', 'none', 'request', 'response', 'both'],
        }),
        include_binary: S.bool('是否返回二进制正文（base64，最多 64KB）'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = requireString(args, 'id', { max: 100 });
      const flow = ctx.server.store.get(id);
      if (!flow) throw new ToolError(`找不到流量 ${id}（可能已被清空）`);
      const mode = optString(args, 'body', 20) || 'auto';
      const wantReq = mode === 'request' || mode === 'both' || mode === 'auto';
      const wantRes = mode === 'response' || mode === 'both' || mode === 'auto';
      const includeBinary = optBool(args, 'include_binary') === true;

      const pick = (text, b64, isReq) => {
        const out = {};
        if (b64) {
          out.binary = true;
          out.encoding = 'base64';
          out.bytes = Buffer.from(String(b64), 'base64').length;
          if (includeBinary) {
            const c = clip(String(b64), MAX_TEXT);
            out.body = c.text;
            out.truncated = c.truncated;
          } else {
            out.note = '二进制正文已省略；需要时传 include_binary=true（最多 64KB）';
          }
          return out;
        }
        if (text == null || text === '') return out;
        const c = clip(String(text));
        out.body = c.text;
        if (c.truncated) out.truncated = true;
        out.bytes = Number(isReq ? flow.reqSize : flow.resSize) || Buffer.byteLength(String(text));
        return out;
      };

      const payload = {
        id: flow.id,
        time: new Date(flow.ts || Date.now()).toISOString(),
        method: flow.method,
        url: flow.url,
        status: flow.status,
        status_text: flow.statusText || '',
        http_version: flow.httpVersion || 'HTTP/1.1',
        duration_ms: flow.duration,
        app: flow.app || null,
        client_ip: flow.clientIp || null,
        mocked: Boolean(flow.mocked),
        matched_rule: flow.ruleId || flow.rule || null,
        error: flow.error || null,
        request: { headers: flow.reqHeaders || {}, size: flow.reqSize || 0 },
        response: {
          headers: flow.resHeaders || {},
          size: flow.resSize || 0,
          content_type: flow.resContentType || null,
        },
      };
      if (wantReq && mode !== 'none') Object.assign(payload.request, pick(flow.reqBody, flow.reqBodyBase64, true));
      if (wantRes && mode !== 'none') Object.assign(payload.response, pick(flow.resBody, flow.resBodyBase64, false));
      return payload;
    },
  },

  {
    name: 'list_rules',
    title: '列出 Mock 规则',
    description: '列出规则（可按文件夹过滤）：id、名称、方法、匹配串、匹配方式、返回状态、延迟、启用状态、所在文件。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        dir: S.str('只看某个文件夹（相对 data/rules，空串表示全部）'),
        only_enabled: S.bool('只看已启用的规则'),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const dir = optString(args, 'dir', 400);
      const onlyEnabled = optBool(args, 'only_enabled') === true;
      const all = ctx.server.rules.list();
      const rows = all
        .filter((r) => (dir === undefined || dir === '' ? true : String(r.dir || '') === dir))
        .filter((r) => (onlyEnabled ? r.enabled : true))
        .map((r) => ({
          id: r.id,
          name: r.name,
          dir: r.dir || '',
          file: r.file,
          enabled: r.enabled,
          method: r.method,
          url_match: r.urlMatch,
          match_mode: r.matchMode,
          status: r.status,
          delay_ms: r.delayMs,
          body_type: r.bodyType,
          note: r.note || '',
          has_body: Boolean(r.bodyFile || r.body),
        }));
      return { total: rows.length, rules: rows };
    },
  },

  {
    name: 'get_rule',
    title: '读取单条规则',
    description: '按 id 或文件路径读取一条规则的完整内容，含响应头与响应体（超长会截断）。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('规则 id'),
        path: S.str('规则文件相对路径，如 课程Mock/课程列表.rule.json'),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = optString(args, 'id', 100);
      const rel = optString(args, 'path', 400);
      if (!id && !rel) throw new ToolError('需要 id 或 path 之一');
      if (rel) {
        const file = ctx.server.rules.readFile(rel);
        if (!file) throw new ToolError(`找不到规则文件 ${rel}`);
        if (file.kind === 'rule') {
          /* readFile 给的是 { kind, rule }，统一摊平成「规则字段 + 正文」更好用 */
          const rule = file.rule || {};
          const body = typeof rule.body === 'string' ? clip(rule.body) : null;
          const flat = { ...rule };
          delete flat.body;
          return {
            kind: 'rule',
            path: rel,
            rule: flat,
            body: body ? body.text : '',
            body_truncated: Boolean(body && body.truncated),
          };
        }
        return { path: rel, ...file };
      }
      const rule = ctx.server.rules.list().find((r) => r.id === id);
      if (!rule) throw new ToolError(`找不到规则 ${id}`);
      const body = typeof rule.body === 'string' ? clip(rule.body) : null;
      return {
        ...rule,
        body: body ? body.text : '',
        body_truncated: body ? body.truncated : false,
      };
    },
  },

  {
    name: 'get_settings',
    title: '读取运行配置',
    description: '读取当前可调项：抓包开关、Mock 总开关、HTTP/2、解密端口、跳过解密白名单、UA 别名、弱网参数与规则、内存保留条数。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const c = ctx.server.config;
      return {
        capture: c.capture !== false,
        mock_enabled: c.mockEnabled !== false,
        h2_enabled: c.h2Enabled !== false,
        mitm_ports: c.mitmPorts || [443],
        passthrough: c.passthrough || [],
        ua_app_map: c.uaAppMap || [],
        process_map: c.processMap !== false,
        max_flows: ctx.server.store.maxFlows,
        auto_update: c.autoUpdate !== false,
        network_sim: normalizeNetworkSim(c.networkSim),
      };
    },
  },

  {
    name: 'create_rule',
    title: '新建 Mock 规则',
    description:
      '创建一条 Mock 规则：匹配 URL（contains / wildcard / regex）后直接返回指定状态码与响应体，不再打到上游。url_match 必填；method 默认 * 匹配所有方法。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        url_match: S.str('匹配串，如 /api/courses 或 example.com/api/*（按 match_mode 解释）'),
        method: S.str('HTTP 方法，默认 * 表示全部'),
        match_mode: S.str('匹配方式：contains（默认）/ wildcard / regex', {
          enum: ['contains', 'wildcard', 'regex'],
        }),
        name: S.str('规则名（同时是文件名，重名自动加序号）'),
        dir: S.str('放在哪个文件夹（相对 data/rules，可多级；不存在会自动建）'),
        status: S.int('返回状态码，默认 200', { minimum: 100, maximum: 599 }),
        delay_ms: S.int('响应延迟（毫秒）', { minimum: 0, maximum: 600000 }),
        headers: S.str('响应头：JSON 对象字符串，或每行 key: value'),
        body: S.str('响应体原文'),
        body_type: S.str('响应体类型：auto / json / plaintext / html / xml / javascript', {
          enum: ['auto', 'json', 'plaintext', 'html', 'xml', 'javascript'],
        }),
        note: S.str('备注'),
        enabled: S.bool('是否启用，默认 true'),
      },
      required: ['url_match'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const urlMatch = requireString(args, 'url_match', { max: 800 });
      const headers = parseHeadersArg(args.headers);
      const rule = ctx.server.rules.add({
        dir: optString(args, 'dir', 400) || '',
        name: optString(args, 'name', 200) || urlMatch,
        urlMatch,
        method: (optString(args, 'method', 20) || '*').toUpperCase(),
        matchMode: optString(args, 'match_mode', 20) || 'contains',
        status: optInt(args, 'status', { min: 100, max: 599 }),
        delayMs: optInt(args, 'delay_ms', { min: 0, max: 600000 }),
        headers,
        body: optString(args, 'body', 1024 * 512),
        bodyType: optString(args, 'body_type', 20),
        note: optString(args, 'note', 500),
        enabled: optBool(args, 'enabled'),
      });
      ctx.server._broadcast({ type: 'rules-changed' });
      return { ok: true, rule: publicRule(rule) };
    },
  },

  {
    name: 'mock_flow',
    title: '把一条真实请求变成 Mock',
    description:
      '用一条已抓到的请求/响应作为模板生成 Mock 规则：方法、路径、状态码、响应头与响应体都照搬，之后同路径的请求直接返回 mock。等同界面里的「Mock 此请求」。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: S.str('模板流量 id'),
        name: S.str('规则名'),
        dir: S.str('放在哪个文件夹'),
        status: S.str('覆盖返回状态码（默认沿用上游）'),
        delay_ms: S.int('响应延迟（毫秒）', { minimum: 0, maximum: 600000 }),
        url_match: S.str('自定义匹配串（默认 host + path，contains 匹配）'),
      },
      required: ['flow_id'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = requireString(args, 'flow_id', { max: 100 });
      const flow = ctx.server.store.get(id);
      if (!flow) throw new ToolError(`找不到流量 ${id}`);
      let url = flow.url || '';
      let host = flow.host || '';
      let pathName = flow.path || '';
      try {
        const u = new URL(flow.url);
        host = host || u.host;
        pathName = pathName || u.pathname + (u.search || '');
      } catch {
        /* 保留原始值 */
      }
      const match = optString(args, 'url_match', 800) || `${host}${pathName.split('?')[0]}`;
      const headers = {};
      for (const [k, v] of Object.entries(flow.resHeaders || {})) {
        const key = String(k).toLowerCase();
        /* 逐跳头 / 长度 / 压缩相关的不搬，交给代理重新生成 */
        if (['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(key)) continue;
        headers[key] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      const rule = ctx.server.rules.add({
        dir: optString(args, 'dir', 400) || '',
        name: optString(args, 'name', 200) || `${flow.method} ${pathName.split('?')[0]}`.slice(0, 120),
        urlMatch: match,
        method: String(flow.method || '*').toUpperCase(),
        matchMode: 'contains',
        status: optInt(args, 'status', { min: 100, max: 599 }) || Number(flow.status) || 200,
        delayMs: optInt(args, 'delay_ms', { min: 0, max: 600000 }),
        headers,
        body: flow.resBodyBase64 ? String(flow.resBodyBase64) : String(flow.resBody || ''),
        bodyBase64: Boolean(flow.resBodyBase64),
        bodyType: 'auto',
        note: `由流量 ${flow.id} 生成`,
      });
      ctx.server._broadcast({ type: 'rules-changed' });
      return { ok: true, rule: publicRule(rule), matched_by: match };
    },
  },

  {
    name: 'update_rule',
    title: '修改 Mock 规则',
    description: '按 id 修改规则字段（只传要改的）：名称、启用、方法、匹配串、匹配方式、状态码、延迟、响应头、响应体、备注。改名称会同步重命名文件。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('规则 id'),
        name: S.str('新名称'),
        enabled: S.bool('是否启用'),
        method: S.str('HTTP 方法'),
        url_match: S.str('匹配串'),
        match_mode: S.str('匹配方式', { enum: ['contains', 'wildcard', 'regex'] }),
        status: S.int('返回状态码', { minimum: 100, maximum: 599 }),
        delay_ms: S.int('响应延迟（毫秒）', { minimum: 0, maximum: 600000 }),
        headers: S.str('响应头（JSON 对象字符串或每行 key: value）'),
        body: S.str('响应体原文'),
        body_type: S.str('响应体类型', { enum: ['auto', 'json', 'plaintext', 'html', 'xml', 'javascript'] }),
        note: S.str('备注'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = requireString(args, 'id', { max: 100 });
      const patch = {};
      const pairs = [
        ['name', () => optString(args, 'name', 200)],
        ['enabled', () => optBool(args, 'enabled')],
        ['method', () => {
          const m = optString(args, 'method', 20);
          return m === undefined ? undefined : m.toUpperCase();
        }],
        ['urlMatch', () => optString(args, 'url_match', 800)],
        ['matchMode', () => optString(args, 'match_mode', 20)],
        ['status', () => optInt(args, 'status', { min: 100, max: 599 })],
        ['delayMs', () => optInt(args, 'delay_ms', { min: 0, max: 600000 })],
        ['headers', () => parseHeadersArg(args.headers)],
        ['body', () => optString(args, 'body', 1024 * 512)],
        ['bodyType', () => optString(args, 'body_type', 20)],
        ['note', () => optString(args, 'note', 500)],
      ];
      for (const [key, read] of pairs) {
        const v = read();
        if (v !== undefined) patch[key] = v;
      }
      if (!Object.keys(patch).length) throw new ToolError('没有要修改的字段');
      const updated = ctx.server.rules.update(id, patch);
      if (!updated) throw new ToolError(`找不到规则 ${id}`);
      ctx.server._broadcast({ type: 'rules-changed' });
      return { ok: true, rule: publicRule(updated) };
    },
  },

  {
    name: 'delete_rule',
    title: '删除 Mock 规则',
    description: '按 id 删除一条规则（连带响应体文件），或按 path 删除规则文件 / 整个文件夹。删除不可恢复。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('规则 id'),
        path: S.str('规则文件或文件夹的相对路径'),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = optString(args, 'id', 100);
      const rel = optString(args, 'path', 400);
      if (!id && !rel) throw new ToolError('需要 id 或 path 之一');
      if (rel) {
        const out = ctx.server.rules.deletePath(rel);
        ctx.server._broadcast({ type: 'rules-changed' });
        return { ok: Boolean(out && out.ok), path: rel };
      }
      const ok = ctx.server.rules.remove(id);
      if (!ok) throw new ToolError(`找不到规则 ${id}`);
      ctx.server._broadcast({ type: 'rules-changed' });
      return { ok: true, id };
    },
  },

  {
    name: 'clear_flows',
    title: '清空抓包列表',
    description: '清空内存中的流量列表（当天 JSONL 归档保留）。会同时清掉所有已打开控制台窗口的列表。',
    scope: 'write',
    destroy: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const before = ctx.server.store.flows.length;
      ctx.server.store.clear();
      return { ok: true, cleared: before };
    },
  },

  {
    name: 'replay_flow',
    title: '重放请求',
    description: '拿一条历史请求重新打到上游（可改 URL / 方法 / 头 / 体），结果作为一条新流量记录。重放不经过 Mock 规则。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('要重放的流量 id'),
        url: S.str('改成别的 URL'),
        method: S.str('改成别的方法'),
        headers: S.str('替换请求头（JSON 对象字符串或每行 key: value）'),
        body: S.str('替换请求体'),
        body_base64: S.bool('body 是 base64'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const id = requireString(args, 'id', { max: 100 });
      const flow = ctx.server.store.get(id);
      if (!flow) throw new ToolError(`找不到流量 ${id}`);
      const overrides = {};
      const url = optString(args, 'url', 2000);
      const method = optString(args, 'method', 20);
      const body = optString(args, 'body', 1024 * 512);
      if (url !== undefined) overrides.url = url;
      if (method !== undefined) overrides.method = method.toUpperCase();
      if (body !== undefined) overrides.body = body;
      if (optBool(args, 'body_base64') === true) overrides.bodyBase64 = true;
      const headers = parseHeadersArg(args.headers);
      if (headers) overrides.headers = headers;
      const out = await replay({ store: ctx.server.store, flow, overrides });
      if (out && out.error) throw new ToolError(out.error);
      const f = out.flow || {};
      return {
        ok: true,
        flow_id: f.id,
        status: f.status,
        duration_ms: f.duration,
        size: f.resSize,
        error: f.error || null,
      };
    },
  },

  {
    name: 'set_network_sim',
    title: '设置弱网 / 断网',
    description:
      '开启或调整网络模拟：全局弱网延迟与带宽、超时挂起时长，按「应用 / 域名 / IP」加断网规则（match 支持 * / app:名称 / host:域名 / ip:地址）。改动立即生效，会断开已受影响的存量连接。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('总开关'),
        latency_ms: S.int('弱网延迟（毫秒）', { minimum: 0, maximum: 60000 }),
        kbps: S.int('弱网带宽（KB/s）', { minimum: 1, maximum: 102400 }),
        timeout_ms: S.int('超时挂起（毫秒）', { minimum: 100, maximum: 600000 }),
        rules: {
          type: 'array',
          description: '断网 / 弱网规则，整体替换',
          items: {
            type: 'object',
            properties: {
              match: S.str('匹配串：* / app:名称 / host:域名 / ip:地址 / 裸串'),
              mode: S.str('offline（断网）/ weak（弱网）/ timeout（超时）', {
                enum: ['offline', 'weak', 'timeout'],
              }),
            },
            required: ['match'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const cur = normalizeNetworkSim(ctx.server.config.networkSim);
      const next = {
        enabled: optBool(args, 'enabled'),
        latencyMs: optInt(args, 'latency_ms', { min: 0, max: 60000 }),
        kbps: optInt(args, 'kbps', { min: 1, max: 102400 }),
        timeoutMs: optInt(args, 'timeout_ms', { min: 100, max: 600000 }),
        rules: Array.isArray(args.rules) ? args.rules : undefined,
      };
      const merged = {};
      for (const [k, v] of Object.entries(next)) if (v !== undefined) merged[k] = v;
      if (!Object.keys(merged).length) throw new ToolError('没有要修改的参数');
      const out = ctx.server.setNetworkSim({ ...cur, ...merged });
      return { ok: true, network_sim: out.sim, killed_connections: out.killed };
    },
  },

  {
    name: 'set_passthrough',
    title: '管理跳过解密的域名',
    description:
      '证书固定的 App 握手会失败，把域名加进白名单后 iReq 只做隧道透传、不尝试解密。action=list 查看；add / remove 增量修改；replace 全量替换。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        action: S.str('操作：list（默认）/ add / remove / replace', { enum: ['list', 'add', 'remove', 'replace'] }),
        domains: {
          type: 'array',
          description: '域名列表（add / remove / replace 时必填），如 ["pinned.example.com"]',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const action = optString(args, 'action', 20) || 'list';
      const cur = (ctx.server.config.passthrough || []).slice();
      const list = Array.isArray(args.domains)
        ? args.domains.map((d) => String(d || '').trim()).filter(Boolean)
        : [];
      if (action === 'list') return { ok: true, passthrough: cur };
      if (!list.length) throw new ToolError('domains 不能为空');
      let next = cur;
      if (action === 'add') next = [...cur, ...list];
      else if (action === 'remove') next = cur.filter((d) => !list.includes(d));
      else if (action === 'replace') next = list;
      else throw new ToolError(`未知 action：${action}`);
      const out = ctx.server._setPassthrough(next, 'mcp');
      return { ok: true, ...out, passthrough: out.passthrough };
    },
  },
];

function publicRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    dir: rule.dir || '',
    file: rule.file,
    enabled: rule.enabled,
    method: rule.method,
    url_match: rule.urlMatch,
    match_mode: rule.matchMode,
    status: rule.status,
    delay_ms: rule.delayMs,
    headers: rule.headers,
    note: rule.note || '',
    body_file: rule.bodyFile || null,
  };
}

/** headers 参数既接受 JSON 对象字符串，也接受每行 key: value */
function parseHeadersArg(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {
      throw new ToolError('headers 不是合法 JSON');
    }
    throw new ToolError('headers 必须是 JSON 对象');
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/* ---------------- 协议处理 ---------------- */

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** 按令牌 scope 过滤可见工具（只读令牌看不到写工具，避免误操作） */
function toolsFor(token) {
  return TOOLS.filter((t) => t.scope === 'read' || McpAuth.allows(token, 'write')).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: Boolean(t.readOnly),
      destructiveHint: Boolean(t.destroy),
      openWorldHint: t.name === 'replay_flow',
    },
  }));
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * 处理一条 JSON-RPC 消息。
 * 返回响应对象；通知（无 id）返回 null。
 */
async function handleMessage(msg, { server, token, auth, ip }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ireq', title: 'iReq', version: pkg.version },
        instructions:
          'iReq 是抓包 / Mock / 弱网工具。常用流程：ireq_status 看状态 → list_flows 找接口 → get_flow 读详情 → mock_flow 或 create_rule 造 Mock → set_network_sim 模拟弱网。修改类操作需要读写令牌。',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return null; /* 通知：不回包 */

    case 'ping':
      return isNotification ? null : rpcOk(id, {});

    case 'tools/list':
      return rpcOk(id, { tools: toolsFor(token) });

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = TOOL_INDEX.get(name);
      if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
      if (args && typeof args !== 'object') return rpcError(id, -32602, 'arguments 必须是对象');
      if (tool.scope === 'write' && !McpAuth.allows(token, 'write')) {
        return rpcError(id, -32003, '该令牌只有只读权限，不能执行写操作', {
          tool: name,
          required_scope: 'write',
        });
      }
      const started = Date.now();
      try {
        const out = await tool.run({ server, auth }, args || {});
        const text = JSON.stringify(out, null, 2);
        auth.record({ token, ip, method, tool: name, ok: true, ms: Date.now() - started });
        return rpcOk(id, {
          content: [{ type: 'text', text: text.length > 200000 ? text.slice(0, 200000) : text }],
          isError: false,
        });
      } catch (err) {
        const msgText = String((err && err.message) || err);
        auth.record({ token, ip, method, tool: name, ok: false, ms: Date.now() - started, error: msgText });
        /* 工具级失败按协议放在 result.isError 里，客户端才能把错误回灌给模型 */
        return rpcOk(id, {
          content: [{ type: 'text', text: `工具执行失败：${msgText}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/* ---------------- HTTP 传输 ---------------- */

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大（上限 1MB）'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, payload, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

/** 只放行本机 / 无 Origin 的请求，防 DNS rebinding 借浏览器打本地端口 */
function originAllowed(origin) {
  if (!origin) return true;
  const o = String(origin).toLowerCase();
  if (o === 'null' || o.startsWith('file://') || o.startsWith('app://')) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o);
}

function clientIp(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return String(a).replace(/^::ffff:/, '');
}

/**
 * 把 /mcp 请求接进 JSON-RPC。
 * 状态码约定：403 未开启 / Origin 不允许；401 缺令牌或令牌无效；429 限流；405 方法不对。
 */
async function handleHttp(req, res, { server, auth }) {
  const ip = clientIp(req);
  if (req.method === 'GET' || req.method === 'DELETE') {
    /* 无服务端主动推送的 SSE 流，也没有会话可删；按规范回 405 并告知允许的方法 */
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'MCP 端点只接受 POST' }));
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  if (!originAllowed(req.headers.origin)) {
    return sendJson(res, 403, { error: 'Origin 不被允许：MCP 只接受本机客户端' });
  }
  if (!auth.enabled) {
    return sendJson(res, 403, {
      error: 'MCP 未开启：请先在 iReq 控制台「设置 › MCP 接入」里打开并生成令牌',
      code: 'mcp_disabled',
    });
  }

  const headerToken = req.headers.authorization || req.headers['x-ireq-token'] || '';
  const verdict = auth.verify(headerToken, { ip });
  if (!verdict.ok) {
    if (verdict.reason === 'rate' && verdict.token) {
      auth.record({ token: verdict.token, ip, method: 'POST', tool: '', ok: false, error: 'rate limited' });
      return sendJson(res, 429, { error: '调用过于频繁，请稍后再试' }, { 'retry-after': '60' });
    }
    const why = verdict.reason === 'missing' ? '缺少访问令牌' : '访问令牌无效或已撤销';
    auth.record({ token: null, ip, method: 'POST', tool: '', ok: false, error: verdict.reason });
    return sendJson(
      res,
      401,
      { error: why, code: verdict.reason === 'missing' ? 'token_missing' : 'token_invalid' },
      {
        'www-authenticate': 'Bearer realm="iReq MCP", error="invalid_token"',
      }
    );
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err && err.code === 413) return sendJson(res, 413, { error: err.message });
    return sendJson(res, 400, { error: String((err && err.message) || err) });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    auth.record({ token: verdict.token, ip, method: 'POST', tool: '', ok: false, error: 'parse error' });
    return sendJson(res, 200, rpcError(null, -32700, 'Parse error'));
  }

  const batch = Array.isArray(parsed);
  const messages = batch ? parsed : [parsed];
  if (!messages.length) return sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));

  const out = [];
  for (const message of messages) {
    const started = Date.now();
    const isCall = message && message.method === 'tools/call';
    let response;
    try {
      response = await handleMessage(message, {
        server,
        token: verdict.token,
        auth,
        ip,
      });
    } catch (err) {
      response = rpcError(message && message.id, -32603, String((err && err.message) || err));
    }
    /* tools/call 的审计在 handleMessage 里记（带工具名）；其余方法在这里补一条 */
    if (!isCall && response) {
      auth.record({
        token: verdict.token,
        ip,
        method: (message && message.method) || '',
        tool: '',
        ok: !response.error,
        ms: Date.now() - started,
        error: response.error ? response.error.message : '',
      });
    }
    if (response) out.push(response);
  }

  if (!out.length) {
    /* 全是通知：按 Streamable HTTP 规范回 202、无正文 */
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  return sendJson(res, 200, batch ? out : out[0]);
}

module.exports = {
  TOOLS,
  PROTOCOL_VERSIONS,
  LATEST_PROTOCOL,
  handleHttp,
  handleMessage,
  toolsFor,
  originAllowed,
};
