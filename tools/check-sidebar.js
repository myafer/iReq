'use strict';

/** 自检：分组边栏（收藏/设备/应用/域名/接口结构）、筛选、书签、收起、移动端抽屉 */
const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const { seedFlows } = require('./_seed');
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

(async () => {
  console.log('注入测试流量:', JSON.stringify(await seedFlows()));
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errs = [];
  const checks = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const groups = await page.$$eval('.sgroup', (els) =>
    els.map((e) => ({
      title: e.querySelector('.sgroup-head').textContent.replace(/[▾\d\s]/g, ''),
      items: e.querySelectorAll('.sitem').length,
      empty: !!e.querySelector('.side-empty'),
    }))
  );
  console.log('侧栏分组:', JSON.stringify(groups));
  checks.push(['五个分组齐全', groups.length === 5 && ['收藏', '设备', '应用', '域名', '接口结构'].every((t) => groups.some((g) => g.title === t))]);
  checks.push(['四个数据维度都有条目', ['设备', '应用', '域名', '接口结构'].every((t) => groups.find((g) => g.title === t)?.items > 0)]);

  const hosts = await page.$$eval('[data-facet="host"]', (els) =>
    els.slice(0, 3).map((e) => e.textContent.trim().replace(/\s+/g, ' '))
  );
  console.log('域名项:', JSON.stringify(hosts));
  checks.push(['域名多于一个（造流量生效）', hosts.length >= 2]);

  const beforeCount = await page.$eval('#count', (e) => e.textContent);
  await page.click('[data-facet="host"]');
  await page.waitForTimeout(700);
  const filtered = {
    count: await page.$eval('#count', (e) => e.textContent),
    before: beforeCount,
    chip: await page.$eval('#chips', (e) => e.innerText.replace(/\n/g, ' ')),
    activeItem: await page.$eval('.sitem.on', (e) => e.innerText.replace(/\n/g, ' ')).catch(() => null),
    rows: await page.$$eval('.row', (r) => r.length),
  };
  console.log('筛选后:', JSON.stringify(filtered));
  checks.push(['点域名后列表被筛选', parseInt(filtered.count, 10) > 0 && parseInt(filtered.count, 10) < parseInt(beforeCount, 10)]);
  checks.push(['出现筛选 chip 与高亮项', filtered.chip.includes('域名') && !!filtered.activeItem]);

  await page.click('[data-toggle="hosts"]');
  await page.waitForTimeout(250);
  const cls = await page.$eval('[data-group="hosts"]', (e) => e.className);
  console.log('收起域名组:', cls);
  checks.push(['分组可收起', cls.includes('closed')]);
  await page.click('[data-toggle="hosts"]');

  await page.click('#chips [data-clear="host"]');
  await page.waitForTimeout(600);
  const cleared = { count: await page.$eval('#count', (e) => e.textContent), chips: await page.$eval('#chips', (e) => e.innerText.trim()) };
  console.log('取消后:', JSON.stringify(cleared));
  checks.push(['取消筛选恢复全部', cleared.count === beforeCount && cleared.chips === '']);

  const rows = await page.$$('.row');
  await rows[0].click();
  await page.waitForTimeout(600);
  await page.click('#actStar');
  await page.waitForTimeout(800);
  const bookmarks = await page.$$eval('[data-bookmark]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  console.log('收藏项:', JSON.stringify(bookmarks));
  checks.push(['收藏生成书签', bookmarks.length >= 1]);

  await page.click('[data-bookmark]');
  await page.waitForTimeout(700);
  const applied = { count: await page.$eval('#count', (e) => e.textContent), chips: await page.$eval('#chips', (e) => e.innerText.replace(/\n/g, ' ')) };
  console.log('应用书签后:', JSON.stringify(applied));
  checks.push(['点书签应用筛选', applied.chips.length > 0]);

  const dims = await page.$$eval('.kv dt', (els) => els.map((e) => e.textContent)).catch(() => []);
  console.log('详情维度:', JSON.stringify(dims));
  checks.push(['详情含派生维度', dims.some((d) => /设备|应用|接口|来源/.test(d))]);

  // 清掉筛选，避免影响后续
  await page.$$eval('#chips [data-clear]', (els) => els.forEach((e) => e.click()));
  await page.waitForTimeout(400);
  await page.hover('[data-bookmark]');
  await page.click('[data-del-bookmark]');
  await page.waitForTimeout(600);
  const left = await page.$$eval('[data-bookmark]', (e) => e.length);
  console.log('删除后书签数:', left);
  checks.push(['书签可删除', left === 0]);

  await page.click('#sideHide');
  await page.waitForTimeout(300);
  const hidden = {
    sideHidden: await page.$eval('#side', (e) => e.hidden),
    showBtn: await page.$eval('#sideShow', (e) => e.hidden),
  };
  console.log('收起边栏:', JSON.stringify(hidden));
  checks.push(['边栏可收起并出现展开按钮', hidden.sideHidden === true && hidden.showBtn === false]);

  await page.click('#sideShow');
  await page.waitForTimeout(300);
  const shown = { sideHidden: await page.$eval('#side', (e) => e.hidden), overflowX: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) };
  console.log('展开边栏:', JSON.stringify(shown));
  checks.push(['边栏可展开且无溢出', shown.sideHidden === false && shown.overflowX <= 0]);

  await page.setViewportSize({ width: 560, height: 820 });
  await page.waitForTimeout(400);
  await page.click('#sideShow');
  await page.waitForTimeout(400);
  const drawer = {
    open: await page.$eval('#side', (e) => e.className),
    backdrop: !(await page.$eval('#sideBackdrop', (e) => e.hidden)),
    overflowX: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  };
  console.log('移动端抽屉:', JSON.stringify(drawer));
  checks.push(['窄屏抽屉展开 + 遮罩', drawer.open.includes('open') && drawer.backdrop]);
  checks.push(['窄屏无横向溢出', drawer.overflowX <= 0]);
  await page.click('#sideBackdrop');
  await page.waitForTimeout(300);
  const closedCls = await page.$eval('#side', (e) => e.className);
  console.log('点遮罩后:', closedCls);
  checks.push(['点遮罩关闭抽屉', !closedCls.includes('open')]);

  checks.push(['无 JS 报错', errs.length === 0]);
  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (errs.length) console.log('errors:', errs);
  await browser.close();
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
