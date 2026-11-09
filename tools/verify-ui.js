const { chromium, EXEC } = require('./_pw');
(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));

  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  console.log('列表行数:', await page.$$eval('.row', (r) => r.length));
  console.log('连接状态:', await page.$eval('#connText', (e) => e.textContent));
  console.log('地址:', await page.$eval('#addrText', (e) => e.textContent));

  // 逐个点顶栏按钮，确认都响应
  const checks = [];
  const click = async (sel) => {
    await page.click(sel);
    await page.waitForTimeout(350);
    const opened = await page.evaluate(
      () => [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).map((m) => m.id)
    );
    checks.push(sel + ' -> ' + (opened.length ? opened.join(',') : '无弹窗'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  };
  await click('#btnCa');
  await click('#btnRules');
  await click('#btnSettings');

  console.log('按钮响应:\n  ' + checks.join('\n  '));

  // 证书弹窗内容
  await page.click('#btnCa');
  await page.waitForTimeout(400);
  console.log(
    '证书弹窗:',
    JSON.stringify(
      await page.evaluate(() => ({
        visible: !document.querySelector('#modalCa').hidden,
        proxy: document.querySelector('#caMobileProxy').textContent,
        url: document.querySelector('#caUrl').textContent,
        localPath: document.querySelector('#caLocalPath').textContent,
        cerHref: document.querySelector('#modalCa a[href="/ca.cer"]')?.getAttribute('href'),
      }))
    )
  );
  await page.keyboard.press('Escape');

  // 自动刷新状态是否仍在跑
  await page.waitForTimeout(5600);
  console.log('5s 后地址仍在:', await page.$eval('#addrText', (e) => e.textContent));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
