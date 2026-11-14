'use strict';

/**
 * 自检：正文搜索 + 列表排序
 * ---------------------------------------------------------------------------
 * ① 默认只搜元信息：只在响应体里出现的词搜不到（避免实时列表每帧扫几十 MB）
 * ② body=1 打开后能搜到；`body:关键词` 前缀等价于「只搜正文」
 * ③ body: 前缀不参与元信息匹配（body:GET 不该命中所有 GET）；正则元字符按字面
 * ④ 请求体也能搜到（POST 的表单 / JSON）
 * ⑤ 排序：耗时 / 大小 / 状态，升降序都对；排序模式一次给全（hasMore=false）
 * ⑥ 非法 sort 参数不能装成「排过序」，仍走时间倒序 + 可继续翻页
 * ⑦ 排序与筛选叠加、limit 截断
 * ⑧ 历史回看（磁盘倒序分块读）同样支持搜正文，但忽略 sort
 *
 * 只动自己造的流量和历史，跑完把历史清掉。
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

/** 经代理发一条请求（path 必须是绝对 URL，相对路径不会被当正向代理） */
function viaProxy(hostPort, p, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve) => {
    const headers = { host: hostPort };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method, path: `http://${hostPort}${p}`, headers, timeout: 8000 },
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

const page = async (qs) => (await jsonApi('/api/flows/page?' + qs)).body;
const paths = (flows) => flows.map((f) => f.path);

