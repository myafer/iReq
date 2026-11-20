'use strict';
const { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST } = require('./_env');

/** 自检：控制台「本机抓包」面板的真实点击往返，并确认系统代理最终还原 */
const { chromium, EXEC } = require('./_pw');
const { SystemProxy } = require('../src/system-proxy');
const sp = new SystemProxy({ proxyPort: PROXY_PORT, dataDir: require('path').join(__dirname, '..', 'data') });
const svc = sp.primaryService();
const original = sp.snapshot(svc);
const checks = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());

  try {
    await page.goto(`${UI}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const chip0 = await page.$eval('#localChip', (e) => ({ hidden: e.hidden, text: e.textContent.trim(), cls: e.className }));
    console.log('顶栏 chip:', JSON.stringify(chip0));
    checks.push(['顶栏显示「本机未接管」', !chip0.hidden && chip0.text === '本机未接管']);

    await page.click('#btnSettings');
    await page.waitForTimeout(700);
    const panel = await page.evaluate(() => ({
      visible: !document.querySelector('#modalSettings').hidden,
      badge: document.querySelector('#lpBadge').textContent.trim(),
      state: document.querySelector('#lpState').textContent.trim(),
      service: document.querySelector('#lpService').value,
      services: document.querySelectorAll('#lpService option').length,
      cmdOn: document.querySelector('#lpCmdOn').textContent.trim(),
      cmdOff: document.querySelector('#lpCmdOff').textContent.trim(),
      toggle: document.querySelector('#lpToggle').textContent.trim(),
    }));
    console.log('设置面板:', JSON.stringify(panel));
    // 本机若本来就有别的代理（Clash / 公司代理等），徽标是「被其它代理占用」而不是「未开启」
    checks.push(['面板状态已填充', panel.visible && ['未开启', '被其它代理占用'].includes(panel.badge) && panel.state.includes('网络服务')]);
    checks.push(['网络服务下拉有选项', panel.services > 0 && panel.service === svc]);
    checks.push(['可复制命令已生成', panel.cmdOn.includes('setwebproxy') && panel.cmdOff.includes('proxystate')]);
    checks.push(['按钮文案正确', panel.toggle === '接管本机']);

    // 点「接管本机」
    await page.click('#lpToggle');
    await page.waitForTimeout(1200);
    const afterOn = await page.evaluate(() => ({
      badge: document.querySelector('#lpBadge').textContent.trim(),
      toggle: document.querySelector('#lpToggle').textContent.trim(),
      chip: document.querySelector('#localChip').textContent.trim(),
    }));
    const sysOn = sp.status(svc);
    console.log('接管后:', JSON.stringify({ ...afterOn, ours: sysOn.ours, web: sysOn.web }));
    checks.push(['点击后系统代理真的接管', sysOn.ours && sysOn.web.port === PROXY_PORT]);
    checks.push(['UI 同步为已接管', afterOn.badge === '已接管' && afterOn.toggle === '释放本机代理' && afterOn.chip === '本机已接管']);

    // 点「释放本机代理」
    await page.click('#lpToggle');
    await page.waitForTimeout(1200);
    const afterOff = await page.evaluate(() => ({
      badge: document.querySelector('#lpBadge').textContent.trim(),
      toggle: document.querySelector('#lpToggle').textContent.trim(),
      chip: document.querySelector('#localChip').textContent.trim(),
    }));
    const sysOff = sp.status(svc);
    console.log('释放后:', JSON.stringify({ ...afterOff, ours: sysOff.ours }));
    // 只要求「不再是我们的代理」：释放后系统可能仍连着用户自己的代理，那是正常的
    checks.push(['点击后系统代理真的释放', !sysOff.ours]);
    checks.push(['UI 同步为未接管', ['未开启', '被其它代理占用'].includes(afterOff.badge) && afterOff.chip === '本机未接管']);

    // 另一个窗口（或终端 / Clash）改了系统代理，顶栏得自己跟上，不能等用户重开设置
    const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page2.goto(UI, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(700);
    const chip2 = () => page2.evaluate(() => document.querySelector('#localChip').textContent.trim());
    const waitChip = async (fn, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (fn(await chip2())) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    // 外部改了系统代理（另一个窗口 / Clash / 终端）：任何一次状态读取都会发现漂移并广播，
    // 这里用一次 GET 代替「另一个窗口的轮询」，再由 SSE 推给这个窗口
    sp.enable(svc);
    await fetch(UI + '/api/system-proxy?fast=1').catch(() => {});
    const sawOn = await waitChip((t) => t.includes('已接管'));
    sp.disable(svc);
    await fetch(UI + '/api/system-proxy?fast=1').catch(() => {});
    const sawOff = await waitChip((t) => t.includes('未接管'));
    checks.push(['顶栏状态跟着外部改动更新（读取即广播 + SSE）', sawOn && sawOff], `${sawOn} / ${sawOff}`);
    await page2.close();

    checks.push(['无 JS 报错', errs.length === 0]);
  } catch (err) {
    checks.push(['UI 流程无异常', false]);
    console.error('异常:', err && err.stack ? err.stack : err);
  } finally {
    // 先单独判定「服务自己有没有恢复干净」：只置 off 而残留 host/port / bypass
    // 也算不合格，用户下次手动开代理会连到已停掉的 reqLite。
    const beforeCleanup = sp.snapshot(svc);
    checks.push([
      '★ 服务自身释放后精确还原',
      JSON.stringify(beforeCleanup) === JSON.stringify(original),
    ]);
    // 再做兜底，保证跑完脚本绝不留残留
    if (JSON.stringify(beforeCleanup) !== JSON.stringify(original)) sp.restore(original, svc);
    const final = sp.snapshot(svc);
    checks.push([
      '兜底后系统配置干净',
      JSON.stringify(final) === JSON.stringify(original),
    ]);
    console.log('最终系统状态:', JSON.stringify(final));
    await browser.close();
  }

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (errs.length) console.log('errors:', errs);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
