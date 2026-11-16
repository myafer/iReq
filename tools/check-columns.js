'use strict';

/**
 * 自检：派生列
 * ---------------------------------------------------------------------------
 * ① 路径解析：点号 / 下标 / $ 前缀 / req. 前缀 / h: 头；过滤表达式等非法写法要判错
 * ② 取值：数组下标、缺字段、类型格式化（数字 / 布尔 / 对象 / 长文本截断）
 * ③ 配置：最多 4 列、没名字或没路径的不收、id 自动补
 * ④ 记录：新抓的流量带 derived，改配置后已有流量立刻重算，清空后字段消失
 * ⑤ 接口：GET / PUT /api/columns 往返
 * ⑥ 界面：表头与行里出现对应列，配置面板能加列并保存
 *
 * 会改列配置并清空流量，结束时恢复原配置、删掉自己造的历史记录。
 */
const http = require('http');
const { parsePath, applyColumns, normalizeColumns } = require('../src/columns');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ ①-③ 单元 */
{
  ok('点号路径', JSON.stringify(parsePath('result.traceId')) === '{"kind":"json","side":"res","tokens":["result","traceId"]}');
  ok('数组下标', JSON.stringify(parsePath('data.items[0].id')) === '{"kind":"json","side":"res","tokens":["data","items",0,"id"]}');
  ok('$ 前缀可省可写', parsePath('$.a.b') && parsePath('$.a.b').tokens.join('.') === 'a.b');
  ok('.0 等价于 [0]', parsePath('a.0.b') && parsePath('a.0.b').tokens[1] === 0);
  ok('req. 前缀切到请求体', parsePath('req.body.userId').side === 'req');
  ok('h: 取响应头', parsePath('h:X-Version').kind === 'header' && parsePath('h:X-Version').name === 'x-version');
  ok('过滤表达式判非法', parsePath('a[?(b)]') === null);
  ok('空路径判非法', parsePath('') === null && parsePath('   ') === null);

  const flow = {
    reqBody: JSON.stringify({ userId: 'u1' }),
    resBody: JSON.stringify({
      result: { traceId: 't1', ok: true, nested: { a: 1 } },
      data: { items: [{ id: 7 }, { id: 8 }] },
      long: 'x'.repeat(200),
    }),
    resHeaders: { 'x-version': '9.9.9' },
  };
  const cols = normalizeColumns([
    { name: 'Trace', path: 'result.traceId' },
    { name: 'ID', path: 'data.items[1].id' },
    { name: 'Ver', path: 'h:x-version' },
    { name: 'User', path: 'req.body.userId' },
  ]);
  const d = applyColumns(flow, cols);
  ok('四列都取到值', d && Object.keys(d).length === 4, JSON.stringify(d));
  ok('数组第二项取到 8', d[cols[1].id] === '8', d[cols[1].id]);
  ok('布尔转成 true/false', applyColumns({ resBody: '{"a":false}' }, [{ id: 'a', path: 'a' }]).a === 'false');
  ok('对象压成一行 JSON', /^\{"a":1\}$/.test(applyColumns({ resBody: '{"o":{"a":1}}' }, [{ id: 'o', path: 'o' }]).o));
  ok('长文本截断成 …', applyColumns({ resBody: '{"s":"' + 'y'.repeat(200) + '"}' }, [{ id: 's', path: 's' }]).s.endsWith('…'));
  ok('缺字段给空串', applyColumns({ resBody: '{}' }, [{ id: 'z', path: 'no.such' }]).z === '');
  ok('非 JSON body 不炸', applyColumns({ resBody: 'not json' }, [{ id: 'z', path: 'a' }]).z === '');

  const many = normalizeColumns(
    Array.from({ length: 6 }, (_, i) => ({ name: 'c' + i, path: 'a.b' }))
  );
  ok('最多收 4 列', many.length === 4, many.length);
  ok('没名字 / 没路径的被丢掉', normalizeColumns([{ name: '', path: 'a' }, { name: 'b', path: '' }, { name: 'c', path: 'a.b' }]).length === 1);
  const ids = normalizeColumns([{ name: 'a', path: 'x' }, { name: 'b', path: 'y' }]).map((c) => c.id);
  ok('id 自动补且不重复', ids[0] !== ids[1], ids.join(','));
}

