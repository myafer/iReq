const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const audit = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const cs = getComputedStyle(document.body);
    const overflowX = document.documentElement.scrollWidth - window.innerWidth;
    const rows = [...document.querySelectorAll('.row')].slice(0, 3).map((r) => ({
      h: +r.getBoundingClientRect().height.toFixed(1),
      text: r.innerText.replace(/\n+/g, ' | '),
      overflow: r.scrollWidth - r.clientWidth,
    }));
    return {
      theme: document.documentElement.dataset.theme,
      bg: cs.backgroundColor,
      color: cs.color,
      overflowX,
      header: box('.topbar'),
      toolbar: box('.toolbar'),
      listpane: box('.listpane'),
      detail: box('.detailpane'),
      listhead: box('.listhead'),
      count: document.querySelector('#count')?.textContent,
      conn: document.querySelector('#connText')?.textContent,
      addr: document.querySelector('#addrText')?.textContent,
      rows,
      clipped: [...document.querySelectorAll('.btn, .count, .addr')].filter(
        (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
      ).map((el) => el.className + ':' + el.textContent.trim().slice(0, 20)),
    };
  });
  console.log(JSON.stringify(audit, null, 2));

  // 选中一条，检查详情渲染
  const rows = await page.$$('.row');
  await rows[2].click();
  await page.waitForTimeout(500);
  const detail = await page.evaluate(() => ({
    method: document.querySelector('.dmethod')?.textContent,
    url: document.querySelector('.durl')?.innerText,
    meta: document.querySelector('.dmeta')?.innerText.replace(/\n+/g, ' '),
    tabs: [...document.querySelectorAll('.tabs button')].map((b) => b.textContent),
    bodyH: document.querySelector('.dbody')?.getBoundingClientRect().height,
    kvRows: document.querySelectorAll('.kv dt').length,
  }));
  console.log(JSON.stringify(detail, null, 2));

  // 各 tab
  for (const t of ['request', 'response', 'raw']) {
    await page.click(`button[data-tab="${t}"]`);
    await page.waitForTimeout(200);
    const h = await page.evaluate(() => ({
      blocks: document.querySelectorAll('pre.code-block').length,
      text: [...document.querySelectorAll('pre.code-block')].map((p) => p.innerText.length),
    }));
    console.log(t, JSON.stringify(h));
  }

  // 规则弹窗 + 重放弹窗结构
  await page.click('#btnRules');
  await page.waitForTimeout(400);
  console.log('rules modal:', JSON.stringify(await page.evaluate(() => ({
    visible: !document.querySelector('#modalRules').hidden,
    cards: document.querySelectorAll('.rule').length,
    text: document.querySelector('.rule')?.innerText.replace(/\n+/g, ' | '),
  }))));
  await page.keyboard.press('Escape');
  await page.click('#actReplay');
  await page.waitForTimeout(300);
  console.log('replay modal:', JSON.stringify(await page.evaluate(() => ({
    visible: !document.querySelector('#modalReplay').hidden,
    method: document.querySelector('#rpMethod').value,
    url: document.querySelector('#rpUrl').value,
    body: document.querySelector('#rpBody').value,
    headers: document.querySelector('#rpHeaders').value.split('\n').length,
  }))));
  await page.keyboard.press('Escape');

  // 暗色对比度粗查
  await page.click('#btnTheme');
  await page.waitForTimeout(300);
  const dark = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const card = getComputedStyle(document.querySelector('.listpane'));
    return { bg: cs.backgroundColor, color: cs.color, pane: card.backgroundColor };
  });
  console.log('dark:', JSON.stringify(dark));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
