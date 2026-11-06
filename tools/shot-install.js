const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = require('path').join(__dirname, '..', 'docs', 'screenshots');

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:9090/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/07-install-mobile.png', fullPage: true });
  console.log('title:', await page.title());
  console.log(
    'links:',
    JSON.stringify(await page.$$eval('a.btn', (a) => a.map((x) => x.getAttribute('href') + ' ' + x.getAttribute('content-type'))))
  );
  console.log('proxy text:', await page.$eval('.kv', (e) => e.innerText));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
