'use strict';

/**
 * 自检：详情面板按需打开 / 分组栏与表头等高 / 详情页签与顶部页签同款 /
 *       头部↔正文可上下拖 / 长域名折叠展开
 * ---------------------------------------------------------------------------
 * ① 未选中请求：详情不占位、列表吃满宽度、第二根分割线一起隐藏
 * ② 选中：详情自动打开；点 ✕ 收起后列表又吃满；再点一行又能打开
 * ③ 分组栏标题与列表表头同高同底边（含字号缩放两档）
 * ④ 详情里「结构化 / 原始」页签与顶部页签同字号、同内边距、同样有下划线
 * ⑤ 请求页头部与正文之间的分割线：拖动改高度、写 localStorage、刷新保持、双击复位、方向键微调
 * ⑥ 长域名：被截断的行悬停后可展开看全，再点收起；没截断的行点字仍然是选中
 *
 * 会造两条长域名流量（域名映射 + 本地假上游），结束删掉自己造的流量与映射。
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');

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

const LONG_HOST = 'assets-cdn-eu-west-1.very-long-subdomain.demo.example';
const SHORT_HOST = 'cdn.demo.example';

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** 走代理发一条明文请求：路径必须是绝对地址，Host 头决定记录里的域名 */
function viaProxy(host, path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: `http://${host}${path}`, headers: { Host: host } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.end();
  });
}

