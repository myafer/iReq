'use strict';

/**
 * 自检：断点拦截
 * ---------------------------------------------------------------------------
 * ① 请求阶段：挂起 → 改 body / 改 URL / 改方法 → 上游真的收到改后的内容
 * ② 响应阶段：挂起 → 改状态码 / 改 body → 客户端真的收到改后的内容
 * ③ 直接返回：不碰上游，给客户端一个自定义响应
 * ④ 兜底：关掉开关 / 超时 / release-all 都必须自己放行，不能留悬挂连接
 * ⑤ 规则语义：phase 区分、method 过滤、通配匹配、不命中就直通
 * ⑥ 放行两次、放行不存在的 id 都要给 404，不能抛
 * ⑦ 抓包记录：被断点拦下的那条要能在列表里看到最终结果
 *
 * 只改内存里的断点配置，结束时关掉开关、清掉自己造的流量。
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

let UP = 0;
/** 经代理发请求。挂起时这个 Promise 会一直不 resolve，直到放行或超时 */
function via(path, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve) => {
    const headers = { host: `127.0.0.1:${UP}` };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method, path: `http://127.0.0.1:${UP}${path}`, headers, timeout: 30000 },
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

const setRules = (rules, enabled = true, timeoutMs) =>
  jsonApi('/api/breakpoints', { method: 'PUT', body: { rules, enabled, ...(timeoutMs ? { timeoutMs } : {}) } });
const pending = async () => (await jsonApi('/api/breakpoints')).body.pending;
const resume = (id, action) => jsonApi('/api/breakpoints/' + id, { method: 'POST', body: action });

