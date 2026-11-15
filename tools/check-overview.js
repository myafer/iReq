'use strict';

/**
 * 自检：会话总览 + Markdown 报告
 * ---------------------------------------------------------------------------
 * ① 口径：错误 = 连不上 + 5xx，4xx 单列；进行中计入总数但不进耗时与百分位
 * ② 百分位与性能视图同源（同一批数据要给出同一个 P95，否则两个页面互相打脸）
 * ③ 分组：接口按 P95 降序、错误率分母是已完成、域名计数、最慢降序
 * ④ 报告：概要 / 接口 / 失败 / 最慢 / 域名 / 状态各段齐全，表格竖线被转义
 * ⑤ 报告：脱敏生效（URL 打码、按条数去重计数、末尾注明），关掉后恢复原值
 * ⑥ 接口：/api/overview 与 /api/overview/report.md，筛选条件透传并写进报告
 * ⑦ 界面：六张卡、状态条、点域名 / 接口行筛列表、点最慢跳详情、复制 Markdown、
 *    英文模式零残留、面板不横向溢出
 *
 * 会造几条流量并改脱敏配置，结束时恢复配置、删掉自己造的流量与历史。
 */
const http = require('http');
const { build, toMarkdown } = require('../src/overview');
const { aggregate } = require('../src/perf');
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
  return { status: res.status, body, headers: res.headers };
};

function viaProxy(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method: opts.method || 'GET',
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}`, ...(opts.headers || {}) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const now = Date.now();
const mk = (id, o = {}) => ({
  id,
  ts: now - Number(id) * 1000,
  method: 'GET',
  url: `https://api.example.com/v1/feed?token=SECRET-${id}&id=${id}`,
  path: `/v1/feed?token=SECRET-${id}`,
  host: 'api.example.com',
  route: 'GET /v1/feed',
  status: 200,
  duration: 100,
  reqSize: 100,
  resSize: 1000,
  resContentType: 'application/json',
  ...o,
});