(async () => {
  const upstream = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const p = u.pathname;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const delay = Number(u.searchParams.get('d') || 0);
      const pad = Number(u.searchParams.get('n') || 0);
      const code = Number(u.searchParams.get('c') || 200);
      setTimeout(() => {
        // 这段只在响应体里出现，URL 里没有 —— 专门用来区分「搜元信息」和「搜正文」
        const payload = {
          secret: 'needle-in-body',
          echo: raw || '',
          pad: 'x'.repeat(pad),
        };
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }, delay);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  // 必须用能解析的地址：假域名（*.test）解析不了，响应体压根不会产生，
  // 而这份自检全靠「响应体里的关键词」来区分搜元信息还是搜正文
  const hostA = `127.0.0.1:${upPort}`;

  try {
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(150);

    /* 三条流量：慢但不大的、快但最大的、状态码不同的；路径里刻意不带 needle */
    await viaProxy(hostA, '/slow?d=500&n=100&c=500');
    await viaProxy(hostA, '/big?d=30&n=60000&c=200');
    await viaProxy(hostA, '/tiny?d=10&n=10&c=404');
    await viaProxy(hostA, '/post', { method: 'POST', body: JSON.stringify({ user: 'request-body-marker' }) });
    await wait(700);

    /* ---------------- ① 默认不搜正文 ---------------- */
    const off = await page('limit=20&q=needle-in-body');
    ok('默认只搜元信息：响应体里的词搜不到', off.flows.length === 0, `${off.flows.length} 条`);

    /* ---------------- ② 打开后能搜到 ---------------- */
    const on = await page('limit=20&q=needle-in-body&body=1');
    // 4 条里含 POST：它的响应体回显了请求体，同样带这个关键词
    ok('body=1：能搜到响应体里的词', on.flows.length === 4, `${on.flows.length} 条`);
    ok('body=1：命中的三条都不是靠 URL 匹配的', on.flows.every((f) => !f.url.includes('needle')), '');

    const prefix = await page('limit=20&q=' + encodeURIComponent('body:needle-in-body'));
    ok('body: 前缀等价于只搜正文', prefix.flows.length === 4, `${prefix.flows.length} 条`);

    /* ---------------- ③ body: 的边界 ---------------- */
    const metaOnly = await page('limit=20&q=' + encodeURIComponent('body:GET'));
    ok('body: 不参与元信息匹配（body:GET 不该命中所有 GET）', metaOnly.flows.length === 0, `${metaOnly.flows.length} 条`);

    const metaStill = await page('limit=20&q=' + encodeURIComponent('/big'));
    ok('元信息搜索不受影响（按路径仍能搜到）', metaStill.flows.length === 1, paths(metaStill.flows).join(','));

    const upper = await page('limit=20&q=NEEDLE-IN-BODY&body=1');
    ok('正文搜索大小写不敏感', upper.flows.length === 4, `${upper.flows.length} 条`);

    const dot = await page('limit=20&q=' + encodeURIComponent('body:x.x') + '&body=1');
    ok('关键词里的正则元字符按字面匹配', dot.flows.length === 0, `${dot.flows.length} 条`);

    /* ---------------- ④ 请求体 ---------------- */
    const reqBody = await page('limit=20&q=request-body-marker&body=1');
    ok('请求体也能搜到', reqBody.flows.length === 1 && reqBody.flows[0].method === 'POST', paths(reqBody.flows).join(','));

    /* ---------------- ⑤ 排序 ---------------- */
    const durDesc = await page('limit=20&sort=duration&dir=desc');
    const durations = durDesc.flows.map((f) => f.duration || 0);
    ok(
      '耗时降序',
      durations.every((v, i) => i === 0 || durations[i - 1] >= v),
      durations.join(',')
    );
    ok('排序模式一次给全，不再翻页', durDesc.hasMore === false && durDesc.sorted === true && durDesc.nextCursor === '', '');

    const durAsc = await page('limit=20&sort=duration&dir=asc');
    const ascDur = durAsc.flows.map((f) => f.duration || 0);
    ok(
      '耗时升序',
      ascDur.every((v, i) => i === 0 || ascDur[i - 1] <= v),
      ascDur.join(',')
    );

    const sizeDesc = await page('limit=20&sort=size&dir=desc');
    ok('大小降序：最大的在最前', String(sizeDesc.flows[0].path).startsWith('/big'), sizeDesc.flows[0].path);

    const statusAsc = await page('limit=20&sort=status&dir=asc');
    const codes = statusAsc.flows.map((f) => f.status);
    ok(
      '状态升序',
      codes.every((v, i) => i === 0 || codes[i - 1] <= v),
      codes.join(',')
    );

    const statusDesc = await page('limit=20&sort=status&dir=desc');
    ok('状态降序：5xx 在最前', statusDesc.flows[0].status === 500, String(statusDesc.flows[0].status));

    /* ---------------- ⑥ 非法 sort ---------------- */
    const bad = await page('limit=20&sort=drop_table');
    ok('非法 sort 被忽略（仍按时间倒序 + 可继续翻页）', bad.sorted === undefined && bad.flows.length > 0, `hasMore=${bad.hasMore}`);

    /* ---------------- ⑦ 排序 + 筛选 + limit ---------------- */
    const filtered = await page('limit=20&sort=duration&status=2xx');
    ok(
      '排序与状态筛选叠加',
      filtered.flows.length > 0 && filtered.flows.every((f) => f.status >= 200 && f.status < 300),
      filtered.flows.map((f) => f.status).join(',')
    );
    const limited = await page('limit=2&sort=duration&dir=desc');
    ok('排序结果也受 limit 截断', limited.flows.length === 2, `${limited.flows.length} 条`);

    /* ---------------- ⑧ 历史回看 ---------------- */
    // 清空 = 把当前这批存成一条历史，回看走的是磁盘倒序分块读
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(350);
    const hist = (await jsonApi('/api/history')).body;
    const item = hist.items[0];
    ok('清空后留下一条历史', !!item, item && item.name);

    if (item) {
      const hBody = (await jsonApi(`/api/history/${item.id}/flows?limit=20&q=needle-in-body&body=1`)).body;
      ok('历史回看也能搜正文（磁盘倒序分块读同一套筛选）', hBody.flows.length === 4, `${hBody.flows.length} 条`);

      const hNoBody = (await jsonApi(`/api/history/${item.id}/flows?limit=20&q=needle-in-body`)).body;
      ok('历史回看同样默认不搜正文', hNoBody.flows.length === 0, `${hNoBody.flows.length} 条`);

      const hSort = (await jsonApi(`/api/history/${item.id}/flows?limit=20&sort=duration&dir=desc`)).body;
      const hTs = hSort.flows.map((f) => f.ts || 0);
      ok(
        '历史回看忽略 sort，仍是时间倒序',
        hTs.every((v, i) => i === 0 || hTs[i - 1] >= v),
        hSort.flows.map((f) => f.path).join(',')
      );

      // 收拾干净
      await jsonApi(`/api/history/${item.id}`, { method: 'DELETE' });
    }
  } catch (e) {
    ok('脚本异常', false, e && e.message);
  } finally {
    upstream.close();
    await jsonApi('/api/flows', { method: 'DELETE' });
  }

  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exitCode = 1;
})();
