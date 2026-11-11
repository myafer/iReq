'use strict';

/**
 * 自检：VSCode 式规则工作区
 * ---------------------------------------------------------------------------
 * ① 全屏工作区骨架：活动栏 / 资源管理器 / 标签条 / 面包屑 / 状态栏
 * ② 点规则不再弹第二个窗，而是在右侧开标签，左侧树常驻
 * ③ 多标签：未保存圆点、切换保留内容、⌘1..9 / ⌘W / ✕ 关闭、打开的编辑器同步
 * ④ 搜索过滤、侧栏开关、英文界面无 UI 中文残留
 *
 * 会临时造 2 条规则和 1 个文件夹，结束时清理；不碰流量 / 诊断 / 系统代理。
 */
const { UI } = require('./_env');
const { chromium, EXEC } = require('./_pw');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts) => (await fetch(UI + p, opts)).json();

const DIR = 'WS自检文件夹';
const N1 = '工作区规则甲';
const N2 = '工作区规则乙';

const snap = (page) =>
  page.evaluate(() => ({
    ws: !document.querySelector('#modalRules').hidden,
    editor: !document.querySelector('#modalRule').hidden,
    welcome: !document.querySelector('#ruleWelcome').hidden,
    tabs: document.querySelectorAll('#ruleTabs .ws-tab').length,
    openEditors: document.querySelectorAll('#wsOpenList .ws-open-item').length,
    dirty: document.querySelectorAll('#ruleTabs .dirty').length,
    name: document.querySelector('#ruName') ? document.querySelector('#ruName').value : '',
    crumbs: (document.querySelector('#ruleBreadcrumb') || {}).textContent || '',
    treeRows: document.querySelectorAll('#rulesTree .rt-row').length,
    sideW: (() => { const s = document.querySelector('#wsSidebar'); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
    wsW: (() => { const s = document.querySelector('#modalRules'); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
  }));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, locale: 'zh-CN' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const created = [];

  try {
    // ------------------------------------------------------------- 造数据
    await api('/api/rules/fs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dir', dir: '', name: DIR }),
    });
    for (const [name, url] of [[N1, '/ws/one'], [N2, '/ws/two']]) {
      const r = await api('/api/rules/fs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'rule', dir: DIR, name, urlMatch: url, body: '{"ok":true}', bodyType: 'json' }),
      });
      if (r && r.id) created.push(r.id);
    }

    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#ruleTabs'), null, { timeout: 12000 });
    await page.evaluate((d) => localStorage.setItem('reqlite-rule-dirs', JSON.stringify([d])), DIR);
    await page.reload({ waitUntil: 'networkidle' });
    await wait(450);
    await page.click('#btnRules');
    await wait(700);

    // ------------------------------------------------------------- 骨架
    const s0 = await snap(page);
    ok('规则入口打开全屏工作区', s0.ws && s0.wsW >= 1300, String(s0.wsW));
    ok('无标签时显示欢迎页', s0.welcome && !s0.editor);
    ok('活动栏 5 个图标存在', (await page.locator('.ws-act').count()) === 5);
    ok('资源管理器侧栏常驻且渲染文件树', s0.sideW >= 180 && s0.treeRows >= 2, JSON.stringify({ w: s0.sideW, rows: s0.treeRows }));
    ok('底部状态栏可见', await page.locator('.ws-status').isVisible());
    ok('标签条与面包屑存在', await page.locator('#ruleTabs').isVisible() && (await page.locator('#ruleBreadcrumb').innerText()).includes('规则'));

    // ------------------------------------------------- 点规则：内嵌标签而非弹窗
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-rule')].find((r) => r.textContent.includes(n));
      if (row) row.click();
    }, N1);
    await wait(800);
    const s1 = await snap(page);
    ok('点规则在右侧开标签', s1.tabs === 1 && s1.editor && !s1.welcome, JSON.stringify(s1));
    ok('工作区与左侧树在编辑时不消失', s1.ws && s1.treeRows >= 2 && s1.sideW >= 180);
    ok('侧栏「打开的编辑器」同步', s1.openEditors === 1);
    ok('面包屑显示目录与文件名', s1.crumbs.includes(DIR) && s1.crumbs.includes(N1 + '.rule.json'), s1.crumbs);
    ok('标签载入规则内容', s1.name === N1, s1.name);

    // ------------------------------------------------------------- 多标签
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-rule')].find((r) => r.textContent.includes(n));
      if (row) row.click();
    }, N2);
    await wait(800);
    const s2 = await snap(page);
    ok('第二条规则开出第二个标签', s2.tabs === 2 && s2.openEditors === 2 && s2.name === N2, JSON.stringify(s2));

    // 改当前标签 → dirty
    await page.fill('#ruName', N2 + '-未保存');
    await wait(250);
    ok('编辑后标签出现未保存圆点', (await snap(page)).dirty === 1);

    // 切回第一个标签 → 内容不丢，再切回来 → 未保存内容还在
    await page.evaluate(() => document.querySelectorAll('#ruleTabs .ws-tab')[0].click());
    await wait(700);
    const s3 = await snap(page);
    ok('切换标签载入对应规则', s3.name === N1, s3.name);
    await page.evaluate(() => document.querySelectorAll('#ruleTabs .ws-tab')[1].click());
    await wait(700);
    const s4 = await snap(page);
    ok('切回后未保存内容仍在', s4.name === N2 + '-未保存', s4.name);
    ok('切回后未保存标记仍保留', s4.dirty === 1, String(s4.dirty));

    // ⌘1 / ⌘2 切换
    await page.keyboard.press('Control+1');
    await wait(450);
    ok('⌘1 / Ctrl+1 切到第 1 个标签', (await snap(page)).name === N1);
    await page.keyboard.press('Control+2');
    await wait(450);
    ok('⌘2 / Ctrl+2 切到第 2 个标签', (await snap(page)).name === N2 + '-未保存');

    // ⌘W 关当前标签。Ctrl+W 会被浏览器自己吞掉（关标签页），
    // 所以派发合成 KeyboardEvent 直接验证我们注册的 handler。
    const press = (k, opts) =>
      page.evaluate(([key, o]) => {
        document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, o)));
      }, [k, opts]);
    let dialogs = 0;
    const onDismiss = (d) => { dialogs += 1; d.dismiss(); };
    page.on('dialog', onDismiss);
    await press('w', { ctrlKey: true });
    await wait(450);
    const w1 = await snap(page);
    ok('未保存标签关闭时二次确认', w1.tabs === 2 && dialogs === 1, JSON.stringify({ tabs: w1.tabs, dialogs }));
    page.off('dialog', onDismiss);

    const onAccept = (d) => { dialogs += 1; d.accept(); };
    page.on('dialog', onAccept);
    await press('w', { ctrlKey: true });
    await wait(700);
    const w2 = await snap(page);
    ok('⌘W 确认后关闭当前标签', w2.tabs === 1, JSON.stringify({ tabs: w2.tabs, dialogs }));
    page.off('dialog', onAccept);

    // 标签条 ✕ 关闭最后一个 → 回欢迎页
    await page.click('#ruleTabs .ws-tab .x');
    await wait(600);
    const s5 = await snap(page);
    ok('关掉最后一个标签回到欢迎页', s5.tabs === 0 && s5.welcome && !s5.editor, JSON.stringify(s5));

    // 「+」新建标签
    await page.click('#ruleTabs [data-rt-add]');
    await wait(700);
    ok('标签条「+」能新建规则标签', (await snap(page)).tabs === 1);
    await page.click('#ruleTabs .ws-tab .x');
    await wait(500);

    // ------------------------------------------------------------- 搜索 / 侧栏
    await page.fill('#rulesSearch', N1);
    await wait(350);
    const filtered = await page.evaluate(() => ({
      cards: document.querySelectorAll('#rulesList .rule').length,
      rows: document.querySelectorAll('#rulesTree .rt-row').length,
    }));
    ok('左侧搜索同时过滤树与列表', filtered.cards === 1 && filtered.rows < 8, JSON.stringify(filtered));
    await page.fill('#rulesSearch', '');
    await wait(250);
    await page.click('#wsActExplorer');
    await wait(200);
    ok('活动栏可收起资源管理器', await page.evaluate(() => document.documentElement.dataset.wsSidebar === 'off'));
    await page.click('#wsActExplorer');
    await wait(200);
    ok('活动栏可重新展开资源管理器', await page.evaluate(() => document.documentElement.dataset.wsSidebar !== 'off'));

    // ------------------------------------------------------------- 英文界面
    await page.evaluate(() => localStorage.setItem('reqlite-lang', 'en'));
    await page.reload({ waitUntil: 'networkidle' });
    await wait(450);
    await page.click('#btnRules');
    await wait(700);
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-rule')].find((r) => r.textContent.includes(n));
      if (row) row.click();
    }, N1);
    await wait(750);
    const cn = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.querySelector('#modalRules'), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const t = (n.nodeValue || '').trim();
        if (!t || !/[\u4e00-\u9fff]/.test(t)) continue;
        const el = n.parentElement;
        const cls = String(el.className || el.tagName);
        // 文件名 / 文件夹名 / 规则名 / 报文都是用户数据，保留原文
        if (/rt-name|rule-name|rule-preview|rule-dir|rt-crumb-path|fname|oname|ws-title-mid|ws-current/.test(cls)) continue;
        if (el.tagName === 'B' && /\.rule\.json$/.test(t)) continue;
        if (el.tagName === 'SPAN' && el.closest('#ruleBreadcrumb')) continue;
        if (el.closest('#rulesTree') || el.closest('#rulesList')) continue;
        out.push(cls + ' :: ' + t.slice(0, 40));
      }
      return out;
    });
    ok('英文界面无 UI 中文残留', cn.length === 0, cn.join(' | ').slice(0, 260));
    ok('英文状态栏与面包屑已翻译', await page.evaluate(() =>
      /tab|rules|Manual save/.test(document.querySelector('.ws-status').textContent) &&
      /^Rules/.test(document.querySelector('#ruleBreadcrumb').textContent.trim())));

    ok('全程无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 200));
  } catch (err) {
    ok('脚本执行无异常', false, String(err && err.stack || err).slice(0, 400));
  } finally {
    // 清理临时规则与文件夹
    for (const id of created) {
      try { await api('/api/rules/' + id, { method: 'DELETE' }); } catch (_) {}
    }
    try { await api('/api/rules/file?path=' + encodeURIComponent(DIR), { method: 'DELETE' }); } catch (_) {}
    await browser.close();
  }

  console.log(`\n共 ${total} 项，通过 ${pass} 项`);
  process.exit(pass === total ? 0 : 1);
})();