(async () => {
  /* ------------------------------------------------------------ ① 口径 */
  {
    const flows = [
      mk(1, { duration: 4000, status: 500, statusText: 'boom' }),
      mk(2, { duration: 200, status: 404 }),
      mk(3, { status: 0, error: 'ECONNRESET', duration: 30 }),
      mk(4, { pending: true, duration: undefined }),
      mk(5, { duration: 900 }),
    ];
    const ov = build(flows, {});
    ok('总数含进行中', ov.counts.total === 5 && ov.counts.completed === 4);
    ok('错误 = 5xx + 连不上', ov.counts.errors === 2 && ov.counts.server === 1 && ov.counts.noResponse === 1, ov.counts.errors);
    ok('4xx 单独计数', ov.counts.client === 1);
    ok('错误率分母是已完成', ov.counts.errorRate === 50, ov.counts.errorRate);
    ok('进行中不进耗时', ov.duration.max === 4000 && ov.duration.p50 === 200, `${ov.duration.p50}/${ov.duration.max}`);
    const perf = aggregate(flows, { by: 'route' });
    ok('P95 与性能视图同源', ov.duration.p95 === perf.totals.p95, `${ov.duration.p95} vs ${perf.totals.p95}`);
    ok('P50 与性能视图同源', ov.duration.p50 === perf.totals.p50, `${ov.duration.p50} vs ${perf.totals.p50}`);
    // 传输量含进行中的请求：它确实已经传了字节，排除掉会低估带宽
    const allSum = flows.reduce((a, f) => a + f.resSize, 0);
    ok('传输量含进行中的字节', ov.bytes.res === allSum, ov.bytes.res);
    ok('空输入不炸', build([]).counts.total === 0 && build(null).routes.length === 0);
  }

  /* ------------------------------------------------------------ ③ 分组 */
  {
    const flows = [
      mk(1, { route: 'GET /a', duration: 500 }),
      mk(2, { route: 'GET /a', duration: 100, status: 500 }),
      mk(3, { route: 'GET /b', duration: 1200 }),
    ];
    const ov = build(flows, {});
    ok('接口按 P95 降序', ov.routes[0].route === 'GET /b', ov.routes.map((r) => r.route).join(','));
    const a = ov.routes.find((r) => r.route === 'GET /a');
    ok('接口错误数与错误率', a.errors === 1 && a.errorRate === 50, `${a.errors}/${a.errorRate}`);
    ok('最慢请求降序', ov.slowest[0].duration === 1200);
    ok('状态分布带连不上', build([mk(1, { status: 0, error: 'x' })]).status.some((s) => s.key === 'ERR'));
  }

  /* ------------------------------------------------------------ ④⑤ 报告 */
  {
    const flows = [mk(1, { duration: 4000, status: 500, statusText: 'boom|pipe' }), mk(2, { duration: 90 })];
    const ov = build(flows, { version: '9.9.9', redact: { enabled: true } });
    const md = toMarkdown(ov, { title: 'iReq 抓包报告', filters: ['域名 api.example.com', '仅错误'] });
    for (const [name, needle] of [
      ['标题', '# iReq 抓包报告'],
      ['筛选', '**筛选**：域名 api.example.com · 仅错误'],
      ['概要', '## 概要'],
      ['接口段', '## 接口'],
      ['失败段', '## 失败的请求'],
      ['最慢段', '## 最慢的请求'],
      ['域名段', '## 域名'],
      ['状态分布', '## 状态分布'],
      ['版本', '9.9.9'],
    ]) {
      ok(`报告含${name}`, md.includes(needle));
    }
    ok('表格竖线被转义', md.includes('boom\\|pipe'));
    ok('URL 已打码', !md.includes('SECRET-1') && /REDACTED/.test(md));
    ok('打码处数按条数去重', ov.redactions === 2, ov.redactions);
    ok('报告末尾注明打码', /已按脱敏配置打码 2 处/.test(md));
    const plain = build(flows, { redact: { enabled: false } });
    ok('关掉脱敏恢复原值', toMarkdown(plain, {}).includes('SECRET-1') && plain.redactions === 0);
    const noErr = build([mk(7, { status: 500, statusText: '' })], {});
    ok('空说明显示破折号', /\| 500 \| [^|]*\| — \|/.test(toMarkdown(noErr, {})));
    const many = build(
      Array.from({ length: 20 }, (_, i) => mk(i + 1, { route: `GET /r${i}`, duration: 10 + i })),
      {}
    );
    ok('接口最多列 10 个并标截断', many.routes.length === 10 && many.truncated === true, many.routes.length);
  }

  /* ------------------------------------------------------------ 造流量 */
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/slow') {
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":1}');
      }, 500);
    }
    if (u === '/err') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('boom');
    }
    if (u === '/nf') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":1}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  for (let i = 0; i < 3; i++) await viaProxy(port, `/fast?token=SECRET-QUERY&i=${i}`);
  await viaProxy(port, '/slow');
  await viaProxy(port, '/err');
  await viaProxy(port, '/nf');
  await wait(300);

  /* ------------------------------------------------------------ ⑥ 接口 */
  const ovRes = await jsonApi('/api/overview?limit=200');
  ok('/api/overview 有计数与分组', ovRes.body && ovRes.body.counts && Array.isArray(ovRes.body.routes) && ovRes.body.routes.length > 0);
  ok('/api/overview 给了内存条数', typeof ovRes.body.inMemory === 'number' && ovRes.body.inMemory > 0);
  ok('/api/overview 统计到 500', ovRes.body.counts.server >= 1 && ovRes.body.counts.client >= 1, `${ovRes.body.counts.server}/${ovRes.body.counts.client}`);

  const byHost = await jsonApi('/api/overview?host=127.0.0.1&limit=200');
  ok('按域名筛选生效', byHost.body.counts.total <= ovRes.body.counts.total && byHost.body.counts.total > 0);

  const mdRes = await fetch(UI + '/api/overview/report.md?limit=200');
  const mdText = await mdRes.text();
  ok('报告 content-type 是 markdown', /text\/markdown/.test(mdRes.headers.get('content-type') || ''));
  ok('报告带下载文件名', /attachment; filename="ireq-report-/.test(mdRes.headers.get('content-disposition') || ''));
  ok('报告内容像报告', mdText.startsWith('# iReq 抓包报告') && mdText.includes('## 概要'));
  ok('报告默认已脱敏', !mdText.includes('SECRET-QUERY'));
  ok('报告响应头给打码数', Number(mdRes.headers.get('x-ireq-redacted') || 0) > 0);

  const filtered = await fetch(UI + '/api/overview/report.md?host=127.0.0.1&status=5xx&limit=200');
  const filteredText = await filtered.text();
  ok('报告写明筛选条件', filteredText.includes('**筛选**：域名 127.0.0.1 · 状态 5xx'));

  /* ------------------------------------------------------------ ⑦ 界面 */
  {
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: UI });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');

    await page.click('#btnMore');
    await page.click('#btnOverview');
    await page.waitForSelector('#modalOverview:not([hidden])');
    await page.waitForTimeout(700);

    const cards = await page.$$eval('#ovCards .ov-card', (els) => els.length);
    ok('六张概览卡', cards === 6, cards);
    const cardText = await page.$eval('#ovCards', (el) => el.innerText.replace(/\s+/g, ' '));
    ok('卡片显示请求数与错误', /\d+/.test(cardText) && /5xx/.test(cardText), cardText.slice(0, 80));

    const barSegs = await page.$$eval('#ovStatus .ov-bar i', (els) => els.length);
    ok('状态条有分段', barSegs >= 2, barSegs);
    const routeRows = await page.$$eval('#ovRoutes tbody tr', (els) => els.length);
    ok('接口表有行', routeRows > 0, routeRows);
    const slowRows = await page.$$eval('#ovSlow .perf-slow-row', (els) => els.length);
    ok('最慢请求列表有行', slowRows > 0, slowRows);

    // 布局：不横向溢出，六张卡在同一行
    const box = await page.$eval('.ov-dialog', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    ok('面板不横向溢出', box.sw <= box.cw + 1, `${box.sw}/${box.cw}`);
    const tops = await page.$$eval('#ovCards .ov-card', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok('六张卡排成一行', new Set(tops).size === 1, tops.join(','));

    // 复制 Markdown
    await page.click('#ovCopy');
    await page.waitForTimeout(600);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('复制到剪贴板的是报告', clip.startsWith('# iReq 抓包报告') && clip.includes('## 概要'), clip.slice(0, 40));
    ok('剪贴板内容已脱敏', !clip.includes('SECRET-QUERY'));

    // 点接口表一行 → 列表被筛到该接口
    const firstRoute = await page.$eval('#ovRoutes tbody tr', (el) => el.dataset.ovRoute);
    await page.click('#ovRoutes tbody tr');
    await page.waitForTimeout(600);
    const chip = await page.$$eval('#chips .chip', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
    ok('点接口行筛选到列表', chip.some((c) => c.includes(firstRoute)), chip.join(' | '));
    // 清掉筛选
    const clearBtn = await page.$('#chips .chip [data-clear]');
    if (clearBtn) await clearBtn.click();
    await page.waitForTimeout(400);

    // 点最慢请求 → 打开详情
    await page.click('#btnMore');
    await page.click('#btnOverview');
    await page.waitForSelector('#modalOverview:not([hidden])');
    await page.waitForTimeout(600);
    await page.click('#ovSlow .perf-slow-row');
    await page.waitForTimeout(700);
    const detailShown = await page.$eval('#detail', (el) => el.innerText.length > 0).catch(() => false);
    ok('点最慢请求跳到详情', detailShown);

    // 英文模式
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await page.waitForTimeout(700);
    await page.click('#btnMore');
    await page.click('#btnOverview');
    await page.waitForSelector('#modalOverview:not([hidden])');
    await page.waitForTimeout(700);
    const en = await page.$eval('#modalOverview', (el) => el.innerText.replace(/\s+/g, ' '));
    ok('英文面板零残留中文', !/[\u4e00-\u9fff]/.test(en), (en.match(/[\u4e00-\u9fff]/g) || []).join(''));
    await page.screenshot({ path: '/tmp/overview-en.png' });
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await wait(200);
    await browser.close();
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
  }

  /* ------------------------------------------------------------ 清理 */
  srv.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  await wait(300);
  const hist = (await jsonApi('/api/history')).body;
  const item = (hist.items || [])[0];
  if (item) await jsonApi('/api/history/' + item.id, { method: 'DELETE' });

  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exit(1);
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