(async () => {
  const up = await startUpstream();
  const uport = up.address().port;
  const hadConfig = (await jsonApi('/api/hostmap')).body || {};

  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  try {
    await jsonApi('/api/hostmap', {
      method: 'PUT',
      body: {
        enabled: true,
        rules: [
          { from: LONG_HOST, to: `127.0.0.1:${uport}` },
          { from: SHORT_HOST, to: `127.0.0.1:${uport}` },
        ],
      },
    });
    await viaProxy(LONG_HOST, '/static/v2/chunks/app.4f3c9a1b.js?build=2026-11-16');
    await viaProxy(SHORT_HOST, '/pixel.gif');

    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    // 首启欢迎层会挡住点击（新装的机器上跑自检）
    await page.evaluate(() => {
      const w = document.querySelector('#modalWelcome');
      if (w && !w.hidden) w.hidden = true;
    });
    await wait(400);

    const geo = () =>
      page.evaluate(() => {
        const b = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), bottom: Math.round(r.bottom) };
        };
        const shell = document.querySelector('#shell');
        return {
          noDetail: shell.classList.contains('no-detail'),
          list: b('.listpane'),
          layout: b('.layout'),
          detail: b('#detail'),
          splitList: b('#splitList'),
          sideHead: b('.side-head'),
          listHead: b('.listhead'),
          overflowX: document.documentElement.scrollWidth - innerWidth,
        };
      });

    /* ------------------------------------------------ ① 默认不占位 */
    const g0 = await geo();
    console.log('未选中:', JSON.stringify(g0));
    ok('未选中时详情不占位', g0.noDetail && g0.detail.h === 0);
    ok('未选中时列表吃满宽度', g0.list.w >= g0.layout.w - 2);
    ok('未选中时第二根分割线隐藏', g0.splitList.h === 0);
    ok('未选中时无横向溢出', g0.overflowX <= 0);

    /* ------------------------------- ③ 分组栏与表头等高（两档字号） */
    for (const scale of [1.04, 1.3]) {
      await page.evaluate((s) => document.documentElement.style.setProperty('--ui-scale', String(s)), scale);
      await wait(150);
      const g = await geo();
      ok(`分组栏与表头同高 @${scale}`, g.sideHead.h === g.listHead.h && g.sideHead.bottom === g.listHead.bottom,
        `${g.sideHead.h}/${g.listHead.h} bottom ${g.sideHead.bottom}/${g.listHead.bottom}`);
    }
    await page.evaluate(() => document.documentElement.style.removeProperty('--ui-scale'));
    await wait(150);

    /* -------------------------------------------- ② 选中打开 / ✕ 关闭 */
    await page.click('.row');
    await wait(500);
    const gOpen = await geo();
    ok('选中后详情自动打开', !gOpen.noDetail && gOpen.detail.w > 260);
    ok('选中后第二根分割线出现', gOpen.splitList.w === 1);

    await page.click('#detailClose');
    await wait(300);
    const gClosed = await geo();
    ok('点 ✕ 后详情收起', gClosed.noDetail && gClosed.detail.h === 0);
    ok('关闭后列表吃满宽度', gClosed.list.w >= gClosed.layout.w - 2);

    await page.click('.row');
    await wait(500);
    ok('再点一行又能打开', !(await geo()).noDetail);

    /* ------------------------- ④ 详情页签与顶部页签同一套外观 */
    await page.click('#tabs button[data-tab="request"]');
    await wait(400);
    const tabs = await page.evaluate(() => {
      const style = (el) => {
        const c = getComputedStyle(el);
        return { font: c.fontSize, pad: c.padding, border: c.borderBottomWidth, lh: c.lineHeight };
      };
      const top = document.querySelector('#tabs button[data-tab="request"]');
      const sub = document.querySelector('.sec-tabs button');
      return {
        top: top && style(top),
        sub: sub && style(sub),
        subCount: document.querySelectorAll('.sec-tabs button').length,
        subOn: (document.querySelector('.sec-tabs button.on') || {}).textContent,
        hsplit: !!document.querySelector('#dSplit'),
      };
    });
    console.log('页签:', JSON.stringify(tabs));
    ok('正文里有页签（结构化 / 原始）', tabs.subCount === 2, tabs.subCount);
    ok('页签字号与顶部页签一致', tabs.top && tabs.sub && tabs.top.font === tabs.sub.font, `${tabs.top && tabs.top.font} / ${tabs.sub && tabs.sub.font}`);
    ok('页签内边距与顶部页签一致', tabs.top && tabs.sub && tabs.top.pad === tabs.sub.pad, `${tabs.top && tabs.top.pad} / ${tabs.sub && tabs.sub.pad}`);
    ok('当前视图页签有选中态', tabs.subOn === '结构化', tabs.subOn);

    /* ---------------------------- ⑤ 头部 ↔ 正文：可上下拖 */
    ok('请求页有上下分割线', tabs.hsplit);
    const splitState = () =>
      page.evaluate(() => {
        const top = document.querySelector('.sec.split-top');
        const bar = document.querySelector('#dSplit');
        return {
          topH: top ? Math.round(top.getBoundingClientRect().height) : null,
          barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
          saved: localStorage.getItem('reqlite-detail-split'),
          cursor: bar ? getComputedStyle(bar).cursor : '',
        };
      });
    const s0 = await splitState();
    const box = await page.locator('#dSplit').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await wait(250);
    const s1 = await splitState();
    console.log('分割线:', JSON.stringify({ s0, s1 }));
    ok('分割线存在且可上下拖（光标 row-resize）', s0.barH >= 6 && s0.cursor === 'row-resize', `${s0.barH}px ${s0.cursor}`);
    ok('拖动把上半区拉高', s1.topH - s0.topH >= 100, `${s0.topH} → ${s1.topH}`);
    ok('拖完记住高度', Number(s1.saved) === s1.topH, s1.saved);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.click('.row');
    await wait(600);
    await page.click('#tabs button[data-tab="request"]');
    await wait(400);
    const s2 = await splitState();
    ok('刷新后高度保持', Math.abs(s2.topH - s1.topH) <= 2, `${s2.topH} vs ${s1.topH}`);

    await page.dblclick('#dSplit');
    await wait(250);
    const s3 = await splitState();
    ok('双击复位比例', s3.saved === null && s3.topH !== s2.topH, `${s2.topH} → ${s3.topH} saved=${s3.saved}`);

    await page.locator('#dSplit').focus();
    await page.keyboard.press('ArrowDown');
    await wait(200);
    const s4 = await splitState();
    ok('方向键可微调 16px', Math.abs(s4.topH - s3.topH - 16) <= 2, `${s3.topH} → ${s4.topH}`);

    /* ------------------------------------ ⑥ 长域名折叠 / 展开 */
    // 把列表压窄，逼出截断
    await page.evaluate(() => document.documentElement.style.setProperty('--list-w', '380px'));
    await wait(300);
    const longRow = page.locator(`.row:has-text("${LONG_HOST}")`).first();
    await longRow.hover();
    await wait(200);
    const trunc = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.row')];
      const long = rows.find((r) => (r.textContent || '').includes('assets-cdn-eu-west-1'));
      const short = rows.find((r) => (r.textContent || '').includes('cdn.demo.example') && !(r.textContent || '').includes('assets-cdn'));
      const hl = long && long.querySelector('.cellurl .h .hl');
      const shl = short && short.querySelector('.cellurl .h .hl');
      return {
        longTrunc: long ? long.dataset.trunc : null,
        longHl: hl ? { scroll: hl.scrollWidth, client: hl.clientWidth } : null,
        shortTrunc: short ? short.dataset.trunc || '' : 'missing',
        shortHl: shl ? { scroll: shl.scrollWidth, client: shl.clientWidth } : null,
        longH: long ? Math.round(long.getBoundingClientRect().height) : null,
      };
    });
    console.log('截断判定:', JSON.stringify(trunc));
    ok('长域名行判定为可展开', trunc.longTrunc === '1', `${trunc.longHl && trunc.longHl.scroll} > ${trunc.longHl && trunc.longHl.client}`);
    ok('短域名行不给展开入口', trunc.shortTrunc === '' || trunc.shortHl.scroll <= trunc.shortHl.client + 1, trunc.shortTrunc);

    // 先选中另一条（短域名行），这样能验证「展开域名不会把选中挪走」
    await page.click(`.row:has-text("${SHORT_HOST}")`, { position: { x: 5, y: 5 } });
    await wait(400);
    await page.click(`.row:has-text("${LONG_HOST}") .cellurl .h`);
    await wait(300);
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.row')];
      const row = rows.find((r) => (r.textContent || '').includes('assets-cdn-eu-west-1'));
      const short = rows.find((r) => (r.textContent || '').includes('cdn.demo.example') && !(r.textContent || '').includes('assets-cdn'));
      const hl = row.querySelector('.cellurl .h .hl');
      return {
        open: row.classList.contains('host-open'),
        h: Math.round(row.getBoundingClientRect().height),
        clipped: hl.scrollWidth > hl.clientWidth + 1,
        selected: row.classList.contains('sel'),
        shortStillSelected: short ? short.classList.contains('sel') : false,
      };
    });
    ok('点域名展开显示全部', opened.open && !opened.clipped, `h=${opened.h}`);
    ok('展开时不会顺手选中这条', !opened.selected && opened.shortStillSelected);

    await page.click(`.row:has-text("${LONG_HOST}") .cellurl .h`);
    await wait(300);
    const reclosed = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.textContent || '').includes('assets-cdn-eu-west-1'));
      const hl = row.querySelector('.cellurl .h .hl');
      return { open: row.classList.contains('host-open'), clipped: hl.scrollWidth > hl.clientWidth + 1 };
    });
    ok('再点收起', !reclosed.open && reclosed.clipped);

    // 没截断的行：点域名那行还是「选中」
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.evaluate(() => document.documentElement.style.removeProperty('--list-w'));
    await wait(400);
    await page.click(`.row:has-text("${SHORT_HOST}")`, { position: { x: 5, y: 5 } });
    await wait(500);
    const shortSel = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.textContent || '').includes('cdn.demo.example'));
      return row ? row.classList.contains('sel') : false;
    });
    ok('短域名行点哪都是选中', shortSel);

    ok('无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    await jsonApi('/api/hostmap', {
      method: 'PUT',
      body: { enabled: hadConfig.enabled === true, rules: hadConfig.rules || [] },
    }).catch(() => {});
    up.close();
    await jsonApi('/api/flows', { method: 'DELETE' }).catch(() => {});
    await browser.close();
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((err) => {
  console.error('自检异常:', err && err.message);
  process.exitCode = 1;
});
