'use strict';

/** 自检：两根纵向分割线可拖拽 / 命中区 / 边界夹紧 / 持久化 / 复位 / 键盘 / 侧栏收起 / 窄屏 */
const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const { seedFlows } = require('./_seed');
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

(async () => {
  console.log('注入测试流量:', JSON.stringify(await seedFlows()));
  const browser = await chromium.launch({ executablePath: EXEC });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const checks = [];
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const geo = () =>
    page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.x * 100) / 100,
          right: Math.round(b.right * 100) / 100,
          w: Math.round(b.width * 100) / 100,
          h: Math.round(b.height * 100) / 100,
          hidden: el.hidden,
          display: getComputedStyle(el).display,
        };
      };
      return {
        side: r('#side'),
        splitSide: r('#splitSide'),
        layout: r('.layout'),
        list: r('.listpane'),
        splitList: r('#splitList'),
        detail: r('#detail'),
        overflowX: document.documentElement.scrollWidth - innerWidth,
        selection: String(window.getSelection()),
        resizing: document.body.classList.contains('resizing'),
      };
    });

  const drag = async (sel, dx, during) => {
    const b = await page.locator(sel).boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + Math.min(b.height / 2, 300);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 5 });
    if (during) await during();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  /* ------------------------------------------------------------ 初始形态 */
  const g0 = await geo();
  console.log('初始:', JSON.stringify(g0));
  checks.push(['两根分割条都存在且可见', g0.splitSide && g0.splitList && !g0.splitSide.hidden && !g0.splitList.hidden]);
  checks.push(['分割线是 1px 细线', near(g0.splitSide.w, 1, 0.6) && near(g0.splitList.w, 1, 0.6)]);
  checks.push(['分割条与三栏边界严丝合缝',
    near(g0.side.right, g0.splitSide.x) && near(g0.splitSide.right, g0.layout.x) &&
    near(g0.list.right, g0.splitList.x) && near(g0.splitList.right, g0.detail.x)]);
  checks.push(['初始无横向溢出', g0.overflowX <= 0]);
  checks.push(['默认栏宽合理', near(g0.side.w, 218, 2) && g0.list.w > 300 && g0.detail.w > 300]);

  // 命中区应该比 1px 视觉线宽：向左偏 3px 仍能抓到手柄
  const hit = await page.evaluate(() => {
    const b = document.querySelector('#splitList').getBoundingClientRect();
    const el = document.elementFromPoint(b.x - 3, b.y + 120);
    return el ? el.id || el.className : null;
  });
  console.log('线左 3px 命中:', hit);
  checks.push(['命中区向两侧扩展（好抓）', String(hit).includes('splitList')]);

  /* --------------------------------------------------------- 拖第一根线 */
  let mid = null;
  await drag('#splitSide', 80, async () => { mid = await geo(); });
  const g1 = await geo();
  console.log('拖动第一根 +80:', JSON.stringify(g1));
  checks.push(['第一根：分组边栏变宽', g1.side.w - g0.side.w >= 75 && g1.side.w - g0.side.w <= 85]);
  checks.push(['第一根：详情区仍在且够宽', g1.detail.w >= 260]);
  checks.push(['第一根：拖动中锁住光标/选中', mid && mid.resizing === true && mid.selection === '']);
  checks.push(['第一根：拖完释放拖拽态', g1.resizing === false]);
  checks.push(['第一根：边界仍连续', near(g1.side.right, g1.splitSide.x) && near(g1.splitSide.right, g1.layout.x)]);

  /* --------------------------------------------------------- 拖第二根线 */
  await drag('#splitList', 120);
  const g2 = await geo();
  console.log('拖动第二根 +120:', JSON.stringify(g2));
  checks.push(['第二根：请求列表变宽', g2.list.w - g1.list.w >= 110 && g2.list.w - g1.list.w <= 130]);
  checks.push(['第二根：详情区相应变窄', g1.detail.w - g2.detail.w >= 110]);
  checks.push(['第二根：边界仍连续', near(g2.list.right, g2.splitList.x) && near(g2.splitList.right, g2.detail.x)]);
  checks.push(['拖动后无横向溢出', g2.overflowX <= 0]);

  /* ------------------------------------------------------------- 持久化 */
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const g3 = await geo();
  console.log('刷新后:', JSON.stringify(g3));
  checks.push(['刷新后两根线宽度保持', near(g3.side.w, g2.side.w, 2) && near(g3.list.w, g2.list.w, 2)]);

  /* ------------------------------------------------------- 边界夹紧 */
  await drag('#splitList', 600);
  const gRight = await geo();
  console.log('第二根拖到极右:', JSON.stringify({ list: gRight.list.w, detail: gRight.detail.w }));
  checks.push(['向右夹紧：详情区不会被挤没', gRight.detail.w >= 258]);
  await drag('#splitList', -600);
  const gLeft = await geo();
  console.log('第二根拖到极左:', JSON.stringify({ list: gLeft.list.w, detail: gLeft.detail.w }));
  checks.push(['向左夹紧：列表不会被挤没', gLeft.list.w >= 258]);
  checks.push(['夹紧后无横向溢出', gRight.overflowX <= 0 && gLeft.overflowX <= 0]);

  /* ------------------------------------------------------- 键盘 + 复位 */
  await page.locator('#splitList').focus();
  await page.keyboard.press('ArrowRight');
  const gKey = await geo();
  checks.push(['方向键可微调 16px', near(gKey.list.w - gLeft.list.w, 16, 2)]);
  await page.keyboard.press('Home');
  const gHome = await geo();
  console.log('键盘微调 / Home:', JSON.stringify({ key: gKey.list.w, home: gHome.list.w }));
  checks.push(['Home 复位列表宽度到默认值', !near(gHome.list.w, gKey.list.w, 2) && near(gHome.list.w, gHome.layout.w * 0.4, 3)]);

  await page.dblclick('#splitSide');
  await page.dblclick('#splitList');
  const gReset = await geo();
  console.log('双击复位:', JSON.stringify(gReset));
  checks.push(['双击第一根恢复默认 218px', near(gReset.side.w, 218, 2)]);
  checks.push(['双击第二根恢复默认 40%', near(gReset.list.w, gReset.layout.w * 0.4, 3)]);
  checks.push(['复位后仍无横向溢出', gReset.overflowX <= 0]);

  /* ------------------------------------------------- 收起边栏 / 窄屏 */
  await page.click('#sideHide');
  await page.waitForTimeout(250);
  const gHide = await geo();
  checks.push(['收起边栏时第一根线一起隐藏', gHide.side.hidden && gHide.splitSide.hidden]);
  checks.push(['收起后第二根线仍可拖', !gHide.splitList.hidden && gHide.splitList.w === 1]);
  await page.click('#sideShow');
  await page.waitForTimeout(250);
  const gShow = await geo();
  checks.push(['展开后第一根线恢复', !gShow.side.hidden && !gShow.splitSide.hidden]);
  checks.push(['展开后自定义宽度不丢', near(gShow.side.w, 218, 2)]);

  await page.setViewportSize({ width: 560, height: 820 });
  await page.waitForTimeout(400);
  const gNarrow = await geo();
  console.log('窄屏:', JSON.stringify({ splitSide: gNarrow.splitSide.display, splitList: gNarrow.splitList.display, overflowX: gNarrow.overflowX }));
  checks.push(['窄屏两根线隐藏（改上下布局）', gNarrow.splitSide.display === 'none' && gNarrow.splitList.display === 'none']);
  checks.push(['窄屏无横向溢出', gNarrow.overflowX <= 0]);
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.waitForTimeout(400);
  const gBack = await geo();
  checks.push(['回到宽屏两根线自动恢复', gBack.splitSide.display !== 'none' && gBack.splitList.display !== 'none']);

  checks.push(['无 JS 报错', errs.length === 0]);
  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (errs.length) console.log('errors:', errs);
  await browser.close();
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