(async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: raw, path: req.url }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  UP = upstream.address().port;

  try {
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(120);

    /* ---------------- ① 请求阶段 ---------------- */
    await setRules([{ id: 'r1', match: '/bp-req', phase: 'request' }]);
    const p1 = via('/bp-req?x=1', { method: 'POST', body: '{"orig":1}' });
    await wait(350);
    let st = await pending();
    ok('请求阶段会挂起', st.length === 1, `${st.length} 条`);
    ok('挂起项带方法 / 完整 URL', st[0] && st[0].method === 'POST' && /\/bp-req\?x=1$/.test(st[0].url || ''), st[0] && st[0].url);
    ok('挂起项带 body 预览', st[0] && st[0].bodyPreview.includes('orig'), st[0] && st[0].bodyPreview);

    const full = (await jsonApi('/api/breakpoints/' + st[0].id)).body;
    ok('单条接口给的是 body 全文', full && full.body === '{"orig":1}', full && full.body);

    await resume(st[0].id, { type: 'resume', body: '{"changed":true}' });
    const r1 = await p1;
    ok('改 body 后上游收到的是新内容', hits.some((h) => h.body === '{"changed":true}'), r1.status + ' ' + r1.body);

    /* 改 URL：路径要真的变 */
    await setRules([{ id: 'r1', match: '/bp-url', phase: 'request' }]);
    const p2 = via('/bp-url');
    await wait(350);
    st = await pending();
    await resume(st[0].id, { type: 'resume', url: `http://127.0.0.1:${UP}/bp-rewritten?z=9` });
    await p2;
    ok('改 URL 后上游收到的是新地址', hits.some((h) => h.url === '/bp-rewritten?z=9'), hits.map((h) => h.url).slice(-2).join(','));

    /* 改方法 */
    await setRules([{ id: 'r1', match: '/bp-method', phase: 'request' }]);
    const p3 = via('/bp-method');
    await wait(350);
    st = await pending();
    await resume(st[0].id, { type: 'resume', method: 'DELETE' });
    await p3;
    ok('改方法后上游收到的是新方法', hits.some((h) => h.url === '/bp-method' && h.method === 'DELETE'), '');

    /* ---------------- ② 响应阶段 ---------------- */
    await setRules([{ id: 'r2', match: '/bp-res', phase: 'response' }]);
    const p4 = via('/bp-res');
    await wait(400);
    st = await pending();
    ok('响应阶段会挂起', st.length === 1, `${st.length} 条`);
    ok('挂起项带上游状态码', st[0] && st[0].status === 200, st[0] && String(st[0].status));
    ok('挂起项带上游响应体', st[0] && st[0].bodyPreview.includes('echo'), st[0] && st[0].bodyPreview);
    await resume(st[0].id, { type: 'resume', status: 418, body: '{"teapot":1}' });
    const r4 = await p4;
    ok('改状态码生效', r4.status === 418, String(r4.status));
    ok('改 body 生效', r4.body === '{"teapot":1}', r4.body);

    /* 只改 body 不改状态码，长度要重算（否则客户端会卡住等字节） */
    await setRules([{ id: 'r2', match: '/bp-len', phase: 'response' }]);
    const p5 = via('/bp-len');
    await wait(400);
    st = await pending();
    await resume(st[0].id, { type: 'resume', body: 'x'.repeat(5000) });
    const r5 = await p5;
    ok('改 body 后长度重算，客户端能收全', r5.body.length === 5000, `${r5.body.length} 字节`);

    /* ---------------- ③ 直接返回 ---------------- */
    await setRules([{ id: 'r3', match: '/bp-abort', phase: 'request' }]);
    const before = hits.length;
    const p6 = via('/bp-abort');
    await wait(350);
    st = await pending();
    await resume(st[0].id, { type: 'abort', status: 403, body: 'blocked-by-breakpoint' });
    const r6 = await p6;
    ok('直接返回：自定义状态码', r6.status === 403, String(r6.status));
    ok('直接返回：自定义 body', r6.body === 'blocked-by-breakpoint', r6.body);
    ok('直接返回：不碰上游', hits.length === before, `上游多收到 ${hits.length - before} 次`);

    /* ---------------- ④ 兜底 ---------------- */
    // 关掉开关
    await setRules([{ id: 'r4', match: '/bp-off', phase: 'request' }]);
    const p7 = via('/bp-off');
    await wait(300);
    ok('关开关前确实挂着', (await pending()).length === 1, '');
    await setRules([], false);
    const r7 = await p7;
    ok('关开关会立刻放行挂起项', r7.status === 200, `${r7.status}`);
    ok('放行后队列清空', (await pending()).length === 0, '');

    // 超时自动放行
    await setRules([{ id: 'r5', match: '/bp-timeout', phase: 'request' }], true, 1200);
    const t0 = Date.now();
    const p8 = via('/bp-timeout');
    const r8 = await p8;
    const spent = Date.now() - t0;
    ok('超时自动放行（不挂死）', r8.status === 200 && spent >= 1000 && spent < 8000, `${r8.status} · ${spent}ms`);

    // release-all
    await setRules([{ id: 'r6', match: '/bp-all', phase: 'request' }], true, 60000);
    const p9 = via('/bp-all');
    await wait(300);
    const rel = await jsonApi('/api/breakpoints/release-all', { method: 'POST' });
    const r9 = await p9;
    ok('release-all 一次放行全部', rel.body.released === 1 && r9.status === 200, `released=${rel.body.released}`);

    /* ---------------- ⑤ 规则语义 ---------------- */
    // phase 隔离：request 规则只在请求阶段停一次，放行后的响应不该再被拦
    await jsonApi('/api/breakpoints/release-all', { method: 'POST' });
    await setRules([{ id: 'r7', match: '/bp-phase', phase: 'request' }]);
    const p10 = via('/bp-phase');
    await wait(300);
    const q10 = (await pending()).find((x) => x.url.endsWith('/bp-phase'));
    ok('request 规则在请求阶段挂起', !!q10, '');
    if (q10) await resume(q10.id, { type: 'resume' });
    const r10 = await p10;
    ok('放行后响应阶段不再挂一次（phase 隔离）', r10.status === 200 && !(await pending()).find((x) => x.url.endsWith('/bp-phase')), `${r10.status}`);

    // method 过滤
    await jsonApi('/api/breakpoints/release-all', { method: 'POST' });
    await setRules([{ id: 'r8', match: '/bp-m', phase: 'request', method: 'POST' }]);
    const r11 = await via('/bp-m');
    ok('method 过滤：GET 不命中', r11.status === 200, `${r11.status}`);
    const p12 = via('/bp-m', { method: 'POST', body: '{}' });
    await wait(350);
    const q12 = (await pending()).find((x) => x.url.endsWith('/bp-m'));
    ok('method 过滤：POST 命中并挂起', !!q12, '');
    if (q12) {
      await resume(q12.id, { type: 'resume' });
      await p12;
    }

    // 通配
    await setRules([{ id: 'r9', match: '*/bp-wild/*', phase: 'request' }]);
    const p13 = via('/bp-wild/abc');
    await wait(350);
    const q13 = (await pending()).find((x) => x.url.includes('/bp-wild/'));
    ok('通配符匹配', !!q13, '');
    if (q13) {
      await resume(q13.id, { type: 'resume' });
      await p13;
    }

    // 不命中
    const r14 = await via('/totally-different');
    ok('不命中的请求直通', r14.status === 200, `${r14.status}`);

    /* ---------------- ⑥ 重复操作 ---------------- */
    await setRules([{ id: 'r10', match: '/bp-twice', phase: 'request' }]);
    const p15 = via('/bp-twice');
    await wait(300);
    st = await pending();
    const first = await resume(st[0].id, { type: 'resume' });
    const second = await resume(st[0].id, { type: 'resume' });
    await p15;
    ok('第一次放行成功', first.status === 200, String(first.status));
    ok('重复放行给 404，不抛错', second.status === 404, String(second.status));
    ok('放行不存在的 id 给 404', (await resume('nope-123', { type: 'resume' })).status === 404, '');

    /* ---------------- ⑦ 抓包记录 ---------------- */
    const flows = (await jsonApi('/api/flows?limit=30')).body;
    const list = flows.flows || flows;
    const aborted = list.find((f) => f.path === '/bp-abort');
    ok('被拦截的请求也进了列表', !!aborted, aborted && String(aborted.status));
    ok('拦截记录状态码正确', aborted && aborted.status === 403, aborted && String(aborted.status));
  } catch (e) {
    ok('脚本异常', false, e && e.message);
  } finally {
    upstream.close();
    await setRules([], false, 60000);
    await jsonApi('/api/flows', { method: 'DELETE' });
  }

  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exitCode = 1;
})();
