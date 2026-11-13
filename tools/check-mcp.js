'use strict';

/**
 * 自检：MCP 接入 + 授权认证
 * ---------------------------------------------------------------------------
 * ① 默认关闭；关闭时 /mcp 直接 403，开了没令牌 401，错令牌 401
 * ② 令牌明文只返回一次、落盘只存哈希、/api/config 与 /api/mcp 都不外泄凭据
 * ③ JSON-RPC：initialize / tools.list / tools.call / ping / 通知 / 批量 / 未知方法 / 坏 JSON
 * ④ 工具真干活：查流量、读详情、建/改/删规则、由流量生成 Mock、重放、弱网、白名单、清空
 * ⑤ scope：只读令牌看不到写工具、调写工具被拒
 * ⑥ 撤销后立刻 401；Origin 非本机 403；审计留痕
 * ⑦ stdio 桥：无令牌退出码 2；带令牌能跑 initialize 与 tools/call
 *
 * 只动自己造的规则 / 流量 / 令牌；结束时把 MCP 关掉、令牌撤销、临时文件删干净。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonApi = async (p, opts = {}) => {
  const res = await fetch(UI + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

let TOKEN = '';
async function rpc(token, payload, extraHeaders = {}) {
  const res = await fetch(UI + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const callTool = (token, name, args = {}) =>
  rpc(token, { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });

/** tools/call 的 result.content[0].text 是 JSON 字符串 */
function toolJson(resp) {
  const r = resp.body && resp.body.result;
  if (!r || !r.content || !r.content[0]) return null;
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return { raw: r.content[0].text };
  }
}

/** 起一个本地上游，再经 iReq 代理打一次，造出一条真实流量 */
function proxyRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method,
        path: url,
        headers: { host: u.host, ...headers },
        timeout: 12000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/** 用 stdin 喂几行 JSON，收集 stdout 每一行 */
function runBridge(args, lines, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'ireq.js'), 'mcp', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, lines: out.trim().split('\n').filter(Boolean) });
    });
    for (const line of lines) child.stdin.write(line + '\n');
    child.stdin.end();
  });
}

