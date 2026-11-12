'use strict';

/**
 * 自检：规则文件树的基础文件编辑能力
 * ---------------------------------------------------------------------------
 * ① 行内新建文件夹 / 文件（桌面端没有 window.prompt，必须走树内输入框）
 * ② 双击就地改名（不能顺手把文件挪到根目录）
 * ③ 右键菜单：复制 / 剪切 / 粘贴到此处 / 创建副本 / 重命名 / 复制路径 / 定位 / 删除
 * ④ 复制粘贴 = 换新 id 的新文件，重复粘贴不覆盖原件；粘贴到哪就落在哪
 * ⑤ 复制路径给绝对路径；/api/rules/reveal 正常返回且拒绝越权路径
 *
 * 只在自己造的 TF* 目录里折腾，结束时删干净；不碰流量 / 诊断 / 系统代理。
 */
const fs = require('fs');
const path = require('path');
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
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const BASE = 'TF基线';
const NEWDIR = 'TF新建';
const ROOTFILE = 'TF新文件';
const RENAMED = 'TF改名后';

const treeRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#rulesTree .rt-row')].map((r) => r.dataset.type + ':' + r.dataset.path)
  );
const openRowMenu = (page, p, x, y) =>
  page.evaluate(
    ([sel, cx, cy]) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-row')].find((n) => n.dataset.path === sel);
      if (!row) throw new Error('树里找不到 ' + sel);
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: cx, clientY: cy }));
    },
    [p, x || 260, y || 300]
  );
