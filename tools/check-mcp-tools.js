'use strict';

/**
 * 自检：MCP 里「后加的那些能力」有没有真的暴露出来
 * ---------------------------------------------------------------------------
 * 覆盖 v1.5 之前没进 MCP 的模块：
 *   断点 / 脚本 / 条件告警 / 域名映射 / 脱敏 / 派生列 / 标注 / 性能聚合
 * 每个工具都验「读得到、写得进、改完能被 HTTP 接口看见」，最后把改动还原。
 *
 * 只动自己造的数据；结束把 MCP 关掉、令牌撤销、配置恢复。
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
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
  return { status: res.status, body };
};

let TOKEN = '';
async function rpc(payload) {
  const res = await fetch(UI + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + TOKEN,
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
  return { status: res.status, body };
}

const callTool = (name, args = {}) =>
  rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });

function toolJson(resp) {
  const r = resp.body && resp.body.result;
  if (!r || !r.content || !r.content[0]) return null;
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return { raw: r.content[0].text };
  }
}
const toolErr = (resp) => {
  const r = resp.body && resp.body.result;
  return !!(r && r.isError);
};

/** 经代理打一次，造一条真实流量（标注工具要用 flow id） */
function proxyRequest(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: url, headers: { host: u.host }, timeout: 10000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const uport = upstream.address().port;

  const before = {
    mcp: (await jsonApi('/api/mcp')).body || {},
    breakpoints: (await jsonApi('/api/breakpoints')).body || {},
    hostmap: (await jsonApi('/api/hostmap')).body || {},
    scripts: (await jsonApi('/api/scripts')).body || {},
    alerts: (await jsonApi('/api/alerts')).body || {},
    redact: (await jsonApi('/api/redact')).body || {},
    columns: (await jsonApi('/api/columns')).body || {},
  };
  let tokenId = '';

  try {
    await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: true } });
    const created = await jsonApi('/api/mcp/tokens', { method: 'POST', body: { name: 'check-tools', scopes: 'readwrite' } });
    TOKEN = created.body.token || '';
    tokenId = (created.body.entry && created.body.entry.id) || '';
    ok('拿到读写令牌', !!TOKEN);

    /* ---------------------------------------------------------- tools/list */
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (list.body.result.tools || []).map((t) => t.name);
    const want = [
      'list_breakpoints', 'set_breakpoints', 'list_scripts', 'save_scripts', 'list_alerts', 'set_alerts',
      'get_hostmap', 'set_hostmap', 'get_redact', 'set_redact', 'get_columns', 'set_columns',
      'annotate_flow', 'perf_summary',
    ];
    ok('新模块的工具都注册了', want.every((n) => names.includes(n)), `${names.length} 个工具`);
    ok('工具总数 ≥ 25', names.length >= 25, String(names.length));

    /* ------------------------------------------------------------ 断点 */
    const bp0 = toolJson(await callTool('list_breakpoints'));
    ok('list_breakpoints 给出开关与规则', bp0 && typeof bp0.enabled === 'boolean' && Array.isArray(bp0.rules), JSON.stringify(bp0).slice(0, 80));

    const bpSet = toolJson(await callTool('set_breakpoints', {
      enabled: true,
      timeout_ms: 20000,
      match: [{ match: '/mcp-bp-check', method: '', phase: 'request' }],
    }));
    ok('set_breakpoints 写入成功', bpSet && bpSet.enabled === true && bpSet.rules.length === 1, JSON.stringify(bpSet).slice(0, 100));
    ok('set_breakpoints 改了超时', bpSet && bpSet.timeout_ms === 20000, bpSet && bpSet.timeout_ms);
    const bpHttp = (await jsonApi('/api/breakpoints')).body || {};
    ok('HTTP 接口读得到 MCP 写的断点', bpHttp.enabled === true && bpHttp.rules.length === 1 && bpHttp.rules[0].match === '/mcp-bp-check',
      JSON.stringify(bpHttp.rules).slice(0, 80));

    /* ------------------------------------------------------------ 脚本 */
    const sc0 = toolJson(await callTool('list_scripts'));
    ok('list_scripts 返回开关与规则', sc0 && typeof sc0.enabled === 'boolean' && Array.isArray(sc0.rules));

    const bad = await callTool('save_scripts', {
      enabled: true,
      rules: [{ name: '坏脚本', phase: 'response', code: 'onResponse(res => {' }],
    });
    ok('语法错的脚本被拒', toolErr(bad), JSON.stringify(toolJson(bad)).slice(0, 100));

    const scSet = toolJson(await callTool('save_scripts', {
      enabled: true,
      rules: [{ name: '加标记', phase: 'response', code: "onResponse(res => { res.headers['x-mcp'] = '1'; })" }],
    }));
    ok('save_scripts 存下合法脚本', scSet && scSet.ok === true && scSet.rules === 1, JSON.stringify(scSet));
    const scHttp = (await jsonApi('/api/scripts')).body || {};
    ok('HTTP 读得到这条脚本', (scHttp.rules || []).some((r) => r.name === '加标记' && r.code.includes('x-mcp')));

    /* ------------------------------------------------------------ 告警 */
    const al0 = toolJson(await callTool('list_alerts'));
    ok('list_alerts 返回规则与静音状态', al0 && Array.isArray(al0.rules), JSON.stringify(al0).slice(0, 80));
    const alSet = toolJson(await callTool('set_alerts', {
      enabled: true,
      rules: [{ name: '5xx 提醒', status: '5xx' }],
    }));
    ok('set_alerts 写入成功', alSet && alSet.enabled === true && alSet.rules === 1, JSON.stringify(alSet));
    const alHttp = (await jsonApi('/api/alerts')).body || {};
    ok('HTTP 读得到这条告警', (alHttp.rules || []).some((r) => r.name === '5xx 提醒'));

    /* --------------------------------------------------------- 域名映射 */
    const hm0 = toolJson(await callTool('get_hostmap'));
    ok('get_hostmap 返回开关与规则', hm0 && Array.isArray(hm0.rules));
    const hmSet = toolJson(await callTool('set_hostmap', {
      enabled: true,
      rules: [{ from: 'mcp-map.example', to: `127.0.0.1:${uport}` }],
    }));
    ok('set_hostmap 写入成功', hmSet && hmSet.rules.length === 1 && hmSet.rules[0].from === 'mcp-map.example', JSON.stringify(hmSet).slice(0, 100));
    const hmHttp = (await jsonApi('/api/hostmap')).body || {};
    ok('HTTP 读得到这条映射', (hmHttp.rules || []).some((r) => r.from === 'mcp-map.example'));

    /* ------------------------------------------------------------ 脱敏 */
    const rd0 = toolJson(await callTool('get_redact'));
    ok('get_redact 给出四类开关与清单', rd0 && typeof rd0.enabled === 'boolean' && rd0.effective && Array.isArray(rd0.effective.headers));
    const rdSet = toolJson(await callTool('set_redact', { enabled: true, headers: true, query: true, body: true, pii: false }));
    ok('set_redact 生效', rdSet && rdSet.enabled === true && rdSet.pii === false, JSON.stringify(rdSet));
    const rdHttp = (await jsonApi('/api/redact')).body || {};
    ok('HTTP 读得到脱敏开关', rdHttp.enabled === true && rdHttp.pii === false);
    ok('脱敏清单没被清空', (rdHttp.effective.headers || []).length > 0);

    /* --------------------------------------------------------- 派生列 */
    const co0 = toolJson(await callTool('get_columns'));
    ok('get_columns 返回数组', co0 && Array.isArray(co0.columns));
    const coSet = toolJson(await callTool('set_columns', {
      columns: [{ name: 'ok 字段', path: 'ok', source: 'res' }],
    }));
    ok('set_columns 写入成功', coSet && (coSet.columns || []).length === 1, JSON.stringify(coSet).slice(0, 100));
    const coHttp = (await jsonApi('/api/columns')).body || {};
    ok('HTTP 读得到这条派生列', (coHttp.columns || []).some((c) => c.name === 'ok 字段'));

    /* ------------------------------------------------------------ 标注 */
    await jsonApi('/api/hostmap', {
      method: 'PUT',
      body: { enabled: true, rules: [{ from: 'mcp-map.example', to: `127.0.0.1:${uport}` }] },
    });
    await proxyRequest('http://mcp-map.example/annotate-me');
    await wait(400);
    const flows = (await jsonApi('/api/flows?limit=20')).body || [];
    const target = (flows || []).find((f) => String(f.url || '').includes('annotate-me'));
    ok('造出一条可标注的流量', !!target, target && target.id);
    if (target) {
      const an = toolJson(await callTool('annotate_flow', { id: target.id, note: 'MCP 标注', color: 'red', pinned: true }));
      ok('annotate_flow 写入成功', an && an.annotation && an.annotation.note === 'MCP 标注' && an.annotation.pinned === true, JSON.stringify(an).slice(0, 120));
      // 详情接口是把标注合到 flow 顶层（note / color / pinned），不是单独的 annotation 字段
      const one = (await jsonApi('/api/flows/' + target.id)).body || {};
      ok('HTTP 读得到这条标注', one.note === 'MCP 标注' && one.color === 'red' && one.pinned === true,
        JSON.stringify({ note: one.note, color: one.color, pinned: one.pinned }));
      const clear = toolJson(await callTool('annotate_flow', { id: target.id, note: '', color: '', pinned: false }));
      ok('三个字段都空 = 清掉标注', clear && clear.annotation === null, JSON.stringify(clear));
      const one2 = (await jsonApi('/api/flows/' + target.id)).body || {};
      ok('清掉后详情不再带标注', !one2.note && !one2.color && one2.pinned !== true);
    }

    /* ------------------------------------------------------------ 性能 */
    const perf = toolJson(await callTool('perf_summary', { by: 'host', limit: 200 }));
    ok('perf_summary 返回分组与最慢请求', perf && Array.isArray(perf.groups), JSON.stringify(perf).slice(0, 100));
    ok('perf_summary 带样本量', perf && typeof perf.in_memory === 'number', perf && perf.in_memory);
    const perfRoute = toolJson(await callTool('perf_summary', { by: 'route' }));
    ok('按接口聚合也有结果', perfRoute && Array.isArray(perfRoute.groups) && perfRoute.groups.length > 0, perfRoute && perfRoute.groups.length);

    /* ------------------------------------------------------ 只读令牌 */
    const roTok = await jsonApi('/api/mcp/tokens', { method: 'POST', body: { name: 'check-tools-ro', scopes: 'read' } });
    const RO = roTok.body.token;
    const roNames = ((await (async () => {
      const res = await fetch(UI + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RO },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      return res.json();
    })()).result.tools || []).map((t) => t.name);
    ok('只读令牌看不到 set_* 写工具', !roNames.includes('set_breakpoints') && !roNames.includes('save_scripts') && !roNames.includes('annotate_flow'));
    ok('只读令牌能看到读工具', roNames.includes('list_breakpoints') && roNames.includes('perf_summary'));
    await jsonApi('/api/mcp/tokens/' + roTok.body.entry.id, { method: 'DELETE' }).catch(() => {});
  } finally {
    /* 还原：把这次改过的配置都放回去 */
    const restore = async (path, body, method = 'PUT') => {
      await jsonApi(path, { method, body }).catch(() => {});
    };
    await restore('/api/breakpoints', { enabled: before.breakpoints.enabled === true, rules: before.breakpoints.rules || [] });
    await restore('/api/scripts', { enabled: (before.scripts || {}).enabled === true, rules: before.scripts.rules || [] });
    await restore('/api/alerts', { enabled: (before.alerts || {}).enabled === true, rules: before.alerts.rules || [] });
    await restore('/api/hostmap', { enabled: before.hostmap.enabled === true, rules: before.hostmap.rules || [] });
    await restore('/api/columns', { columns: before.columns.columns || [] });
    if (before.redact) {
      await restore('/api/redact', {
        enabled: before.redact.enabled !== false,
        headers: before.redact.headers !== false,
        query: before.redact.query !== false,
        body: before.redact.body !== false,
        pii: before.redact.pii === true,
      });
    }
    if (tokenId) await jsonApi('/api/mcp/tokens/' + tokenId, { method: 'DELETE' }).catch(() => {});
    await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: before.mcp.enabled === true } }).catch(() => {});
    upstream.close();
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((err) => {
  console.error('自检异常:', err && err.message);
  process.exitCode = 1;
});
