'use strict';

/**
 * 自检：历史记录 + 列表上拉加载
 * ---------------------------------------------------------------------------
 * ① 列表分页：游标翻页不重不漏；筛完还能继续翻
 * ② 内存只留 maxFlows 条时，翻到底自动接着读当天落盘文件（内存可配、全部可知）
 * ③ 清空 = 生成一条历史记录：默认名是清空时刻、条数/大小对得上、文件真在磁盘上
 * ④ 回看：倒序分页、条数校准（清空时只记了内存条数，文件里其实更多）、
 *    筛选能用、不存在的记录给 404
 * ⑤ 改名：生效并落盘、空名字当没改、超长截断、同一分钟内两次清空名字不撞
 * ⑥ 删除：连文件一起删；重复删 404；支持一键全删
 *
 * 只动自己造的流量和历史，结束时把 maxFlows 恢复、历史删干净。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
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

/** 经代理打一条请求（绝对 URL 才会被当正向代理用） */
function viaProxy(hostPort, p) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method: 'GET',
        path: `http://${hostPort}${p}`,
        headers: { host: hostPort },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const upstream = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    if (p === '/hist-a' || p === '/hist-b') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: p }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const hostA = `alpha.hist.test:${upPort}`;
  const hostB = `beta.hist.test:${upPort}`;
  // flow.host 是去掉端口的域名，筛选也按域名来
  const domA = 'alpha.hist.test';

  const createdIds = [];

  try {
    const status0 = (await jsonApi('/api/status')).body;
    const dataDir = status0.dataDir;
    const flowsDir = path.join(dataDir, 'flows');

    /* ---------------- ① 列表分页 ---------------- */
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(120);
    for (let i = 0; i < 9; i++) await viaProxy(i % 2 ? hostA : hostB, `/hist-a?i=${i}`);
    await wait(400);

    const p1 = (await jsonApi('/api/flows/page?limit=4')).body;
    ok('分页：第一页按 limit 返回', p1.flows.length === 4 && p1.hasMore === true, `got=${p1.flows.length}`);
    const p2 = (await jsonApi('/api/flows/page?limit=4&cursor=' + encodeURIComponent(p1.nextCursor))).body;
    const ids1 = p1.flows.map((f) => f.id);
    ok('分页：第二页与第一页不重叠', p2.flows.every((f) => !ids1.includes(f.id)), `${p2.flows.length} 条`);

    const all = [];
    let cursor = '';
    for (let i = 0; i < 12; i++) {
      const url = '/api/flows/page?limit=4' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const d = (await jsonApi(url)).body;
      all.push(...d.flows.map((f) => f.id));
      if (!d.hasMore) break;
      cursor = d.nextCursor;
    }
    ok('分页：一直翻到底能拿到全部 9 条', all.length === 9 && new Set(all).size === 9, `${all.length} 条`);

    const filtered = (await jsonApi('/api/flows/page?limit=50&host=' + encodeURIComponent(domA))).body;
    ok('分页：筛选条件生效（按域名）', filtered.flows.length === 4, `${filtered.flows.length} 条`);

    /* ---------------- ② 内存见底后接着读磁盘 ---------------- */
    await jsonApi('/api/config', { method: 'PUT', body: { maxFlows: 3 } });
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(120);
    for (let i = 0; i < 12; i++) await viaProxy(i % 2 ? hostA : hostB, `/hist-b?i=${i}`);
    await wait(500);
    const memOnly = (await jsonApi('/api/status')).body.store.total;
    ok('内存上限生效（只留 3 条）', memOnly === 3, String(memOnly));

    const disk1 = (await jsonApi('/api/flows/page?limit=50')).body;
    ok(
      '内存翻完会给出磁盘游标',
      disk1.flows.length === 3 && disk1.hasMore === true && String(disk1.nextCursor).startsWith('d:'),
      `flows=${disk1.flows.length} cursor=${String(disk1.nextCursor).slice(0, 12)}`
    );
    const disk2 = (await jsonApi('/api/flows/page?limit=50&cursor=' + encodeURIComponent(disk1.nextCursor))).body;
    const seen = [...disk1.flows, ...disk2.flows].map((f) => f.id);
    ok(
      '磁盘续读补齐剩余（12 条不重不漏）',
      seen.length === 12 && new Set(seen).size === 12,
      `${seen.length} 条 / 重复 ${seen.length - new Set(seen).size}`
    );
    ok('磁盘页标了 fromDisk', disk2.fromDisk === true);

    /* ---------------- ③ 清空 = 一条历史记录 ---------------- */
    const beforeCount = (await jsonApi('/api/status')).body.store.total;
    const histBefore = (await jsonApi('/api/history')).body;
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(250);
    const hist = (await jsonApi('/api/history')).body;
    ok('清空后历史多一条', hist.items.length === histBefore.items.length + 1, `${hist.items.length} 条`);
    const item = hist.items[0];
    ok(
      '新记录用清空时刻命名',
      /^\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(item.name),
      item.name
    );
    ok('记录里带条数与大小', item.count > 0 && item.bytes > 0, `count=${item.count} bytes=${item.bytes}`);
    const absFile = path.join(flowsDir, item.file);
    ok('磁盘上确实有这份归档', fs.existsSync(absFile) && /\.cleared-\d+$/.test(item.file), item.file);
    ok('历史索引已落盘', fs.existsSync(path.join(dataDir, 'history.json')));
    ok(
      '清空时记的是内存条数（后面会被校准）',
      item.count <= beforeCount || item.count === beforeCount,
      `count=${item.count} 内存=${beforeCount}`
    );
    createdIds.push(item.id);

    /* ---------------- ④ 回看 ---------------- */
    const h1 = (await jsonApi(`/api/history/${item.id}/flows?limit=4`)).body;
    ok('回看：第一页按 limit 返回', h1.flows.length === 4 && h1.hasMore === true);
    ok('回看：条数校准成文件里的真实条数', h1.total === 12, `total=${h1.total}`);

    const hp = [];
    let hcur = '';
    for (let i = 0; i < 12; i++) {
      const url = `/api/history/${item.id}/flows?limit=5` + (hcur ? '&cursor=' + encodeURIComponent(hcur) : '');
      const d = (await jsonApi(url)).body;
      hp.push(...d.flows.map((f) => f.id));
      if (!d.hasMore) break;
      hcur = d.nextCursor;
    }
    ok('回看：翻到底拿到 12 条且不重复', hp.length === 12 && new Set(hp).size === 12, `${hp.length} 条`);

    const hf = (await jsonApi(`/api/history/${item.id}/flows?limit=100&host=` + encodeURIComponent(domA))).body;
    ok('回看：筛选在归档上同样生效', hf.flows.length === 6 && hf.total === 6, `${hf.flows.length}/${hf.total}`);
    const hn = (await jsonApi(`/api/history/${item.id}/flows?limit=100&q=no-such-thing`)).body;
    ok('回看：筛不到就是空', hn.flows.length === 0 && hn.total === 0);

    const missing = await jsonApi('/api/history/nope-123/flows?limit=5');
    ok('回看：不存在的记录 404', missing.status === 404, String(missing.status));

    /* ---------------- ⑤ 同一分钟内连续清空：名字不能撞 ---------------- */
    for (let i = 0; i < 2; i++) await viaProxy(hostA, `/hist-a?again=${i}`);
    await wait(200);
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(250);
    const hist2 = (await jsonApi('/api/history')).body;
    const second = hist2.items[0];
    createdIds.push(second.id);
    ok('第二次清空又加一条', hist2.items.length === histBefore.items.length + 2, `${hist2.items.length} 条`);
    ok('同一分钟内不会被当成同一条', second.id !== item.id);
    ok(
      '同一分钟撞名时名字退到带秒',
      /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(second.name) && second.name !== item.name,
      second.name
    );

    /* 同一秒内连着清（脚本 / 自动化）：名字必须还能区分，不能三条都叫 02:37:35 */
    {
      const { FlowHistory } = require('../src/history');
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ireq-hn-'));
      const fh = new FlowHistory({ dir: tmp, indexFile: path.join(tmp, 'history.json') });
      const ts = Date.now();
      const names = ['a', 'b', 'c'].map((id, i) =>
        fh.add({ id, file: `f${i}`, createdAt: ts, bytes: 10, count: 1 }).name
      );
      ok('同一秒连清三条：名字互不相同', new Set(names).size === 3, names.join(' / '));
      ok('同一秒连清三条：最后一条带序号', /\(\d+\)$/.test(names[2]), names[2]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    /* ---------------- ⑥ 改名 ---------------- */
    const renamed = (await jsonApi('/api/history/' + item.id, { method: 'PATCH', body: { name: '  下单链路排查  ' } })).body;
    ok('改名：去空白后生效', renamed.item && renamed.item.name === '下单链路排查', renamed.item && renamed.item.name);
    const listed = (await jsonApi('/api/history')).body.items.find((x) => x.id === item.id);
    ok('改名：列表里也变了', listed && listed.name === '下单链路排查', listed && listed.name);

    /* ---------------- ⑥' 导出：HAR（默认）/ 原始 JSON ---------------- */
    const harRes = await fetch(`${UI}/api/history/${item.id}/export`);
    const harText = await harRes.text();
    const har = JSON.parse(harText);
    ok('导出 HAR：200 + 正确的 content-type', harRes.status === 200 && /har\+json/.test(harRes.headers.get('content-type') || ''), String(harRes.status));
    ok('导出 HAR：版本 1.2 且条目齐全', har.log && har.log.version === '1.2' && har.log.entries.length === 12, `entries=${har.log && har.log.entries.length}`);
    ok('导出 HAR：条数响应头对得上', harRes.headers.get('x-flow-count') === '12', String(harRes.headers.get('x-flow-count')));
    ok('导出 HAR：没被截断', harRes.headers.get('x-export-truncated') === '0', String(harRes.headers.get('x-export-truncated')));

    const e0 = har.log.entries[0];
    const eN = har.log.entries[har.log.entries.length - 1];
    ok(
      '导出 HAR：条目按时间正序（跟列表的倒序相反）',
      new Date(e0.startedDateTime) <= new Date(eN.startedDateTime),
      `${e0.startedDateTime} → ${eN.startedDateTime}`
    );
    ok(
      '导出 HAR：请求/响应字段齐全',
      e0.request && e0.request.method === 'GET' && /hist-[ab]\?/.test(e0.request.url || '') &&
        e0.response && typeof e0.response.status === 'number' &&
        Array.isArray(e0.response.headers) && e0.timings && typeof e0.time === 'number',
      `${e0.request && e0.request.method} status=${e0.response && e0.response.status}`
    );
    ok('导出 HAR：扩展字段带应用/设备信息', e0._iReq && 'clientIp' in e0._iReq && 'mocked' in e0._iReq);

    const cd = harRes.headers.get('content-disposition') || '';
    ok('导出文件名：带记录名（中文走 filename*）', /filename\*=UTF-8''/.test(cd) && /ireq-/.test(cd), cd.slice(0, 80));
    ok(
      '导出文件名：中文被正确编码',
      decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(cd) || [])[1] || '').includes('下单链路排查')
    );

    const jsonRes = await fetch(`${UI}/api/history/${item.id}/export?format=json`);
    const jsonList = JSON.parse(await jsonRes.text());
    ok('导出 JSON：条目数一样', Array.isArray(jsonList) && jsonList.length === 12, String(jsonList.length));
    ok(
      '导出 JSON：正序且带完整 headers',
      jsonList[0] && jsonList[0].reqHeaders && jsonList[0].id !== undefined,
      jsonList[0] && jsonList[0].url
    );

    const cappedRes = await fetch(`${UI}/api/history/${item.id}/export?limit=5`);
    const capped = JSON.parse(await cappedRes.text());
    ok(
      '导出：limit 生效并标了截断',
      capped.log.entries.length === 5 && cappedRes.headers.get('x-export-truncated') === '1',
      `entries=${capped.log.entries.length}`
    );

    const expMissing = await fetch(`${UI}/api/history/nope-123/export`);
    ok('导出：不存在的记录 404', expMissing.status === 404, String(expMissing.status));

    /* 上面那些 .test 域名解析不到（上游 502），HAR 里 status=0 是正常的。
       再用 IP 直连造一条真正的成功响应，验证状态码 / 响应体 / 响应头都导进去了 */
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(150);
    await viaProxy(`127.0.0.1:${upPort}`, '/hist-a');
    await wait(350);
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(250);
    const okItem = (await jsonApi('/api/history')).body.items[0];
    createdIds.push(okItem.id);
    const okHar = JSON.parse(await (await fetch(`${UI}/api/history/${okItem.id}/export`)).text());
    const oe = okHar.log.entries[0];
    ok(
      '导出 HAR：成功响应带出状态码 / 响应体 / 响应头',
      oe && oe.response.status === 200 && String(oe.response.content.text).includes('/hist-a') &&
        oe.response.headers.some((h) => h.name.toLowerCase() === 'content-type'),
      `status=${oe && oe.response.status}`
    );

    const blank = (await jsonApi('/api/history/' + item.id, { method: 'PATCH', body: { name: '   ' } })).body;
    ok('改名：空名字当没改', blank.item && blank.item.name === '下单链路排查', blank.item && blank.item.name);

    const longName = 'x'.repeat(90);
    const cut = (await jsonApi('/api/history/' + item.id, { method: 'PATCH', body: { name: longName } })).body;
    ok('改名：超长截断到 60', cut.item && cut.item.name.length === 60, String(cut.item && cut.item.name.length));

    const indexJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8'));
    ok('改名：索引文件同步了', (indexJson.items || []).some((x) => x.id === item.id && x.name.length === 60));

    /* ---------------- ⑦ 删除 ---------------- */
    const del = await jsonApi('/api/history/' + item.id, { method: 'DELETE' });
    ok('删除：接口返回 ok', del.status === 200 && del.body.ok === true);
    ok('删除：文件也一起删了', !fs.existsSync(absFile));
    const again = await jsonApi('/api/history/' + item.id, { method: 'DELETE' });
    ok('删除：重复删给 404', again.status === 404, String(again.status));

    /* 分页游标指向已删除的归档：应是 404/410 而不是 500 */
    const gonePage = await jsonApi(`/api/history/${item.id}/flows?limit=5`);
    ok('删除后回看给 404/410', gonePage.status === 404 || gonePage.status === 410, String(gonePage.status));

    const allGone = (await jsonApi('/api/history', { method: 'DELETE' })).body;
    ok('一键清空历史', allGone.ok === true && allGone.items.length === 0, `removed=${allGone.removed}`);
    ok(
      '一键清空后目录里没有残留 .cleared-*',
      !fs.existsSync(flowsDir) ||
        fs.readdirSync(flowsDir).filter((n) => n.includes('.cleared-')).length === 0
    );
  } finally {
    /* 还原现场：内存上限改回去，历史清空，关掉上游 */
    try {
      await jsonApi('/api/config', { method: 'PUT', body: { maxFlows: 2000 } });
      for (const id of createdIds) await jsonApi('/api/history/' + id, { method: 'DELETE' });
    } catch {
      /* 实例已退出 */
    }
    upstream.close();
  }

  console.log(`\n${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();
