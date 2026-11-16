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
const { redactFlow, redactFlows, normalize: normalizeRedact } = require('./redact');
const { normalizeScripts } = require('./scripts');
const { normalizeColumns, applyColumns } = require('./columns');
const { aggregate: aggregatePerf } = require('./perf');
const { COLORS: ANNOT_COLORS } = require('./annotations');

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
      '按域名 / 应用 / 设备 / 接口 / 方法 / 状态码 / 关键词 / 时间窗筛选最近的请求，返回精简列表（含 id、URL、状态、耗时、应用）。' +
      '返回 total（匹配总数）与 returned（本次返回条数），has_more=true 说明还有更多，可缩小条件或翻 limit。' +
      '不知道该查哪个域名时先调 list_hosts 看聚合。状态码支持 2xx / 404 / error / json 等写法。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: S.str('关键词，匹配 URL / 应用名 / IP / 设备 / 进程名'),
        method: S.str('HTTP 方法，如 GET / POST'),
        status: S.str('状态码筛选：2xx / 4xx / 500 / ok / error / json（内容类型）'),
        host: S.str('域名精确匹配，如 api.example.com'),
        app: S.str('应用名（可逗号分隔多个）'),
        ip: S.str('客户端 IP 精确匹配；传 local 表示本机'),
        route: S.str('接口路径，如 GET /api/user（取自 list_hosts 的 routes）'),
        since_seconds: S.int('只看最近 N 秒内产生的请求；0 表示不限', { minimum: 0, maximum: 86400 }),
        only_mocked: S.bool('只看被 Mock 命中的请求'),
        limit: S.int('返回条数，默认 50，最大 200', { minimum: 1, maximum: 200 }),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const limit = optInt(args, 'limit', { min: 1, max: 200 }) || 50;
      const sinceSec = optInt(args, 'since_seconds', { min: 0, max: 86400 });
      const opts = {
        query: optString(args, 'query', 200) || '',
        method: optString(args, 'method', 20) || '',
        status: optString(args, 'status', 40) || '',
        host: optString(args, 'host', 200) || '',
        app: optString(args, 'app', 200) || '',
        ip: optString(args, 'ip', 100) || '',
        route: optString(args, 'route', 200) || '',
        since: sinceSec ? Date.now() - sinceSec * 1000 : 0,
        onlyMocked: optBool(args, 'only_mocked') === true,
      };
      /* 列表按 limit 截断，但要让调用方知道「筛完到底有多少条」 */
      const total = ctx.server.store.count(opts);
      const raw = ctx.server.store.list({ ...opts, limit });
      // 给模型的 URL 里也不能带 token：脱敏开关开着就按导出那套规则处理
      const annotated = ctx.server.annotations ? ctx.server.annotations.applyAll(raw) : raw;
      const red = redactFlows(annotated, ctx.server.config.redact, ctx.server.config.derivedColumns);
      const flows = red.flows;
      return {
        total,
        returned: flows.length,
        has_more: total > flows.length,
        redacted: red.count,
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
          ...(f.note ? { note: f.note } : {}),
          ...(f.pinned ? { pinned: true } : {}),
        })),
      };
    },
  },

  {
    name: 'list_hosts',
    title: '列出抓到的域名 / 应用 / 设备',
    description:
      '把当前抓包的域名、应用、设备、接口聚合出来（带条数，从多到少）。' +
      '流量很多时先调它看清全局，再把挑中的 host / app / ip / route 传给 list_flows 精确查。' +
      'hosts 与 routes 受 app / ip / since_seconds 收窄；apps 与 devices 始终是全量。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        app: S.str('只在这个应用范围内聚合域名与接口'),
        ip: S.str('只在这个客户端 IP 范围内聚合；local 表示本机'),
        since_seconds: S.int('只统计最近 N 秒内的流量；0 表示不限', { minimum: 0, maximum: 86400 }),
        limit: S.int('每类返回条数，默认 20，最大 100', { minimum: 1, maximum: 100 }),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const limit = optInt(args, 'limit', { min: 1, max: 100 }) || 20;
      const app = optString(args, 'app', 200);
      const ip = optString(args, 'ip', 100);
      const sinceSec = optInt(args, 'since_seconds', { min: 0, max: 86400 });
      const base = {};
      if (app) base.app = app;
      if (ip) base.ip = ip;
      if (sinceSec) base.since = Date.now() - sinceSec * 1000;
      const scoped = Object.keys(base).length > 0;
      const facets = ctx.server.store.facets(limit, scoped ? { hosts: base, routes: base } : null);
      return {
        total_flows: ctx.server.store.stats().total,
        scoped,
        hosts: facets.hosts,
        apps: facets.apps,
        devices: facets.devices,
        routes: (facets.routes || []).slice(0, limit),
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
      const stored = ctx.server.store.get(id);
      if (!stored) throw new ToolError(`找不到流量 ${id}（可能已被清空）`);
      const raw = ctx.server.annotations ? ctx.server.annotations.apply(stored) : stored;
      // 模型看到的内容按脱敏配置过滤；界面照旧显示原值，两边互不影响
      const flow = redactFlow(raw, ctx.server.config.redact, ctx.server.config.derivedColumns);
      const redactions = flow._redactions || 0;
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
        ...(flow.note ? { note: flow.note } : {}),
        ...(flow.color ? { color: flow.color } : {}),
        ...(flow.pinned ? { pinned: true } : {}),
        request: { headers: flow.reqHeaders || {}, size: flow.reqSize || 0 },
        response: {
          headers: flow.resHeaders || {},
          size: flow.resSize || 0,
          content_type: flow.resContentType || null,
        },
      };
      if (wantReq && mode !== 'none') Object.assign(payload.request, pick(flow.reqBody, flow.reqBodyBase64, true));
      if (wantRes && mode !== 'none') Object.assign(payload.response, pick(flow.resBody, flow.resBodyBase64, false));
      if (redactions) {
        payload.redacted = redactions;
        payload.redacted_note = `已按脱敏规则打码 ${redactions} 处（凭据类头部 / 查询参数 / 正文字段），原值只在本机控制台可见`;
      }
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

  /* ============================ 之后加的模块（断点 / 脚本 / 告警 / 映射 / 脱敏 / 派生列 / 标注 / 性能） */

  {
    name: 'list_breakpoints',
    title: '查看断点规则',
    description:
      '断点会在请求或响应阶段把连接挂住、等人改完再放行（超时自动放行）。这里返回开关、超时时间、规则列表，以及当前正挂着的请求。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const bp = ctx.server.breakpoints;
      if (!bp) throw new ToolError('断点模块未启用');
      const st = bp.state();
      return {
        enabled: st.enabled,
        timeout_ms: st.timeoutMs,
        rules: st.rules,
        pending: st.pending.map((r) => ({
          id: r.id,
          phase: r.phase,
          method: r.method,
          url: r.url,
          rule: r.rule || '',
          started_at: r.startedAt || null,
        })),
      };
    },
  },

  {
    name: 'set_breakpoints',
    title: '设置断点规则',
    description:
      '整体替换断点规则（不传 match 就沿用现有规则，只改开关 / 超时）。点开后命中的请求会挂起，用 update_breakpoint 放行或改包。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('是否开启断点'),
        timeout_ms: S.int('挂起后自动放行时间（毫秒，1000–600000）', { min: 1000, max: 600000 }),
        match: {
          type: 'array',
          description: '规则列表；每条按 URL 包含匹配（* 通配，空串=全部）',
          items: {
            type: 'object',
            properties: {
              match: S.str('URL 包含这段文字（* 通配，空串=全部请求）'),
              method: S.str('只拦这个方法，空=全部'),
              phase: S.str('拦哪个阶段', { enum: ['request', 'response', 'both'] }),
            },
            required: ['match'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const bp = ctx.server.breakpoints;
      if (!bp) throw new ToolError('断点模块未启用');
      if (args.timeout_ms != null) bp.setTimeoutMs(args.timeout_ms);
      const rules = Array.isArray(args.match)
        ? args.match.map((r) => ({
            match: String((r && r.match) || ''),
            method: String((r && r.method) || '').toUpperCase(),
            phase: ['request', 'response', 'both'].includes(r && r.phase) ? r.phase : 'both',
          }))
        : bp.state().rules;
      const out = bp.setRules(rules, optBool(args, 'enabled'));
      ctx.server._broadcast({
        type: 'breakpoints',
        state: { enabled: out.enabled, rules: out.rules, pending: out.pending.length, timeoutMs: out.timeoutMs },
      });
      return { ok: true, enabled: out.enabled, timeout_ms: out.timeoutMs, rules: out.rules, pending: out.pending.length };
    },
  },

  {
    name: 'list_scripts',
    title: '查看脚本规则',
    description:
      '脚本规则用沙箱里的 onRequest / onResponse 钩子改请求或响应（无网络、无文件、单次 50ms）。返回开关和每条规则的匹配条件与代码。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const engine = ctx.server.proxy && ctx.server.proxy.scripts;
      if (!engine) throw new ToolError('脚本模块未启用');
      const st = engine.settings();
      return {
        enabled: st.enabled,
        rules: st.rules.map((r) => ({
          id: r.id,
          name: r.name,
          phase: r.phase,
          enabled: r.enabled !== false,
          method: r.method || '',
          host: r.host || '',
          url: r.url || '',
          code: r.code,
        })),
      };
    },
  },

  {
    name: 'save_scripts',
    title: '保存脚本规则',
    description:
      '整体替换脚本规则（含开关）。保存前会逐条编译，语法错或死循环直接报错、不落盘。代码只能用 onRequest(req) / onResponse(res)。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('总开关'),
        rules: {
          type: 'array',
          description: '规则列表（不传则沿用现有规则）',
          items: {
            type: 'object',
            properties: {
              id: S.str('规则 id（改已有规则时带上，新规则可省）'),
              name: S.str('规则名'),
              phase: S.str('执行阶段', { enum: ['request', 'response', 'both', 'ws'] }),
              enabled: S.bool('这条是否启用'),
              method: S.str('只匹配这个方法，空=全部'),
              host: S.str('域名（可空，* 通配）'),
              url: S.str('URL 包含（可空）'),
              code: S.str('脚本代码，例如 onResponse(res => { res.headers["x-debug"] = "1"; })'),
            },
            required: ['name', 'code'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const engine = ctx.server.proxy && ctx.server.proxy.scripts;
      if (!engine) throw new ToolError('脚本模块未启用');
      const cur = engine.settings();
      const next = normalizeScripts({
        enabled: args.enabled !== undefined ? args.enabled === true : cur.enabled,
        rules: Array.isArray(args.rules) ? args.rules : cur.rules,
      });
      const errors = [];
      for (const rule of next.rules) {
        const c = engine.compile(rule.code, rule.timeoutMs);
        if (!c.ok) errors.push({ name: rule.name, error: c.error });
      }
      if (errors.length) throw new ToolError('脚本有错，未保存：' + errors.map((e) => `${e.name} → ${e.error}`).join('；'));
      engine.set(next);
      if (ctx.server.dataDir) ctx.server._persistConfig();
      ctx.server._broadcast({ type: 'scripts-changed', scripts: next });
      return { ok: true, enabled: next.enabled, rules: next.rules.length };
    },
  },

  {
    name: 'list_alerts',
    title: '查看条件告警',
    description: '告警规则按「且」组合匹配状态码 / 域名 / URL / 正文 / 耗时，命中后推给窗口。返回规则、开关、静音状态与限速。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const engine = ctx.server.proxy && ctx.server.proxy.alerts;
      if (!engine) throw new ToolError('告警模块未启用');
      return engine.status();
    },
  },

  {
    name: 'set_alerts',
    title: '设置条件告警',
    description: '整体替换告警规则（不传 rules 就沿用现有规则，只改开关）。每条规则自带冷却，全局每分钟最多 20 条。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('是否开启告警'),
        rules: {
          type: 'array',
          description: '规则列表（不传则沿用现有规则）',
          items: {
            type: 'object',
            properties: {
              id: S.str('规则 id（改已有规则时带上）'),
              name: S.str('规则名'),
              enabled: S.bool('这条是否启用'),
              status: S.str('状态码条件，如 5xx / 4xx / 200（可空）'),
              host: S.str('域名包含（可空）'),
              url: S.str('URL 包含（可空）'),
              body: S.str('响应体包含（可空）'),
              min_ms: S.int('耗时下限（毫秒，可空）', { min: 0 }),
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const engine = ctx.server.proxy && ctx.server.proxy.alerts;
      if (!engine) throw new ToolError('告警模块未启用');
      const cur = engine.settings();
      const saved = engine.set({
        enabled: args.enabled !== undefined ? args.enabled === true : cur.enabled,
        rules: Array.isArray(args.rules) ? args.rules : cur.rules,
      });
      if (ctx.server.dataDir) ctx.server._persistConfig();
      ctx.server._broadcast({ type: 'alerts-changed', alerts: saved });
      const st = engine.status();
      return { ok: true, enabled: st.enabled, rules: (st.rules || []).length };
    },
  },

  {
    name: 'get_hostmap',
    title: '查看域名映射',
    description: '域名映射只改「连哪台机器」：URL、Host 头、证书仍是原域名。返回开关与规则（from → to）。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const hm = ctx.server.hostmap;
      if (!hm) throw new ToolError('域名映射未启用');
      return hm.state();
    },
  },

  {
    name: 'set_hostmap',
    title: '设置域名映射',
    description: '整体替换映射规则。from 可写 * 通配、可带路径前缀；to 是 host:port 或完整 URL。改完立刻生效并落盘。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('是否开启映射'),
        rules: {
          type: 'array',
          description: '规则列表（不传则沿用现有规则）',
          items: {
            type: 'object',
            properties: {
              from: S.str('原域名，可含 * 与路径前缀，如 api.example.com/v2'),
              to: S.str('目标，如 127.0.0.1:8080 或 http://host:port'),
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const hm = ctx.server.hostmap;
      if (!hm) throw new ToolError('域名映射未启用');
      const cur = hm.state();
      const out = hm.setState({
        enabled: args.enabled !== undefined ? args.enabled === true : undefined,
        rules: Array.isArray(args.rules) ? args.rules : cur.rules,
      });
      ctx.server.config.hostMap = out;
      if (ctx.server.dataDir) ctx.server._persistConfig();
      ctx.server._broadcast({ type: 'hostmap', state: out });
      return { ok: true, enabled: out.enabled, rules: out.rules };
    },
  },

  {
    name: 'get_redact',
    title: '查看脱敏配置',
    description:
      '脱敏只作用于导出文件、MCP 输出和带 redact=1 的接口，界面永远显示原值。返回开关、四类开关与生效的头 / 字段 / 查询参数清单。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      return ctx.server._redactView();
    },
  },

  {
    name: 'set_redact',
    title: '设置脱敏',
    description: '改脱敏开关（不传的字段保持原值）。extra_headers / extra_fields 是追加的自定义清单，空数组表示清空。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: S.bool('总开关'),
        headers: S.bool('打码凭据类请求头 / 响应头'),
        query: S.bool('打码 URL 里的凭据参数'),
        body: S.bool('打码正文里的凭据字段'),
        pii: S.bool('连手机号 / 身份证 / 邮箱一起打码'),
        extra_headers: { type: 'array', items: { type: 'string' }, description: '追加要打码的头名' },
        extra_fields: { type: 'array', items: { type: 'string' }, description: '追加要打码的正文 / 查询字段名' },
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const cur = normalizeRedact(ctx.server.config.redact);
      const pick = (k, dflt) => (args[k] === undefined ? dflt : args[k] === true);
      ctx.server.config.redact = normalizeRedact({
        enabled: pick('enabled', cur.enabled),
        headers: pick('headers', cur.headers),
        query: pick('query', cur.query),
        body: pick('body', cur.body),
        pii: pick('pii', cur.pii),
        extraHeaders: Array.isArray(args.extra_headers) ? args.extra_headers : cur.extraHeaders,
        extraFields: Array.isArray(args.extra_fields) ? args.extra_fields : cur.extraFields,
      });
      if (ctx.server.dataDir) ctx.server._persistConfig();
      ctx.server._broadcast({ type: 'redact-changed', redact: ctx.server.config.redact });
      const view = ctx.server._redactView();
      return { ok: true, enabled: view.enabled, headers: view.headers, query: view.query, body: view.body, pii: view.pii };
    },
  },

  {
    name: 'get_columns',
    title: '查看派生列',
    description: '派生列把响应 JSON 字段 / 响应头提成列表里的一列（最多 4 列）。返回当前配置。',
    scope: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      return { columns: ctx.server.config.derivedColumns || [] };
    },
  },

  {
    name: 'set_columns',
    title: '设置派生列',
    description: '整体替换派生列，改完立刻对已有流量重算。path 支持 data.items[0].id，前缀 req. 表示取请求侧。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          description: '列定义（最多 4 条），空数组=清空',
          items: {
            type: 'object',
            properties: {
              id: S.str('列 id（可省，会自动生成）'),
              name: S.str('表头名'),
              source: S.str('取哪一侧', { enum: ['res', 'req', 'header'] }),
              path: S.str('字段路径，如 data.items[0].id'),
            },
            required: ['name', 'path'],
            additionalProperties: false,
          },
        },
      },
      required: ['columns'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const columns = normalizeColumns(args.columns);
      ctx.server.config.derivedColumns = columns;
      for (const f of ctx.server.store.flows) {
        const d = applyColumns(f, columns);
        if (d) f.derived = d;
        else delete f.derived;
      }
      if (ctx.server.dataDir) ctx.server._persistConfig();
      ctx.server._broadcast({ type: 'columns-changed', columns });
      return { ok: true, columns };
    },
  },

  {
    name: 'annotate_flow',
    title: '标注一条请求',
    description:
      '给某条请求加备注 / 颜色 / 重点标记（合并语义：只改传进来的字段，三个都空等于清掉）。标注跟着导出和报告一起走。',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: S.str('请求 id'),
        note: S.str('备注（最多 200 字，空串=清空）'),
        color: S.str('颜色名', { enum: ['', ...ANNOT_COLORS] }),
        pinned: S.bool('是否标为重点'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    run(ctx, args) {
      const id = String(args.id || '');
      if (!id) throw new ToolError('id 不能为空');
      if (!ctx.server.store.get(id) && !ctx.server.annotations.get(id)) throw new ToolError('flow 不存在');
      const saved = ctx.server.annotations.set(id, {
        note: args.note,
        color: args.color === undefined ? undefined : String(args.color || ''),
        pinned: args.pinned === undefined ? undefined : args.pinned === true,
      });
      ctx.server._broadcast({ type: 'annotation', id, annotation: saved });
      return { ok: true, id, annotation: saved };
    },
  },

  {
    name: 'perf_summary',
    title: '按接口看性能',
    description:
      '把当前流量按接口（或域名）聚合：P50 / P95 / 平均 / 最大 / 错误率 / 传输量，外加最慢的几条。定位「哪个接口慢」时先调这个。',
    scope: 'read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        by: S.str('聚合维度', { enum: ['route', 'host'] }),
        q: S.str('只看 URL 含这段文字的'),
        host: S.str('只看这个域名'),
        app: S.str('只看这个应用'),
        status: S.str('状态段，如 5xx'),
        limit: S.int('最多看多少条流量（默认 2000）', { min: 1, max: 5000 }),
        groups: S.int('返回多少个分组（默认 20）', { min: 1, max: 200 }),
        slowest: S.int('最慢请求返回几条（默认 5）', { min: 0, max: 20 }),
      },
      additionalProperties: false,
    },
    run(ctx, args) {
      const flows = ctx.server.store.list({
        query: optString(args, 'q', 200) || '',
        host: optString(args, 'host', 200) || '',
        app: optString(args, 'app', 100) || '',
        status: optString(args, 'status', 20) || '',
        limit: optInt(args, 'limit', { min: 1, max: 5000 }) || 2000,
      });
      const out = aggregatePerf(flows, {
        by: args.by === 'host' ? 'host' : 'route',
        limit: optInt(args, 'groups', { min: 1, max: 200 }) || 20,
        slowest: optInt(args, 'slowest', { min: 0, max: 20 }),
      });
      return { ...out, in_memory: ctx.server.store.flows.length };
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
          'iReq 是抓包 / Mock / 弱网工具。常用流程：ireq_status 看状态 → list_hosts 看有哪些域名 / 应用 → ' +
            'list_flows 按 host / app / route / since_seconds 筛出接口 → get_flow 读详情 → ' +
            'mock_flow 或 create_rule 造 Mock → set_network_sim 模拟弱网。修改类操作需要读写令牌。',
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
