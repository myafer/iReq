'use strict';

/**
 * 自检：精简交互层（顶栏「更多」/ 筛选「更多」/ 三步连接向导 / 快速 Mock /
 * ⌘K 命令面板 / 列表右键与就近网络模式）。
 *
 * 只造流量，不改 networkSim、不落规则、不碰系统代理，可放在一键回归中段。
 */
const { UI } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const { seedFlows } = require('./_seed');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await seedFlows();
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  try {
    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => !!document.querySelector('#btnMore') && !!document.querySelector('#cmdInput'),
      null,
      { timeout: 12000 }
    );
    await wait(400);

    // ---------------------------------------------------------- 顶栏层级
    const topVisible = await page.evaluate(() => {
      const vis = (s) => {
        const e = document.querySelector(s);
        if (!e) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return ['.topbar .switch', '#btnRules', '#btnClear', '#btnMore'].map(vis);
    });
    ok('顶栏常驻控件精简为 4 个', topVisible.every(Boolean), JSON.stringify(topVisible));
    ok('低频入口默认收起', await page.locator('#moreMenu').isHidden());

    await page.click('#btnMore');
    await wait(150);
    ok('「更多」可展开', await page.locator('#moreMenu').isVisible());
    const items = await page.locator('#moreMenu .more-item').count();
    ok('工具入口一个没删', items >= 4, String(items));
    ok('外观控件在菜单内',
      (await page.locator('#moreMenu #fontVal').count()) === 1 &&
      (await page.locator('#moreMenu #btnTheme').count()) === 1 &&
      (await page.locator('#moreMenu #btnLang').count()) === 1);
    // 反馈入口：必须是指向 GitHub issue 选择页的外链（Electron 会交给系统浏览器打开）
    const feedback = await page.evaluate(() => {
      const a = document.querySelector('#moreMenu #btnFeedback');
      if (!a) return null;
      return { href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim() };
    });
    ok('更多菜单有反馈入口并指向 issue 页',
      !!feedback && /github\.com\/myafer\/iReq\/issues\/new/.test(feedback.href || '') && feedback.target === '_blank',
      JSON.stringify(feedback));
    await page.keyboard.press('Escape');
    await wait(120);
    ok('Esc 收起「更多」', await page.locator('#moreMenu').isHidden());

    // ---------------------------------------------------------- 筛选层级
    await page.click('#btnFilterMore');
    await wait(150);
    ok('「更多筛选」可展开', await page.locator('#filterMoreMenu').isVisible());
    ok('Mock 与握手失败仍在筛选中',
      (await page.locator('#filterMoreMenu button[data-mocked="1"]').count()) === 1 &&
      (await page.locator('#filterMoreMenu button[data-status="tls"]').count()) === 1);
    await page.keyboard.press('Escape');
    await wait(120);
    ok('Esc 收起「更多筛选」', await page.locator('#filterMoreMenu').isHidden());

    // ---------------------------------------------------------- 连接向导
    await page.click('#btnCa');
    await page.waitForSelector('#modalSettings:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => !!document.querySelector('#connectStep2.focus'), null, { timeout: 6000 }).catch(() => {});
    ok('证书入口打开连接向导并定位第 2 步', (await page.locator('#connectStep2.focus').count()) === 1);
    ok('向导是三步', (await page.locator('#modalSettings .connect-step').count()) === 3);
    ok('证书地址与命令仍在',
      (await page.locator('#caMobileProxy').count()) === 1 &&
      (await page.locator('#caUrl').count()) === 1 &&
      (await page.locator('#caCmdMac').count()) === 1);
    ok('高级设置默认折叠', (await page.locator('.st-advanced').getAttribute('open')) === null);
    await page.click('#modalSettings [data-close]');
    await wait(150);

    // ---------------------------------------------------------- 快速 Mock
    await page.evaluate(() => openQuickMock({
      method: 'GET', host: 'example.test', url: 'https://example.test/api/probe',
      path: '/api/probe', status: 200, resBody: '{"ok":true}',
      resHeaders: { 'content-type': 'application/json' },
    }));
    await page.waitForSelector('#modalQuick:not([hidden])');
    ok('快速 Mock 只有 4 个输入项',
      (await page.locator('#modalQuick .modal-body input, #modalQuick .modal-body textarea').count()) === 4);
    ok('自动带入名称与响应体',
      (await page.locator('#qkName').inputValue()).includes('/api/probe') &&
      (await page.locator('#qkBody').inputValue()).includes('"ok"'));
    await page.click('#qkAdvanced');
    await page.waitForSelector('#modalRule:not([hidden])');
    ok('一键切到完整编辑器', await page.locator('#modalRule').isVisible());
    ok('完整编辑器 4 个页签未动', (await page.locator('#ruTabs button[data-rutab]').count()) === 4);
    await page.evaluate(() => closeModals());
    await wait(150);

    // ---------------------------------------------------------- 命令面板
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#cmdBackdrop:not([hidden])');
    ok('⌘K 打开命令面板', await page.locator('#cmdBackdrop').isVisible());
    ok('默认列出常用命令', (await page.locator('#cmdList .cmd-item').count()) >= 8);
    await page.fill('#cmdInput', '导出');
    await wait(180);
    const cmdLabels = await page.locator('#cmdList .cmd-label').allInnerTexts();
    ok('命令面板可搜动作', cmdLabels.some((t) => t.includes('导出')), cmdLabels.join('|'));
    await page.keyboard.press('Escape');
    await wait(120);
    ok('Esc 关闭命令面板', await page.locator('#cmdBackdrop').isHidden());

    // ---------------------------------------------------------- 就近操作
    const firstRow = page.locator('#list .row').first();
    await firstRow.click({ button: 'right' });
    await wait(150);
    const ctxCount = await page.locator('#ctxMenu:not([hidden]) .ctx-item').count();
    ok('列表行右键出统一动作菜单', ctxCount >= 5, String(ctxCount));
    await page.keyboard.press('Escape');
    await wait(120);

    await firstRow.click();
    await wait(350);
    ok('详情动作条有网络入口', (await page.locator('#actNet').count()) === 1);
    await page.click('#actNet');
    await wait(150);
    ok('就近切网络模式', (await page.locator('#ctxMenu:not([hidden]) [data-net-set]').count()) === 4);
    await page.keyboard.press('Escape');
    await wait(120);

    // ---------------------------------------------------------- 英文模式
    await page.evaluate(() => window.ReqLiteI18N.setLang('en'));
    await wait(350);
    await page.click('#btnMore');
    await wait(150);
    // #btnLang 是「切到另一种语言」的指示符，英文界面下本来就该显示「中」
    const menuText = await page.evaluate(() => {
      const m = document.querySelector('#moreMenu').cloneNode(true);
      const l = m.querySelector('#btnLang');
      if (l) l.remove();
      return m.textContent || '';
    });
    ok('英文模式更多菜单无中文残留', !/[\u4e00-\u9fff]/.test(menuText), menuText.replace(/\n/g, ' | '));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.ReqLiteI18N.setLang('auto'));

    ok('UI 无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    await browser.close();
  }
  console.log(`共 ${total} 项，通过 ${pass} 项`);
  console.log(`${pass}/${total} 通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
