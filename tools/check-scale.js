'use strict';

/** 自检：界面整体字号缩放、上下限、持久化、控件不被裁切、不产生横向溢出 */
const { chromium, EXEC } = require('./_pw');
const { seedFlows } = require('./_seed');
const { UI } = require('./_env');
(async () => {
  console.log('注入测试流量:', JSON.stringify(await seedFlows()));
  const browser = await chromium.launch({ executablePath: EXEC });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  await page.goto(UI + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const read = () =>
    page.evaluate(() => {
      const fs = (sel) => {
        const el = document.querySelector(sel);
        return el ? parseFloat(getComputedStyle(el).fontSize) : null;
      };
      const box = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      const clipped = [...document.querySelectorAll('.btn, .seg button, .fs-val')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        .map((el) => el.id || el.textContent.trim().slice(0, 8));
      return {
        label: document.querySelector('#fontVal').textContent,
        scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
        body: fs('body'),
        row: fs('.row'),
        listhead: fs('.listhead'),
        method: fs('.m'),
        topbarH: box('.topbar'),
        rowH: box('.row'),
        btnH: box('.btn'),
        overflowX: document.documentElement.scrollWidth - innerWidth,
        clipped,
      };
    });

  const checks = [];
  const init = await read();
  console.log('初始:', JSON.stringify(init));
  checks.push(['列表有数据', init.row !== null && init.rowH !== null]);

  await page.click('#fontUp');
  await page.click('#fontUp');
  await page.waitForTimeout(200);
  const up2 = await read();
  console.log('点两次 A+:', JSON.stringify(up2));
  checks.push(['A+ 放大字号生效', up2.body > init.body && up2.row > init.row]);
  checks.push(['A+ 放大布局一起变大', up2.rowH > init.rowH && up2.topbarH > init.topbarH]);
  checks.push(['百分比文案同步', up2.label === '110%']);
  checks.push(['放大后无横向溢出', up2.overflowX <= 0]);

  // 到上限就停：按钮 disabled 后再 click 会一直等到 Playwright 超时，批量回归里能拖垮整套
  for (let i = 0; i < 12; i++) {
    if (await page.$eval('#fontUp', (e) => e.disabled)) break;
    await page.click('#fontUp');
  }
  await page.waitForTimeout(200);
  const max = await read();
  console.log('到上限:', JSON.stringify(max));
  checks.push(['上限 150%', max.label === '150%']);
  checks.push(['到上限时按钮禁用', await page.$eval('#fontUp', (e) => e.disabled)]);
  checks.push(['上限时控件不被裁切', max.clipped.length === 0]);
  checks.push(['上限时无横向溢出', max.overflowX <= 0]);

  await page.click('#fontVal');
  await page.waitForTimeout(200);
  const reset = await read();
  console.log('点百分比恢复:', JSON.stringify(reset));
  checks.push(['点百分比恢复 100%', reset.label === '100%' && Math.abs(reset.body - init.body) < 0.5]);

  for (let i = 0; i < 5; i++) await page.click('#fontUp');
  await page.waitForTimeout(150);
  const before = (await read()).label;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const after = await read();
  console.log('刷新前:', before, '刷新后:', after.label, '| row 字号', after.row, '| 溢出', after.overflowX);
  checks.push(['刷新后字号保持', before === '124%' && after.label === '124%' && after.row > init.row]);

  await page.click('#btnTheme');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/scale-125-dark.png' });
  checks.push(['无 JS 报错', errs.length === 0]);

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (errs.length) console.log('errors:', errs);
  await browser.close();
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
