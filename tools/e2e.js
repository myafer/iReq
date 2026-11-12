const { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(`${UI}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  log('overflowX:', await page.evaluate(() => document.documentElement.scrollWidth - innerWidth));

  // 1) 选一条请求 -> 重放改 URL -> 发送
  const rows = await page.$$('.row');
  await rows[2].click();
  await page.waitForTimeout(400);
  const before = await page.$$eval('.row', (r) => r.length);
  await page.click('#actReplay');
  await page.waitForTimeout(300);
  await page.fill('#rpUrl', 'http://127.0.0.1:8088/api/replayed-from-ui');
  await page.click('#rpSend');
  await page.waitForTimeout(1200);
  const after = await page.$$eval('.row', (r) => r.length);
  const replayBadge = await page.$eval('.row', (r) => r.innerText.replace(/\n+/g, ' '));
  log('重放: 行数', before, '->', after, '| 顶部行:', replayBadge);

  // 2) 从当前请求创建 mock 规则
  await page.waitForTimeout(300);
  await page.click('#actMock');
  await page.waitForTimeout(300);
  await page.fill('#ruMatch', '/api/mock-from-ui');
  await page.fill('#ruName', 'UI 生成的规则');
  await page.fill('#ruBody', '{"hello":"mocked"}');
  await page.click('#ruSave');
  await page.waitForTimeout(800);
  const ruleCount = await page.$eval('#ruleCount', (el) => el.textContent);
  log('规则数:', ruleCount);

  // 3) 规则弹窗能否看到
  await page.click('#btnRules');
  await page.waitForTimeout(500);
  log('规则卡片:', await page.$$eval('.rule', (r) => r.length), '| 首条:', await page.$eval('.rule', (r) => r.innerText.replace(/\n+/g, ' | ')));
  await page.keyboard.press('Escape');

  // 4) 搜索过滤
  await page.fill('#search', 'gzip');
  await page.waitForTimeout(600);
  log('搜索 gzip 后行数:', await page.$$eval('.row', (r) => r.length), '| count:', await page.$eval('#count', (e) => e.textContent));
  await page.fill('#search', '');
  await page.waitForTimeout(500);

  // 5) 过滤按钮（Mock 在筛选条的「更多」菜单里）
  await page.click('#btnFilterMore');
  await page.waitForTimeout(200);
  await page.click('#filterMoreMenu button[data-mocked="1"]');
  await page.waitForTimeout(500);
  log('Mock 过滤行数:', await page.$$eval('.row', (r) => r.length));
  await page.click('#filters button[data-status=""]');
  await page.waitForTimeout(400);

  // 6) 设置弹窗保存
  await page.click('#btnSettings');
  await page.waitForTimeout(500);
  await page.fill('#stPassthrough', 'apple.com\ntest-pinned.example');
  await page.click('#stSave');
  await page.waitForTimeout(600);
  const passthrough = await page.evaluate(async () => (await (await fetch('/api/config')).json()).passthrough);
  log('跳过解密域名:', JSON.stringify(passthrough));

  // 7) 证书弹窗内容
  await page.click('#btnCa');
  await page.waitForTimeout(500);
  log('证书弹窗:', await page.evaluate(() => ({
    path: document.querySelector('#caPath').textContent.slice(0, 40),
    mobile: document.querySelector('#caMobileProxy').textContent,
    url: document.querySelector('#caUrl').textContent,
  })));
  await page.keyboard.press('Escape');

  // 8) 实时追加：外部发起一条请求，界面是否自动出现
  const before2 = await page.$$eval('.row', (r) => r.length);
  await page.evaluate(() => fetch(`${PROXY_URL}/api/live?x=1`).catch(() => {}));
  await page.waitForTimeout(1500);
  log('实时行数:', before2, '->', await page.$$eval('.row', (r) => r.length));

  log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