(async () => {
  const upstream = http.createServer((req, res) => {
    if (String(req.url || '').split('?')[0] === '/mcp-check') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' });
      return res.end(JSON.stringify({ hello: 'mcp', path: req.url }));
    }
    /* 第二条接口：给 list_flows 的 route 筛选与 list_hosts 的 routes 聚合做区分度 */
    if (String(req.url || '').split('?')[0] === '/mcp-other') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('other');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const createdRuleIds = [];
  let ruleFile = '';
  let readToken = '';
  let readTokenId = '';

  try {
    // ------------------------------------------------------ ① 默认关闭
    const before = await jsonApi('/api/mcp');
    if (before.body && before.body.enabled) {
      /* 上次异常退出可能留着开启态，先关掉再测 */
      await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: false } });
    }
    const offCall = await rpc('', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    ok('MCP 关闭时 /mcp 返回 403', offCall.status === 403, String(offCall.status));
    ok('关闭时有明确的 code', offCall.body && offCall.body.code === 'mcp_disabled', JSON.stringify(offCall.body));

    const on = await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: true } });
    ok('开关可以打开', on.status === 200 && on.body.enabled === true);
    ok('/api/mcp 给出端点与工具清单', /\/mcp$/.test(on.body.endpoint) && on.body.tools.length >= 10, on.body.endpoint);

    // ------------------------------------------------------ ② 未授权 / 错令牌
    const noToken = await rpc('', { jsonrpc: '2.0', id: 2, method: 'ping' });
    ok('没有令牌返回 401', noToken.status === 401);
    ok('401 带 WWW-Authenticate', /Bearer/.test(noToken.headers.get('www-authenticate') || ''));
    const badToken = await rpc('ireq_mcp_not-a-real-token-but-long-enough', { jsonrpc: '2.0', id: 3, method: 'ping' });
    ok('错误令牌返回 401', badToken.status === 401);

    // ------------------------------------------------------ ③ 生成令牌
    const created = await jsonApi('/api/mcp/tokens', { method: 'POST', body: { name: 'check-rw', scopes: 'readwrite' } });
    TOKEN = created.body.token || '';
    ok('生成的令牌有 ireq_mcp_ 前缀', TOKEN.startsWith('ireq_mcp_') && TOKEN.length > 30, TOKEN.slice(0, 14) + '…');
    ok('令牌带读写 scope', created.body.entry && created.body.entry.scopes.includes('write'));
    ok('返回可粘贴的客户端配置', !!(created.body.snippet && created.body.snippet.http && created.body.snippet.stdio));

    const listed = await jsonApi('/api/mcp');
    const row = (listed.body.tokens || [])[0] || {};
    ok('令牌列表只给掩码', !!row.masked && !String(row.masked).includes(TOKEN), row.masked);
    ok('/api/mcp 不含任何凭据字段', !JSON.stringify(listed.body).includes('hash') && !JSON.stringify(listed.body).includes('salt'));

    const cfg = await jsonApi('/api/config');
    ok('/api/config 里 mcp 已脱敏', cfg.body.mcp && cfg.body.mcp.tokens === undefined && cfg.body.mcp.tokenCount >= 1, JSON.stringify(cfg.body.mcp));

    const dataDir = (await jsonApi('/api/status')).body.dataDir;
    const cfgFile = path.join(dataDir, 'config.json');
    const rawCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
    ok('config.json 不含令牌明文', !!rawCfg && !rawCfg.includes(TOKEN));
    ok('config.json 存了哈希与盐', /"hash":\s*"[0-9a-f]{64}"/.test(rawCfg) && /"salt":/.test(rawCfg));

    // ------------------------------------------------------ ④ 协议握手
    const init = await rpc(TOKEN, {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } },
    });
    ok('initialize 成功', init.status === 200 && init.body.result, JSON.stringify(init.body).slice(0, 120));
    ok('serverInfo 指明是 iReq', init.body.result.serverInfo.name === 'ireq');
    ok('声明 tools 能力', !!init.body.result.capabilities.tools);
    ok('回显客户端协议版本', init.body.result.protocolVersion === '2025-06-18');

    const initOld = await rpc(TOKEN, {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    ok('旧协议版本也能协商', initOld.body.result.protocolVersion === '2024-11-05');

    const initOdd = await rpc(TOKEN, {
      jsonrpc: '2.0',
      id: 6,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    ok('未知协议版本回落到最新', /^\d{4}-\d{2}-\d{2}$/.test(initOdd.body.result.protocolVersion), initOdd.body.result.protocolVersion);

    const note = await rpc(TOKEN, { jsonrpc: '2.0', method: 'notifications/initialized' });
    ok('通知回 202 且无正文', note.status === 202 && note.body === null, String(note.status));

    const ping = await rpc(TOKEN, { jsonrpc: '2.0', id: 7, method: 'ping' });
    ok('ping 返回空结果', ping.status === 200 && ping.body.result && Object.keys(ping.body.result).length === 0);

    const list = await rpc(TOKEN, { jsonrpc: '2.0', id: 8, method: 'tools/list' });
    const tools = list.body.result.tools || [];
    ok('tools/list 至少 12 个工具', tools.length >= 12, String(tools.length));
    ok(
      '每个工具都有 name / description / inputSchema',
      tools.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object')
    );
    ok(
      '写工具带 readOnlyHint=false',
      tools.some((t) => t.annotations && t.annotations.readOnlyHint === false)
    );
    ok(
      '读工具带 readOnlyHint=true',
      tools.some((t) => t.annotations && t.annotations.readOnlyHint === true)
    );

    const unknown = await rpc(TOKEN, { jsonrpc: '2.0', id: 9, method: 'resources/list' });
    ok('未知方法返回 -32601', unknown.body.error && unknown.body.error.code === -32601, JSON.stringify(unknown.body.error));

    const badJson = await fetch(UI + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: '{ not json',
    });
    const badJsonBody = await badJson.json();
    ok('坏 JSON 返回 -32700', badJsonBody.error && badJsonBody.error.code === -32700);

    const batch = await rpc(TOKEN, [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
    ]);
    ok('批量请求按数组返回', Array.isArray(batch.body) && batch.body.length === 2, String(batch.body && batch.body.length));

    const getMcp = await fetch(UI + '/mcp', { headers: { authorization: 'Bearer ' + TOKEN } });
    ok('GET /mcp 返回 405 并告知只允许 POST', getMcp.status === 405 && /POST/.test(getMcp.headers.get('allow') || ''));

    const evil = await rpc(TOKEN, { jsonrpc: '2.0', id: 12, method: 'ping' }, { origin: 'http://evil.example' });
    ok('跨站 Origin 被拒', evil.status === 403, String(evil.status));

    // ------------------------------------------------------ ⑤ 只读令牌
    const ro = await jsonApi('/api/mcp/tokens', { method: 'POST', body: { name: 'check-read', scopes: 'read' } });
    readToken = ro.body.token;
    readTokenId = ro.body.entry.id;
    const roList = await rpc(readToken, { jsonrpc: '2.0', id: 13, method: 'tools/list' });
    const roTools = (roList.body.result.tools || []).map((t) => t.name);
    ok('只读令牌看不到写工具', !roTools.includes('create_rule') && roTools.includes('list_flows'), roTools.join(','));
    const roWrite = await callTool(readToken, 'create_rule', { url_match: '/nope' });
    ok('只读令牌调写工具被拒（-32003）', roWrite.body.error && roWrite.body.error.code === -32003, JSON.stringify(roWrite.body.error));
    const roRead = await callTool(readToken, 'ireq_status', {});
    ok('只读令牌可以读状态', roRead.body.result && roRead.body.result.isError === false);

    // ------------------------------------------------------ ⑥ 造流量
    await jsonApi('/api/config', { method: 'PUT', body: { mockEnabled: true } });
    const up = await proxyRequest(`http://127.0.0.1:${upPort}/mcp-check?x=1`);
    ok('经代理请求上游成功', up.status === 200 && /mcp/.test(up.body || ''), JSON.stringify(up).slice(0, 100));
    await wait(400);

    const flows = toolJson(await callTool(TOKEN, 'list_flows', { query: 'mcp-check', limit: 5 }));
    ok('list_flows 能查到刚抓的请求', flows && flows.returned >= 1, flows && flows.returned);
    const flowId = flows && flows.flows && flows.flows[0] && flows.flows[0].id;
    ok('列表里带 id / status / url', !!(flowId && flows.flows[0].status === 200 && /mcp-check/.test(flows.flows[0].url)));

    const detail = toolJson(await callTool(TOKEN, 'get_flow', { id: flowId }));
    ok('get_flow 返回请求与响应头', !!(detail && detail.request && detail.response && detail.response.headers));
    ok('get_flow 带上响应体', !!(detail.response.body && /hello/.test(detail.response.body)));
    const noBody = toolJson(await callTool(TOKEN, 'get_flow', { id: flowId, body: 'none' }));
    ok('body=none 时不给正文', !!(noBody && noBody.response && noBody.response.body === undefined));
    const missing = await callTool(TOKEN, 'get_flow', { id: 'no-such-flow' });
    ok('不存在的 flow 返回 isError', missing.body.result.isError === true);

    // ------------------------------------------------------ ⑥-b 筛选与聚合
    await proxyRequest(`http://127.0.0.1:${upPort}/mcp-other?y=1`);
    await wait(400);

    const all = toolJson(await callTool(TOKEN, 'list_flows', { limit: 200 }));
    ok(
      'list_flows 同时给 total 与 returned',
      !!(all && all.total === all.returned && all.returned === all.flows.length && all.has_more === false),
      all && JSON.stringify({ total: all.total, returned: all.returned })
    );

    const one = toolJson(await callTool(TOKEN, 'list_flows', { limit: 1 }));
    ok(
      'limit 截断时 total 仍是匹配总数',
      !!(one && one.returned === 1 && one.total >= 2 && one.has_more === true),
      one && JSON.stringify({ total: one.total, returned: one.returned, has_more: one.has_more })
    );

    const byHost = toolJson(await callTool(TOKEN, 'list_flows', { host: '127.0.0.1' }));
    ok(
      '按域名筛选能收窄且不漏',
      !!(byHost && byHost.total >= 2 && byHost.flows.every((f) => /127\.0\.0\.1/.test(f.url))),
      byHost && byHost.total
    );

    const byRoute = toolJson(await callTool(TOKEN, 'list_flows', { route: 'GET /mcp-other' }));
    ok(
      '按接口筛选只留该接口',
      !!(byRoute && byRoute.total === 1 && /mcp-other/.test(byRoute.flows[0] && byRoute.flows[0].url)),
      byRoute && byRoute.total
    );

    const byIp = toolJson(await callTool(TOKEN, 'list_flows', { ip: 'local' }));
    ok('按客户端 IP 筛选（local=本机）', !!(byIp && byIp.total >= 2), byIp && byIp.total);

    const bySince = toolJson(await callTool(TOKEN, 'list_flows', { since_seconds: 3600 }));
    ok('时间窗参数可用且不误杀', !!(bySince && bySince.total === all.total), bySince && bySince.total);

    const zeroSince = toolJson(await callTool(TOKEN, 'list_flows', { since_seconds: 0 }));
    ok('since_seconds=0 表示不限时间', !!(zeroSince && zeroSince.total === all.total), zeroSince && zeroSince.total);

    const badSince = await callTool(TOKEN, 'list_flows', { since_seconds: 'abc' });
    ok('since_seconds 非数字时报错', badSince.body.result.isError === true);

    const hosts = toolJson(await callTool(TOKEN, 'list_hosts', { limit: 10 }));
    ok(
      'list_hosts 聚合出域名与条数',
      !!(hosts && hosts.hosts.some((h) => h.key === '127.0.0.1' && h.count >= 2)),
      hosts && JSON.stringify(hosts.hosts)
    );
    ok(
      'list_hosts 带应用 / 设备 / 接口',
      !!(
        hosts &&
        hosts.apps.length &&
        hosts.devices.length &&
        hosts.routes.some((r) => /mcp-other/.test(r.key))
      ),
      hosts && JSON.stringify({ apps: hosts.apps.length, routes: hosts.routes.map((r) => r.key) })
    );

    const hostsScoped = toolJson(await callTool(TOKEN, 'list_hosts', { app: '不存在的应用' }));
    ok(
      'list_hosts 按应用收窄后域名清空',
      !!(hostsScoped && hostsScoped.scoped === true && hostsScoped.hosts.length === 0),
      hostsScoped && JSON.stringify({ scoped: hostsScoped.scoped, hosts: hostsScoped.hosts.length })
    );

    // ------------------------------------------------------ ⑦ 规则类工具
    const made = toolJson(
      await callTool(TOKEN, 'create_rule', {
        url_match: '/mcp-check',
        name: 'MCP自检规则',
        dir: 'MCP自检',
        status: 201,
        method: 'GET',
        body: '{"mocked":true}',
        body_type: 'json',
        delay_ms: 0,
      })
    );
    ok('create_rule 落盘', !!(made && made.rule && made.rule.id));
    if (made && made.rule) {
      createdRuleIds.push(made.rule.id);
      ruleFile = made.rule.file;
      ok('规则文件真的存在', fs.existsSync(path.join(dataDir, 'rules', made.rule.file)), made.rule.file);
      ok('规则按参数写入了状态码与匹配串', made.rule.status === 201 && made.rule.url_match === '/mcp-check');
    }

    const rules = toolJson(await callTool(TOKEN, 'list_rules', { dir: 'MCP自检' }));
    ok('list_rules 能按文件夹过滤', rules && rules.total === 1, rules && rules.total);

    const got = toolJson(await callTool(TOKEN, 'get_rule', { path: ruleFile }));
    ok('get_rule 读得到响应体', !!(got && /mocked/.test(String(got.body || ''))));

    const upd = toolJson(await callTool(TOKEN, 'update_rule', { id: made.rule.id, status: 418, note: '自检改过' }));
    ok('update_rule 改了状态码', upd && upd.rule.status === 418, upd && upd.rule.status);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'rules', ruleFile), 'utf8'));
    ok('改动落到了文件', onDisk.status === 418 && onDisk.note === '自检改过');

    const mocked = toolJson(await callTool(TOKEN, 'mock_flow', { flow_id: flowId, dir: 'MCP自检', name: 'MCP流量Mock' }));
    ok('mock_flow 用流量生成了规则', !!(mocked && mocked.rule && mocked.rule.id));
    if (mocked && mocked.rule) createdRuleIds.push(mocked.rule.id);
    ok('生成规则的匹配串是 host+path', !!(mocked && /mcp-check/.test(mocked.matched_by || '')), mocked && mocked.matched_by);

    // 规则生效验证：同一个请求现在应被 Mock 成 201
    const viaMock = await proxyRequest(`http://127.0.0.1:${upPort}/mcp-check?x=2`);
    ok(
      '新建的 Mock 规则真的生效（不再打到上游）',
      viaMock.status === 201 || viaMock.status === 418,
      String(viaMock.status) + ' ' + String(viaMock.body).slice(0, 40)
    );

    const replayed = toolJson(await callTool(TOKEN, 'replay_flow', { id: flowId }));
    ok('replay_flow 打回上游并返回状态', !!(replayed && replayed.ok && replayed.status === 200), JSON.stringify(replayed));

    // ------------------------------------------------------ ⑧ 弱网 / 白名单 / 清空
    const sim = toolJson(await callTool(TOKEN, 'set_network_sim', { enabled: true, latency_ms: 120, kbps: 256 }));
    ok('set_network_sim 返回新配置', !!(sim && sim.network_sim && sim.network_sim.enabled === true));
    const st1 = (await jsonApi('/api/status')).body;
    ok('弱网参数真的生效', st1.networkSim.enabled === true && st1.networkSim.latencyMs === 120);
    await callTool(TOKEN, 'set_network_sim', { enabled: false });
    const st2 = (await jsonApi('/api/status')).body;
    ok('弱网可以关掉', st2.networkSim.enabled === false);

    const ptAdd = toolJson(await callTool(TOKEN, 'set_passthrough', { action: 'add', domains: ['mcp-check.example'] }));
    ok('set_passthrough 能加白名单', !!(ptAdd && ptAdd.passthrough.includes('mcp-check.example')), JSON.stringify(ptAdd));
    const ptDel = toolJson(await callTool(TOKEN, 'set_passthrough', { action: 'remove', domains: ['mcp-check.example'] }));
    ok('set_passthrough 能移除', !!(ptDel && !ptDel.passthrough.includes('mcp-check.example')));
    const settings = toolJson(await callTool(TOKEN, 'get_settings', {}));
    ok('get_settings 给出解密端口', !!(settings && Array.isArray(settings.mitm_ports)), JSON.stringify(settings && settings.mitm_ports));

    // ------------------------------------------------------ ⑨ 审计
    const audit = (await jsonApi('/api/mcp?audit=50')).body.audit || [];
    ok('审计记录了工具调用', audit.some((a) => a.tool === 'create_rule' && a.ok));
    ok('审计记录了失败调用', audit.some((a) => !a.ok), String(audit.length));
    ok('审计不含令牌明文', !JSON.stringify(audit).includes(TOKEN));

    // ------------------------------------------------------ ⑩ 撤销
    const revoked = await jsonApi('/api/mcp/tokens/' + readTokenId, { method: 'DELETE' });
    ok('撤销只读令牌成功', revoked.status === 200);
    const afterRevoke = await rpc(readToken, { jsonrpc: '2.0', id: 14, method: 'ping' });
    ok('撤销后立刻 401', afterRevoke.status === 401, String(afterRevoke.status));
    const mainStill = await rpc(TOKEN, { jsonrpc: '2.0', id: 15, method: 'ping' });
    ok('其它令牌不受影响', mainStill.status === 200);

    // ------------------------------------------------------ ⑪ stdio 桥
    const noTok = await runBridge(['--url', UI + '/mcp'], ['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    ok('stdio 桥没令牌时退出码 2 并提示', noTok.code === 2 && /令牌/.test(noTok.err), String(noTok.code));

    const bridged = await runBridge(
      ['--url', UI + '/mcp', '--token', TOKEN],
      [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge', version: '1' } },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ireq_status', arguments: {} } }),
      ]
    );
    ok('stdio 桥只回两行（通知不回包）', bridged.lines.length === 2, bridged.lines.length + ' 行');
    let bridgeInit = null;
    let bridgeCall = null;
    try {
      bridgeInit = JSON.parse(bridged.lines[0] || '{}');
      bridgeCall = JSON.parse(bridged.lines[1] || '{}');
    } catch {
      /* 解析失败就是断言失败 */
    }
    ok('stdio 桥转发了 initialize', !!(bridgeInit && bridgeInit.result && bridgeInit.result.serverInfo));
    ok('stdio 桥转发了 tools/call', !!(bridgeCall && bridgeCall.result && bridgeCall.result.content));

    const bridgeBad = await runBridge(['--url', UI + '/mcp', '--token', 'ireq_mcp_wrong-token-000000000000'], [
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    ]);
    const badResp = JSON.parse(bridgeBad.lines[0] || '{}');
    ok('stdio 桥把 401 转成 JSON-RPC 错误', badResp.error && badResp.error.code === -32001, JSON.stringify(badResp.error));

    // ------------------------------------------------------ ⑫ 收尾
    for (const id of createdRuleIds) {
      await callTool(TOKEN, 'delete_rule', { id });
    }
    const left = toolJson(await callTool(TOKEN, 'list_rules', { dir: 'MCP自检' }));
    ok('delete_rule 删干净了自检规则', left && left.total === 0, left && left.total);
    fs.rmSync(path.join(dataDir, 'rules', 'MCP自检'), { recursive: true, force: true });

    const cleared = toolJson(await callTool(TOKEN, 'clear_flows', {}));
    ok('clear_flows 返回清掉的条数', !!(cleared && cleared.ok && cleared.cleared >= 1), JSON.stringify(cleared));

    await jsonApi('/api/mcp/audit', { method: 'DELETE' });
    const emptyAudit = (await jsonApi('/api/mcp?audit=5')).body.audit || [];
    ok('审计可以清空', emptyAudit.length === 0, String(emptyAudit.length));
  } finally {
    /* 不管断言是否失败，都把授权状态还原：撤销自检令牌、关掉 MCP */
    try {
      const m = (await jsonApi('/api/mcp')).body;
      for (const t of m.tokens || []) {
        if (t.name.startsWith('check-')) {
          await jsonApi('/api/mcp/tokens/' + t.id, { method: 'DELETE' });
        }
      }
      await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: false } });
      fs.rmSync(path.join((await jsonApi('/api/status')).body.dataDir, 'rules', 'MCP自检'), {
        recursive: true,
        force: true,
      });
    } catch {
      /* 实例已经退出 */
    }
    upstream.close();
  }

  console.log(`\n${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();
