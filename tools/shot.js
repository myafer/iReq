const { chromium, EXEC } = require('./_pw');
const OUT = require('path').join(__dirname, '..', 'docs', 'screenshots');

require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:9091/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const rows = await page.$$('.row');
  const target = (await page.$$eval('.row', (list) => list.map((r) => r.innerText))).findIndex((t) =>
    t.includes('octocat')
  );
  await rows[target >= 0 ? target : 0].click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '/01-overview.png' });

  await page.click('button[data-tab="response"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/02-response.png' });

  await page.click('#btnRules');
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/03-rules.png' });
  await page.keyboard.press('Escape');

  await page.click('#actReplay');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/04-replay.png' });
  await page.keyboard.press('Escape');

  await page.click('#btnCa');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/05-ca.png' });
  await page.keyboard.press('Escape');

  await page.click('#btnTheme');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/06-dark.png' });

  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