/* ------------------------------------------------------------ ④⑤ 接口 */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-version': '2.3.1' });
      res.end(JSON.stringify({ result: { traceId: 'trace-abc' }, data: { items: [{ id: 42 }] }, ok: true }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function viaProxy(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function waitFlow(path, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonApi('/api/flows?limit=50');
    const hit = (Array.isArray(list.body) ? list.body : []).find((f) => String(f.path).startsWith(path));
    if (hit) return hit;
    await wait(80);
  }
  return null;
}

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const before = await historyIds();
  const orig = await jsonApi('/api/columns');
  const origCols = (orig.body && orig.body.columns) || [];
  const srv = await startUpstream();
  const port = srv.address().port;

  // 先抓一条没有派生列的流量
  await viaProxy(port, '/json-col');
  await wait(150);
  const flow0 = await waitFlow('/json-col');
  ok('抓到测试流量', !!flow0, flow0 && flow0.id);
  ok('没配列时 derived 为空', !flow0 || !flow0.derived);

  // 保存 4 列
  const saved = await jsonApi('/api/columns', {
    method: 'PUT',
    body: {
      columns: [
        { name: 'Trace', path: 'result.traceId' },
        { name: 'ID', path: 'data.items[0].id' },
        { name: 'Ver', path: 'h:x-version' },
        { name: 'Ok', path: 'ok' },
      ],
    },
  });
  ok('PUT 返回规整后的列', saved.status === 200 && saved.body.columns.length === 4, saved.body && saved.body.columns.length);
  const cfg = await jsonApi('/api/columns');
  ok('GET 拿回同一份配置', JSON.stringify(cfg.body.columns) === JSON.stringify(saved.body.columns));

  // 已有流量被重算
  const listAfter = await jsonApi('/api/flows?limit=50');
  const hit = (listAfter.body || []).find((f) => f.id === (flow0 && flow0.id));
  ok('改配置后已有流量立即补上派生列', !!(hit && hit.derived), hit && JSON.stringify(hit.derived));
  const colIds = saved.body.columns.map((c) => c.id);
  ok('四个值都对', hit && hit.derived[colIds[0]] === 'trace-abc' && hit.derived[colIds[1]] === '42' && hit.derived[colIds[2]] === '2.3.1' && hit.derived[colIds[3]] === 'true',
    hit && JSON.stringify(hit.derived));

  // 新流量也带
  await viaProxy(port, '/json-col-2');
  await wait(200);
  const flow2 = await waitFlow('/json-col-2');
  ok('新抓的流量同样带派生列', !!(flow2 && flow2.derived && flow2.derived[colIds[0]] === 'trace-abc'), flow2 && JSON.stringify(flow2.derived));

  // 非法路径整条被拒
  const bad = await jsonApi('/api/columns', { method: 'PUT', body: { columns: [{ name: 'x', path: 'a[?(b)]' }] } });
  ok('非法路径不落库', bad.body.columns.length === 0, JSON.stringify(bad.body.columns));

  // 清空后字段消失
  const cleared = await jsonApi('/api/columns', { method: 'PUT', body: { columns: [] } });
  ok('清空返回空列', cleared.body.columns.length === 0);
  const listCleared = await jsonApi('/api/flows?limit=50');
  ok('清空后行上的 derived 被摘掉', (listCleared.body || []).every((f) => !f.derived));

  /* ---------------- ⑥ 界面 ---------------- */
  {
    await jsonApi('/api/columns', {
      method: 'PUT',
      body: { columns: [{ name: 'Trace', path: 'result.traceId' }, { name: 'Ver', path: 'h:x-version' }] },
    });
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');
    const heads = await page.$$eval('.listhead .c-dcol', (els) => els.map((e) => e.textContent.trim()));
    ok('表头出现两列', heads.join(',') === 'Trace,Ver', heads.join(','));
    const cells = await page.$$eval('.row .c-dcol', (els) => els.map((e) => e.textContent.trim()));
    ok('行里带出列值', cells.includes('trace-abc') && cells.includes('2.3.1'), cells.slice(0, 8).join(','));
    // 配置面板
    await page.click('#btnMore');
    await page.click('#btnCols');
    await page.waitForSelector('#modalCols:not([hidden])');
    const rows = await page.$$('#colRules .col-rule');
    ok('配置面板列出已有列', rows.length === 2, rows.length);
    await page.click('#colAdd');
    await page.waitForTimeout(120);
    const rows2 = await page.$$('#colRules .col-rule');
    ok('可以加一列', rows2.length === 3, rows2.length);
    await page.fill('#colRules .col-rule:last-child .col-name', 'ID');
    await page.fill('#colRules .col-rule:last-child .col-path', 'data.items[0].id');
    await page.click('#colSave');
    await page.waitForTimeout(500);
    const afterSave = await jsonApi('/api/columns');
    ok('保存后服务端有 3 列', afterSave.body.columns.length === 3, afterSave.body.columns.length);
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));

    /* 密度回归：派生列是往行里追加格子，一旦列模板写坏（例如 repeat(0, …)，
       0 不是合法重复次数，整条 grid-template-columns 会失效），行会塌成单列——
       方法 / 地址 / 状态 / 耗时各占一行，一屏只剩五六条。 */
    const geometry = () =>
      page.evaluate(() => {
        const row = document.querySelector('.row');
        const boxes = [...row.children].map((c) => c.getBoundingClientRect());
        const centers = boxes.map((b) => Math.round(b.top + b.height / 2));
        const lefts = boxes.map((b) => Math.round(b.left));
        return {
          centers,
          lefts,
          rowH: Math.round(row.getBoundingClientRect().height),
          headH: Math.round(document.querySelector('.listhead').getBoundingClientRect().height),
        };
      });

    const g2 = await geometry();
    ok('派生列与基础列在同一行（垂直中心对齐）', new Set(g2.centers).size === 1, g2.centers.join(','));
    // 这里已经有 3 列（面板里刚加了一列），派生列必须全部排在耗时右边且依次右移
    const tail = g2.lefts.slice(4);
    ok(
      '派生列依次排在耗时右侧',
      tail.length === 3 && tail.every((x, i) => x > g2.lefts[3] && (i === 0 || x > tail[i - 1])),
      g2.lefts.join(',')
    );
    ok('有派生列时行高仍是一行两行文的高度', g2.rowH < 80, g2.rowH);
    // 列多到放不下时表头允许折行，但不能塌成竖排
    ok('有派生列时表头最多两行', g2.headH < 70, g2.headH);

    await jsonApi('/api/columns', { method: 'PUT', body: { columns: [] } });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    const g0 = await geometry();
    ok('没有派生列时行不塌成单列', new Set(g0.centers).size === 1, g0.centers.join(','));
    ok('没有派生列时行高与加功能前一致', g0.rowH < 80, g0.rowH);
    ok('没有派生列时表头一行', g0.headH < 45, g0.headH);
    await browser.close();
  }

  /* ---------------- 清理 ---------------- */
  await jsonApi('/api/columns', { method: 'PUT', body: { columns: origCols } });
  srv.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  const after = await historyIds();
  for (const id of after) {
    if (!before.has(id)) await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((err) => {
  console.error('自检异常:', err && err.message);
  process.exitCode = 1;
});
