'use strict';

/** 自检：空状态显隐、列表/详情字号、表头对齐、清空后空状态回归 */
const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const { seedFlows } = require('./_seed');
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

(async () => {
  console.log('注入测试流量:', JSON.stringify(await seedFlows()));
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const r = await page.evaluate(() => {
    const emptyEl = document.querySelector('#listEmpty');
    const emptyStyle = getComputedStyle(emptyEl);
    const rows = document.querySelectorAll('.row');
    const fs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fontSize : null;
    };
    const head = [...document.querySelectorAll('.listhead > *')].map((e) => Math.round(e.getBoundingClientRect().x));
    const firstRow = rows[0];
    const cells = firstRow ? [...firstRow.children].map((e) => Math.round(e.getBoundingClientRect().x)) : [];
    return {
      rows: rows.length,
      emptyHiddenAttr: emptyEl.hidden,
      emptyDisplay: emptyStyle.display,
      emptyVisible: !!(emptyEl.offsetWidth || emptyEl.offsetHeight || emptyEl.getClientRects().length),
      fonts: {
        body: fs('body'),
        row: fs('.row'),
        method: fs('.m'),
        url: fs('.cellurl .p'),
        statusPill: fs('.st'),
        listhead: fs('.listhead'),
      },
      rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : null,
      headX: head,
      cellX: cells,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      count: document.querySelector('#count').textContent,
    };
  });
  console.log('有流量时:', JSON.stringify(r));

  const checks = [];
  checks.push(['列表有数据', r.rows > 0]);
  checks.push(['有流量时空状态隐藏', r.emptyHiddenAttr === true && r.emptyDisplay === 'none' && !r.emptyVisible]);
  checks.push(['表头与首行列数一致', r.headX.length === r.cellX.length && r.headX.length === 4]);
  checks.push(['表头与首行列位置对齐', r.headX.every((x, i) => Math.abs(x - r.cellX[i]) <= 2)]);
  checks.push(['列表字号已生效', Object.values(r.fonts).every((v) => v && parseFloat(v) > 0)]);
  checks.push(['无横向溢出', r.overflowX <= 0]);

  // 详情页字号：必须真的选中一条请求后才有 .durl / .tabs / .kv
  const rows = await page.$$('.row');
  if (rows[0]) await rows[0].click();
  await page.waitForTimeout(500);
  const detail = await page.evaluate(() => {
    const fs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fontSize : null;
    };
    return { durl: fs('.durl'), tabs: fs('.tabs button'), kv: fs('.kv') };
  });
  console.log('详情字号:', JSON.stringify(detail));
  checks.push(['详情三处字号可读', ['durl', 'tabs', 'kv'].every((k) => detail[k] && parseFloat(detail[k]) > 0)]);

  // 清空后空状态应重新出现
  page.on('dialog', (d) => d.accept());
  await page.click('#btnClear');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const e = document.querySelector('#listEmpty');
    return {
      display: getComputedStyle(e).display,
      hidden: e.hidden,
      title: e.querySelector('.empty-title').textContent,
      rows: document.querySelectorAll('.row').length,
    };
  });
  console.log('清空后:', JSON.stringify(after));
  checks.push(['清空后空状态重新出现', after.display === 'flex' && after.hidden === false && after.rows === 0]);
  checks.push(['清空后文案正确', after.title.includes('还没有流量')]);
  checks.push(['无 JS 报错', errs.length === 0]);

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (errs.length) console.log('errors:', errs);
  await browser.close();
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
