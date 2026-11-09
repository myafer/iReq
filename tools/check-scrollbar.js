const { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST } = require('./_env');
const { chromium, EXEC } = require('./_pw');
(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${UI}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const probe = () =>
    page.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const list = document.querySelector('.list');
      const root = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.dataset.theme,
        rootColorScheme: root.colorScheme,
        bodyBg: cs(document.body).backgroundColor,
        listScrollbarColor: cs(list).scrollbarColor,
        listScrollbarWidth: cs(list).scrollbarWidth,
        listGutter: list.offsetWidth - list.clientWidth,
        rows: document.querySelectorAll('.row').length,
        canScroll: list.scrollHeight > list.clientHeight,
      };
    });

  console.log('浅色:', JSON.stringify(await probe()));
  await page.click('#btnTheme');
  await page.waitForTimeout(400);
  console.log('深色:', JSON.stringify(await probe()));

  // 选中一条，让详情 + 滚动条都出现
  const rows = await page.$$('.row');
  if (rows[0]) await rows[0].click();
  await page.waitForTimeout(500);

  await page.screenshot({ path: '/tmp/dark-scroll.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