const menuOps = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#ctxMenu [data-rt]')].map((b) => b.dataset.rt));
/* 文件夹收起时子节点不渲染，取子行前先展开 */
const expandDir = (page, p) =>
  page.evaluate((dir) => {
    const row = [...document.querySelectorAll('#rulesTree .rt-dir')].find((n) => n.dataset.path === dir);
    const caret = row && row.querySelector('[data-caret]');
    if (caret && caret.textContent.trim() === '▸') caret.click();
  }, p);

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, locale: 'zh-CN' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  const st = await api('/api/status');
  /* 单独跑（不经过 check-all）时实例可能是首启态，引导弹窗会挡住点击 */
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ onboarded: true }),
  });
  const dataDir = st.dataDir;
  const rulesRoot = path.join(dataDir, 'rules');
  const rm = async (rel) => {
    try {
      await api('/api/rules/file?path=' + encodeURIComponent(rel), { method: 'DELETE' });
    } catch (_) {
      /* 已经不存在 */
    }
  };

  try {
    // 基线：一个文件夹 + 一条带 body 的规则
    await post('/api/rules/fs', { type: 'dir', dir: '', name: BASE });
    const seed = await post('/api/rules/fs', {
      type: 'rule',
      dir: BASE,
      name: '原规则',
      urlMatch: '/tf/orig',
      body: '{"seed":1}',
      bodyType: 'json',
    });

    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#ruleTabs'), null, { timeout: 12000 });
    await page.evaluate(() => localStorage.setItem('reqlite-rule-dirs', '[]'));
    await page.reload({ waitUntil: 'networkidle' });
    await wait(400);
    await page.click('#btnRules');
    await wait(700);

    // ------------------------------------------------------ 行内新建文件夹
    await page.click('#rtNewDir');
    await wait(280);
    ok(
      '点「+ 文件夹」出现树内输入框（不依赖 window.prompt）',
      await page.evaluate(() => !!document.querySelector('#rulesTree .rt-draft [data-tree-input]'))
    );
    await page.keyboard.type(NEWDIR);
    await page.keyboard.press('Enter');
    await wait(800);
    ok('新建文件夹真实落盘', fs.existsSync(path.join(rulesRoot, NEWDIR)));
    ok('新建文件夹出现在树里', (await treeRows(page)).includes('dir:' + NEWDIR));

    // ------------------------------------------------------ 行内新建文件
    await page.click('#rtNewFile');
    await wait(280);
    await page.keyboard.type(ROOTFILE);
    await page.keyboard.press('Enter');
    await wait(1000);
    ok('新建文件落盘为 *.rule.json', fs.existsSync(path.join(rulesRoot, ROOTFILE + '.rule.json')));
    ok('新建文件后自动打开编辑标签', await page.evaluate(() => document.querySelectorAll('#ruleTabs .ws-tab').length >= 1));

    // ------------------------------------------------------ 双击就地改名
    await page.evaluate(
      (p) => {
        const row = [...document.querySelectorAll('#rulesTree .rt-rule')].find((n) => n.dataset.path === p);
        if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      },
      ROOTFILE + '.rule.json'
    );
    await wait(320);
    ok(
      '双击规则弹出改名输入框',
      await page.evaluate(() => !!document.querySelector('#rulesTree .rt-rename-input'))
    );
    await page.evaluate(() => {
      const el = document.querySelector('#rulesTree .rt-rename-input');
      if (el) {
        el.focus();
        el.select();
      }
    });
    await page.keyboard.type(RENAMED);
    await page.keyboard.press('Enter');
    await wait(1000);
    ok('改名后新文件名落盘', fs.existsSync(path.join(rulesRoot, RENAMED + '.rule.json')));
    ok(
      '改名是就地改，没被挪到别的目录',
      fs.existsSync(path.join(rulesRoot, RENAMED + '.rule.json')) &&
        !fs.existsSync(path.join(rulesRoot, BASE, RENAMED + '.rule.json'))
    );

    // ------------------------------------------------------ 右键菜单项
    await openRowMenu(page, BASE);
    await wait(260);
    const ops = await menuOps(page);
    const needOps = ['copy', 'cut', 'paste', 'duplicate', 'rename', 'copy-path', 'reveal', 'del'];
    ok('右键菜单含复制/剪切/粘贴/副本/改名/复制路径/定位/删除', needOps.every((o) => ops.includes(o)), JSON.stringify(ops));
    const revealText = await page.evaluate(() => {
      const b = document.querySelector('#ctxMenu [data-rt="reveal"]');
      return b ? b.textContent : '';
    });
    ok('定位项按平台叫名字（访达 / 资源管理器 / 文件管理器）', /访达|资源管理器|文件管理器/.test(revealText), revealText);
    await page.keyboard.press('Escape');

    // 树空白处右键 = 根目录菜单
    await page.evaluate(() => {
      const box = document.querySelector('#rulesTree');
      const r = box.getBoundingClientRect();
      box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.bottom - 8 }));
    });
    await wait(260);
    const rootOps = await menuOps(page);
    ok('树空白处右键给出根目录菜单（新建 / 粘贴）', rootOps.includes('new-file') && rootOps.includes('paste'), JSON.stringify(rootOps));
    await page.keyboard.press('Escape');

    // ------------------------------------------------------ 复制 → 粘贴
    await openRowMenu(page, RENAMED + '.rule.json');
    await wait(260);
    await page.click('#ctxMenu [data-rt="copy"]');
    await wait(250);
    await openRowMenu(page, BASE);
    await wait(260);
    await page.click('#ctxMenu [data-rt="paste"]');
    await wait(1100);
    const pastedAbs = path.join(rulesRoot, BASE, RENAMED + '.rule.json');
    ok('粘贴到指定文件夹生成副本', fs.existsSync(pastedAbs));
    const origId = JSON.parse(fs.readFileSync(path.join(rulesRoot, RENAMED + '.rule.json'), 'utf8')).id;
    const copyId = fs.existsSync(pastedAbs) ? JSON.parse(fs.readFileSync(pastedAbs, 'utf8')).id : '';
    ok('副本换了新 id（不会和原件抢同一条规则）', !!copyId && copyId !== origId, origId.slice(0, 8) + ' vs ' + String(copyId).slice(0, 8));

    // 带响应体的规则：body 文件要跟着一起复制，且 bodyFile 指到新位置
    await expandDir(page, BASE);
    await wait(350);
    await openRowMenu(page, BASE + '/原规则.rule.json');
    await wait(260);
    await page.click('#ctxMenu [data-rt="copy"]');
    await wait(250);
    await openRowMenu(page, NEWDIR);
    await wait(260);
    await page.click('#ctxMenu [data-rt="paste"]');
    await wait(1100);
    const cRule = path.join(rulesRoot, NEWDIR, '原规则.rule.json');
    const cBody = path.join(rulesRoot, NEWDIR, '原规则.body.json');
    ok('带响应体的规则复制后 body 文件跟着走', fs.existsSync(cBody), String(seed && seed.name));
    const cMeta = fs.existsSync(cRule) ? JSON.parse(fs.readFileSync(cRule, 'utf8')) : {};
    ok('副本里的 bodyFile 指向新位置', cMeta.bodyFile === NEWDIR + '/原规则.body.json', String(cMeta.bodyFile));

    // ------------------------------------------------------ 剪切 → 粘贴
    await openRowMenu(page, RENAMED + '.rule.json');
    await wait(260);
    await page.click('#ctxMenu [data-rt="cut"]');
    await wait(250);
    await openRowMenu(page, BASE);
    await wait(260);
    await page.click('#ctxMenu [data-rt="paste"]');
    await wait(1100);
    ok('剪切粘贴＝移动：原件已离开根目录', !fs.existsSync(path.join(rulesRoot, RENAMED + '.rule.json')));
    ok('剪切粘贴＝移动：出现在目标文件夹', fs.existsSync(path.join(rulesRoot, BASE, RENAMED + ' 2.rule.json')));

    // ------------------------------------------------------ 创建副本（文件夹）
    await openRowMenu(page, NEWDIR);
    await wait(260);
    await page.click('#ctxMenu [data-rt="duplicate"]');
    await wait(1100);
    ok('文件夹「创建副本」生成同级副本', fs.existsSync(path.join(rulesRoot, NEWDIR + ' 2')));

    // ------------------------------------------------------ 复制路径（绝对路径）
    await page.evaluate(() => {
      window.__copied = [];
      window.copyText = (t) => window.__copied.push(t);
    });
    await openRowMenu(page, BASE);
    await wait(260);
    await page.click('#ctxMenu [data-rt="copy-path"]');
    await wait(400);
    const copied = await page.evaluate(() => window.__copied || []);
    ok(
      '复制路径给的是绝对路径',
      copied.length > 0 && copied[copied.length - 1] === path.join(rulesRoot, BASE),
      JSON.stringify(copied)
    );

    // ------------------------------------------------------ 定位接口（dryRun：不真的弹文件管理器）
    const rv = await post('/api/rules/reveal', { path: BASE, dryRun: true });
    ok(
      'reveal 接口给出平台与目标目录',
      !!rv.ok && !!rv.platform && rv.dir === path.join(rulesRoot, BASE),
      JSON.stringify(rv)
    );
    ok(
      'reveal 命令按平台选（open / explorer / xdg-open）',
      ['open', 'explorer', 'xdg-open'].includes(rv.cmd),
      String(rv.cmd)
    );
    /* 越权路径不能真的跑到 rules 根外面去（../ 会被吃掉，落在根内） */
    const bad = await post('/api/rules/reveal', { path: '../../../../etc', dryRun: true });
    ok(
      'reveal 把越权路径夹在 rules 根内',
      !bad.error && String(bad.path || '').startsWith(rulesRoot),
      JSON.stringify(bad)
    );

    // ------------------------------------------------------ 空剪贴板粘贴
    await page.evaluate(() => {
      /* 清掉界面里的剪贴板状态，再粘贴应给出提示而不是报错 */
      window.__empty = true;
    });
    await page.reload({ waitUntil: 'networkidle' });
    await wait(500);
    await page.click('#btnRules');
    await wait(700);
    await openRowMenu(page, BASE);
    await wait(260);
    await page.click('#ctxMenu [data-rt="paste"]');
    await wait(350);
    const toastText = await page.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
    ok('空剪贴板粘贴给提示不报错', /剪贴板|复制/.test(toastText) || !errs.length, toastText.trim().slice(0, 40));
    ok('整个过程没有前端异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    ok('自检执行未抛异常', false, String(err && err.message));
  } finally {
    for (const d of [BASE, NEWDIR, NEWDIR + ' 2']) await rm(d);
    for (const f of [RENAMED + '.rule.json', ROOTFILE + '.rule.json']) await rm(f);
    const left = fs.readdirSync(rulesRoot).filter((n) => n.startsWith('TF'));
    ok('自检现场已清理', left.length === 0, JSON.stringify(left));
    await browser.close();
    console.log(`\n${pass}/${total} 通过`);
    process.exitCode = pass === total ? 0 : 1;
  }
})();
