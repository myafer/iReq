'use strict';

/**
 * 自检：富版 Mock 规则编辑器 + 所有 JSON 编辑/展示点
 * ---------------------------------------------------------------------------
 * ① Monaco 本地 vendor 加载、语法高亮、worker 校验、格式化/压缩
 * ② 规则表单：模板、状态码/延迟预设、响应头表格、CORS、匹配测试器、预览树
 * ③ 保存 → 真实走代理的请求被 Mock 命中（不是只看 UI）
 * ④ 规则列表：搜索/复制/排序/启停、JSON 导入导出
 * ⑤ 重放请求体编辑器、详情 JSON 着色/树视图、深浅主题与字号联动
 *
 * 前置：服务在 9090/9091 运行。脚本会造测试规则和流量，结束时全部清理。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, EXEC } = require('./_pw');
const { seedFlows } = require('./_seed');

const API = `http://127.0.0.1:${Number(process.env.REQLITE_UI_PORT || 9091)}`;
const RULE_NAME = '自检-富版规则-' + Date.now();
const MATCH = '/mockcheck/api/user';
const TREE_DIR = '自检文件夹';
const TREE_RULE = '树中规则';
const checks = [];
const ok = (name, cond, extra = '') => {
  checks.push([name, !!cond]);
  if (!cond) console.log('   ↳', extra);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, opts) => {
  const r = await fetch(API + p, opts);
  return r.json();
};

function proxyGet(path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(process.env.REQLITE_PROXY_PORT || 9090), method: 'GET', path,
        headers: { host: 'mockcheck.test', 'user-agent': 'reqlite-mockcheck' }, timeout: 6000 },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

(async () => {
  const before = await api('/api/rules');
  const beforeIds = before.map((r) => r.id);
  const errs = [];
  const fails = [];
  let browser;

  try {
    browser = await chromium.launch({ executablePath: EXEC });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('response', (r) => { if (r.status() >= 400) fails.push('HTTP ' + r.status() + ' ' + r.url()); });

    await page.goto(API + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction('window.ReqLiteJSON && window.ReqLiteJSON.loaded === true', { timeout: 20000 });
    const init = await page.evaluate(() => ({
      je: !!window.ReqLiteJSON,
      loaded: window.ReqLiteJSON.loaded,
      monaco: !!window.monaco,
    }));
    ok('首屏预热 Monaco 成功（本地 vendor，无 CDN）', init.je && init.loaded && init.monaco, JSON.stringify(init));

    /* ---------------------------------------------------- 打开新建规则弹窗 */
    await page.click('#btnRules');
    await page.click('#ruNew');
    await page.waitForSelector('#modalRule:not([hidden])');
    await sleep(500);
    const shape = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#ruTabs button[data-rutab]').length,
      panes: document.querySelectorAll('.re-pane[data-rupane]').length,
      monaco: document.querySelectorAll('#ruBodyEditor .monaco-editor').length,
      aside: document.querySelectorAll('.re-aside').length,
      summary: document.querySelectorAll('#ruSummary').length,
      testerClosed: document.querySelector('.re-tester') && !document.querySelector('.re-tester').open,
      width: document.querySelector('.rule-editor').getBoundingClientRect().width,
      bodyHeight: document.querySelector('#ruBodyEditor').getBoundingClientRect().height,
    }));
    ok('四个标签页 / 四个面板齐全', shape.tabs === 4 && shape.panes === 4, JSON.stringify(shape));
    ok('规则弹窗已瘦身（无右侧栏 / 无规则速览）', shape.aside === 0 && shape.summary === 0, JSON.stringify(shape));
    ok('匹配测试器默认收起', shape.testerClosed === true, JSON.stringify(shape));
    ok('响应体挂载了真实 Monaco 实例', shape.monaco === 1, JSON.stringify(shape));
    const tmplShape = await page.evaluate(() => ({
      pickBtn: !!document.querySelector('#ruTmplPick'),
      pickerClosed: document.querySelector('#ruTmplPicker').hidden,
      saveBtn: !!document.querySelector('#ruSaveTmpl'),
    }));
    ok('模板浮层默认收起 + 两个入口按钮就绪', tmplShape.pickBtn && tmplShape.pickerClosed && tmplShape.saveBtn, JSON.stringify(tmplShape));

    /* ------------------------------------------------ 自定义模板：保存 / 插入 / 覆盖 / 删除 */
    await page.evaluate(() => localStorage.removeItem('reqlite-templates'));
    await page.evaluate(() => {
      RU.body.setValue('{"code":0,"message":"ok"}');
      document.querySelector('#ruStatus').value = '201';
      document.querySelector('#ruBodyLang').value = 'json';
    });
    await page.click('[data-rutab="body"]'); /* 存为模板按钮在响应体页签里 */
    await sleep(200);
    await page.click('#ruSaveTmpl');
    await page.fill('#ruTmplName', '自检模板');
    await page.click('#ruTmplOk');
    await sleep(250);
    const saved = await page.evaluate(() => ({
      n: JSON.parse(localStorage.getItem('reqlite-templates') || '[]').length,
      chips: document.querySelectorAll('[data-template-box] .tmpl').length,
      st: document.querySelector('#ruStatus').value,
      status201: JSON.parse(localStorage.getItem('reqlite-templates'))[0].status,
    }));
    ok(
      '存为模板：localStorage 一条 + 浮层列表同步 + 捕获状态码',
      saved.n === 1 && saved.chips === 1 && saved.st === '201' && saved.status201 === 201,
      JSON.stringify(saved)
    );
    await page.evaluate(() => RU.body.setValue(''));
    await page.click('#ruTmplPick'); /* 打开模板浮层再选 */
    await sleep(200);
    await page.click('#ruTmplPicker [data-tmpl="0"]');
    await sleep(400);
    const afterTmpl = await page.evaluate(() => ({
      body: RU.body.getValue(),
      tab: RU.tab,
      tokens: document.querySelectorAll('#ruBodyEditor .view-line span[class*="mtk"]').length,
      status: document.querySelector('#ruBodyStatus').textContent,
      badge: document.querySelector('#ruValidBadge').textContent,
      statusCode: document.querySelector('#ruStatus').value,
      lang: document.querySelector('#ruBodyLang').value,
    }));
    ok('模板插入替换响应体并切到响应体页', afterTmpl.tab === 'body' && afterTmpl.body.includes('"code": 0'), JSON.stringify(afterTmpl).slice(0, 200));
    ok('Monaco 对 JSON 做了语法着色', afterTmpl.tokens > 3, String(afterTmpl.tokens));
    ok('状态条显示 JSON 有效', /JSON 有效/.test(afterTmpl.status), afterTmpl.status);
    ok('顶栏校验徽标为 ✓', /✓/.test(afterTmpl.badge), afterTmpl.badge);
    ok('模板恢复保存时的状态码与语言', afterTmpl.statusCode === '201' && afterTmpl.lang === 'json', JSON.stringify(afterTmpl).slice(0, 200));
    await page.click('#ruSaveTmpl');
    await page.fill('#ruTmplName', '自检模板');
    await page.click('#ruTmplOk');
    await sleep(250);
    const dup = await page.evaluate(() => JSON.parse(localStorage.getItem('reqlite-templates')).length);
    ok('同名模板覆盖不新增', dup === 1, String(dup));
    await page.click('#ruTmplPick');
    await sleep(200);
    await page.click('#ruTmplPicker [data-tmpl-del="0"]');
    await sleep(250);
    const afterDel = await page.evaluate(() => ({
      n: JSON.parse(localStorage.getItem('reqlite-templates') || '[]').length,
      empties: document.querySelectorAll('[data-template-box] .tmpl-empty').length,
    }));
    ok('删除模板后回到空态', afterDel.n === 0 && afterDel.empties === 1, JSON.stringify(afterDel));
    ok('响应体面板可见时编辑器有实际高度', (await page.evaluate(() => document.querySelector('#ruBodyEditor').getBoundingClientRect().height)) > 150);

    await page.click('#ruMinify');
    await sleep(200);
    const min = await page.evaluate(() => RU.body.getValue());
    ok('压缩按钮把 JSON 变成一行', !min.includes('\n') && min.includes('"code":0'), min.slice(0, 80));
    await page.click('#ruFormat');
    await sleep(200);
    const fmt = await page.evaluate(() => RU.body.getValue());
    ok('格式化按钮恢复缩进', fmt.includes('\n') && fmt.includes('"code": 0'), fmt.slice(0, 80));

    /* --------------------------------------------------- worker 校验 + 保存拦截 */
    await page.evaluate(() => RU.body.setValue('{"a":1,,}'));
    await sleep(1000);
    const bad = await page.evaluate(() => ({
      status: document.querySelector('#ruBodyStatus').textContent,
      badge: document.querySelector('#ruValidBadge').textContent,
      markers: (() => {
        let n = 0;
        for (const m of monaco.editor.getModels()) n += monaco.editor.getModelMarkers({ resource: m.uri }).length;
        return n;
      })(),
    }));
    ok('非法 JSON 状态条报错并给出行号', /✕/.test(bad.status) && /第 \d+ 行/.test(bad.status), bad.status);
    ok('非法 JSON 顶栏徽标报错', /✕/.test(bad.badge), bad.badge);
    ok('Monaco JSON worker 产生错误标记', bad.markers > 0, String(bad.markers));
    await page.click('#ruValidate');
    await sleep(250);
    const toast1 = await page.evaluate(() => document.querySelector('#toast').textContent);
    ok('点校验给出「JSON 有误」提示', /JSON 有误/.test(toast1), toast1);

    await page.click('[data-rutab="match"]');
    await sleep(200);
    await page.fill('#ruMatch', MATCH);
    await page.fill('#ruName', RULE_NAME);
    await page.click('#ruSave');
    await sleep(500);
    const blocked = await page.evaluate(() => ({ open: !document.querySelector('#modalRule').hidden, toast: document.querySelector('#toast').textContent }));
    ok('JSON 语法错误时阻止保存', blocked.open && /JSON 有误/.test(blocked.toast), JSON.stringify(blocked));

    /* ------------------------------------------------------------ 纯文本模式 */
    await page.click('[data-rutab="body"]');
    await sleep(200);
    await page.selectOption('#ruBodyLang', 'plaintext');
    await sleep(300);
    const plain = await page.evaluate(() => ({ status: document.querySelector('#ruBodyStatus').textContent, state: document.querySelector('#ruBodyState').textContent }));
    ok('切纯文本后不再做 JSON 校验', /纯文本模式/.test(plain.status) && /纯文本/.test(plain.state), JSON.stringify(plain));
    await page.selectOption('#ruBodyLang', 'json');
    await page.evaluate(() => RU.body.setValue('{"code":0,"message":"mock ok","data":{"from":"reqlite"}}'));
    await sleep(400);

    /* ------------------------------------------------------------ 匹配测试器 */
    await page.click('[data-rutab="match"]');
    await page.selectOption('#ruMethod', 'GET');
    await page.click('.re-tester > summary'); /* 测试器默认收起，先展开 */
    await sleep(200);
    await page.fill('#ruTestUrl', 'https://api.example.com' + MATCH + '/42?page=1');
    await page.fill('#ruTestHost', 'api.example.com');
    await sleep(300);
    const hit1 = await page.evaluate(() => ({ cls: document.querySelector('#ruTestResult').className, text: document.querySelector('#ruTestResult').textContent }));
    ok('匹配测试器：URL 命中', /hit/.test(hit1.cls) && /命中/.test(hit1.text), JSON.stringify(hit1));
    await page.selectOption('#ruTestMethod', 'POST');
    await sleep(250);
    const hit2 = await page.evaluate(() => ({ cls: document.querySelector('#ruTestResult').className, text: document.querySelector('#ruTestResult').textContent }));
    ok('匹配测试器：方法不符判不命中', /miss/.test(hit2.cls) && /方法不匹配/.test(hit2.text), JSON.stringify(hit2));
    await page.selectOption('#ruTestMethod', 'GET');
    await page.fill('#ruTestHost', 'other.example.com');
    await page.fill('#ruHost', 'api.example.com');
    await sleep(250);
    const hit3 = await page.evaluate(() => document.querySelector('#ruTestResult').textContent);
    ok('匹配测试器：域名不符给出原因', /域名不匹配/.test(hit3), hit3);
    await page.fill('#ruHost', '');
    await page.fill('#ruTestHost', '');
    await sleep(200);

    /* --------------------------------------------------- 状态 / 延迟 / 响应头 */
    await page.click('[data-rutab="response"]');
    await page.click('#ruStatusChips [data-status="404"]');
    await page.click('#ruDelayChips [data-delay="800"]');
    await sleep(250);
    const presets = await page.evaluate(() => ({ st: document.querySelector('#ruStatus').value, delay: document.querySelector('#ruDelay').value, range: document.querySelector('#ruDelayRange').value }));
    ok('状态码 / 延迟预设联动输入框和滑块', presets.st === '404' && presets.delay === '800' && presets.range === '800', JSON.stringify(presets));
    await page.click('#ruCors');
    await sleep(250);
    const cors = await page.evaluate(() => document.querySelector('#ruHeaders').value);
    ok('一键 CORS 写入三个跨域头', /access-control-allow-origin: \*/.test(cors) && /access-control-allow-methods/.test(cors), cors.slice(0, 160));
    await page.click('#ruAddHeader');
    await page.locator('.re-hdr-row [data-hk]').last().fill('X-Self-Test');
    await page.locator('.re-hdr-row [data-hv]').last().fill('yes');
    await sleep(250);
    const rowsText = await page.evaluate(() => document.querySelector('#ruHeaders').value);
    ok('响应头表格新增行同步到原始文本', /X-Self-Test: yes/.test(rowsText), rowsText.slice(0, 200));
    await page.selectOption('#ruContentType', 'text/plain; charset=utf-8');
    await sleep(250);
    const ctChanged = await page.evaluate(() => document.querySelector('#ruHeaders').value);
    ok('Content-Type 下拉覆盖现有 header', /content-type: text\/plain/.test(ctChanged) && !/content-type: application\/json/.test(ctChanged), ctChanged.slice(0, 160));
    await page.selectOption('#ruContentType', 'application/json; charset=utf-8');
    await page.click('#ruStatusChips [data-status="200"]');
    await page.click('#ruDelayChips [data-delay="0"]');
    await sleep(200);

    /* -------------------------------------------------------------- 预览 / 树 */
    await page.click('[data-rutab="preview"]');
    await sleep(350);
    const preview = await page.evaluate(() => ({
      text: document.querySelector('#ruPreview').textContent,
      trees: document.querySelectorAll('#ruTree details').length,
      keys: document.querySelectorAll('#ruPreview .jt-key').length,
    }));
    ok('预览显示 HTTP 状态行与响应头', /HTTP\/1\.1 200/.test(preview.text) && /content-type/.test(preview.text), preview.text.slice(0, 120));
    ok('预览里 JSON body 被着色', preview.keys > 0, String(preview.keys));
    ok('JSON 结构树生成可折叠节点', preview.trees > 0, String(preview.trees));
    await page.click('#ruTreeCollapse');
    await sleep(150);
    const collapsed = await page.evaluate(() => [...document.querySelectorAll('#ruTree details')].every((d) => !d.open));
    ok('结构树「全部折叠」生效', collapsed);

    /* ------------------------------------------------------------- 保存规则 */
    await page.click('[data-rutab="match"]');
    await sleep(200);
    await page.fill('#ruNote', 'check-mock-editor 自动创建');
    await page.click('#ruSave');
    await sleep(700);
    const savedRules = await api('/api/rules');
    const rule = savedRules.find((r) => r.name === RULE_NAME);
    ok('规则保存成功且弹窗关闭', await page.evaluate(() => document.querySelector('#modalRule').hidden), 'modal 未关闭');
    ok('后端保留备注 note 字段', !!rule && rule.note === 'check-mock-editor 自动创建', JSON.stringify(rule && rule.note));
    ok('后端保留 bodyType 字段', !!rule && rule.bodyType === 'json', JSON.stringify(rule && rule.bodyType));
    ok('响应头与状态码正确落盘', !!rule && rule.status === 200 && rule.headers['content-type'] === 'application/json; charset=utf-8', JSON.stringify(rule && { s: rule.status, h: rule.headers }));

    /* ------------------------------------------- 真实代理请求被 Mock 命中 */
    if (rule) {
      const res = await proxyGet('http://mockcheck.test' + MATCH + '/42');
      ok('真实请求命中 Mock 且返回 200', res.status === 200, JSON.stringify(res).slice(0, 200));
      ok('Mock 返回编辑后的 JSON 响应体', /"code":0/.test(res.body) && /mock ok/.test(res.body), (res.body || '').slice(0, 160));
      ok('Mock 响应带 content-type', /application\/json/.test(String((res.headers || {})['content-type'] || '')), JSON.stringify(res.headers));
    } else {
      ok('真实请求命中 Mock 且返回 200', false, '规则未保存');
      ok('Mock 返回编辑后的 JSON 响应体', false);
      ok('Mock 响应带 content-type', false);
    }

    /* --------------------------------------------- 规则列表：搜索/复制/排序 */
    await page.click('#btnRules');
    await page.fill('#rulesSearch', RULE_NAME);
    await sleep(300);
    const found = await page.evaluate(() => document.querySelectorAll('#rulesList .rule').length);
    ok('规则列表搜索过滤生效', found === 1, String(found));
    await page.click('#rulesList [data-act="dup"]');
    await sleep(500);
    const dupCount = await page.evaluate(() => document.querySelectorAll('#rulesList .rule').length);
    ok('规则列表「复制」生成副本', dupCount === 2, String(dupCount));
    await page.fill('#rulesSearch', '');
    await sleep(200);

    /* --------------------------------------------- 规则文件树（data/rules/） */
    // data 目录从服务端状态里推导（caPath = <dataDir>/ca/reqlite-ca.pem）
    const stNow = await api('/api/status');
    const dataDir = path.dirname(path.dirname(stNow.caPath || ''));
    const rulesRoot = path.join(dataDir, 'rules');

    await page.click('#rtRefresh');
    await sleep(500);
    const treeRows = await page.evaluate(() => document.querySelectorAll('#rulesTree .rt-row').length);
    ok('规则文件树渲染出节点', treeRows >= 1, String(treeRows));

    // 新建文件夹（页面 prompt 弹窗）
    page.once('dialog', (d) => d.accept(TREE_DIR));
    await page.click('#rtNewDir');
    await sleep(600);
    const dirInTree = await page.evaluate(
      (p) => [...document.querySelectorAll('#rulesTree .rt-dir')].some((n) => n.dataset.path === p),
      TREE_DIR
    );
    ok('新建文件夹出现在文件树', dirInTree);
    ok('新建文件夹真实落盘', fs.existsSync(path.join(rulesRoot, TREE_DIR)));

    // 通过文件 API 往文件夹里造一条带 body 的规则
    await api('/api/rules/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'rule', dir: TREE_DIR, name: TREE_RULE, urlMatch: '/tree-check', body: '{"from":"tree"}', bodyType: 'json' }),
    });
    await page.click('#rtRefresh'); // 界面重扫 rules 目录
    await sleep(700);
    const rulePath = TREE_DIR + '/' + TREE_RULE + '.rule.json';
    const bodyPath = TREE_DIR + '/' + TREE_RULE + '.body.json';
    ok('树中规则 .rule.json 落盘', fs.existsSync(path.join(rulesRoot, TREE_DIR, TREE_RULE + '.rule.json')));
    ok('响应 body 拆分为独立文件落盘', fs.existsSync(path.join(rulesRoot, TREE_DIR, TREE_RULE + '.body.json')));
    const bodyNode = await page.evaluate(
      (p) => [...document.querySelectorAll('#rulesTree .rt-bodyfile')].some((n) => n.dataset.path === p),
      bodyPath
    );
    ok('body 文件以子节点挂在规则下', bodyNode);

    // 点击树中的规则节点 → 打开编辑弹窗
    await page.evaluate((p) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-rule')].find((n) => n.dataset.path === p);
      row.click();
    }, rulePath);
    await sleep(500);
    const ruleModalOpen = await page.evaluate((nm) => !document.querySelector('#modalRule').hidden && document.querySelector('#ruName').value.includes(nm), TREE_RULE);
    ok('点击树中规则打开编辑弹窗', ruleModalOpen);
    await page.keyboard.press('Escape');
    await sleep(300);

    // 拖拽规则到根目录（模拟移动）：先重开规则面板（上一步 Escape 把弹窗全关了，树不可见）
    await page.click('#btnRules');
    await sleep(500);
    const srcRow = page.locator(`#rulesTree .rt-rule[data-path="${rulePath}"]`);
    await srcRow.dragTo(page.locator('#rulesTree'));
    await sleep(700);
    ok('拖拽把规则移动到根目录', fs.existsSync(path.join(rulesRoot, TREE_RULE + '.rule.json')) && !fs.existsSync(path.join(rulesRoot, rulePath)));

    // 点 body 文件 → 编辑器切到 body 页签
    await page.evaluate((p) => {
      const row = [...document.querySelectorAll('#rulesTree .rt-bodyfile')].find((n) => n.dataset.path === p);
      if (row) row.click();
    }, TREE_RULE + '.body.json');
    await sleep(500);
    const bodyTab = await page.evaluate(() => !document.querySelector('#modalRule').hidden);
    ok('点击 body 文件能打开规则编辑器', bodyTab);
    await page.keyboard.press('Escape');
    await sleep(300);

    // 重开规则面板，继续列表相关断言
    await page.click('#btnRules');
    await sleep(500);
    const firstCard = page.locator('#rulesList .rule').first();
    const tid = await firstCard.getAttribute('data-id');
    const wasChecked = await firstCard.locator('[data-toggle]').isChecked();
    await firstCard.locator('[data-toggle]').click();
    await sleep(500);
    const toggled = (await api('/api/rules')).find((r) => r.id === tid);
    ok('列表开关切换规则启用状态', !!toggled && toggled.enabled === !wasChecked, JSON.stringify({ tid, wasChecked, now: toggled && toggled.enabled }));

    /* ------------------------------------------------------ JSON 导入 / 导出 */
    await page.click('#rulesExport');
    await sleep(500);
    const io = await page.evaluate(() => ({
      open: !document.querySelector('#modalJsonIO').hidden,
      title: document.querySelector('#jsonIoTitle').textContent,
      monaco: document.querySelectorAll('#jsonIoEditor .monaco-editor').length,
      status: document.querySelector('#jsonIoStatus').textContent,
      value: RU.ioBody.getValue(),
      applyHidden: document.querySelector('#jsonIoApply').hidden,
    }));
    ok('导出弹窗用 Monaco 展示规则 JSON', io.open && io.monaco === 1 && /导出/.test(io.title), JSON.stringify(io).slice(0, 200));
    ok('导出内容是可解析的规则数组', (() => { try { return Array.isArray(JSON.parse(io.value)); } catch (_) { return false; } })(), io.value.slice(0, 80));
    ok('导出弹窗隐藏「导入并覆盖」', io.applyHidden === true);
    ok('导出状态条显示规则条数', /条规则/.test(io.status), io.status);
    await page.click('#modalJsonIO [data-close]');
    await page.click('#rulesImport');
    await sleep(500);
    const imp = await page.evaluate(() => ({
      applyShown: !document.querySelector('#jsonIoApply').hidden,
      value: RU.ioBody.getValue(),
      text: document.querySelector('#jsonIoApply').textContent,
    }));
    ok('导入弹窗给出示例规则且要求两次确认', imp.applyShown && /示例/.test(imp.value) && /导入并覆盖/.test(imp.text), JSON.stringify(imp).slice(0, 160));
    await page.click('#jsonIoApply');
    await sleep(200);
    const armed = await page.evaluate(() => document.querySelector('#jsonIoApply').textContent);
    ok('第一次点导入只进入确认态，不写规则', /确认覆盖/.test(armed), armed);
    await page.click('#modalJsonIO [data-close]');
    await page.click('#modalRules [data-close]');

    /* ------------------------------------- 重放编辑器 + 详情 JSON 着色/树 */
    await seedFlows();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction('window.ReqLiteJSON && window.ReqLiteJSON.loaded === true', { timeout: 20000 });
    await sleep(500);
    const row = await page.$('.row');
    ok('自检流量已生成，可选中一条请求', !!row, '没有 .row');
    if (row) {
      // 列表里混着 JS / 纯文本 / 空响应，挑一条真正返回 JSON 的来验证着色
      let picked = false;
      const total = Math.min(12, await page.locator('.row').count());
      for (let i = 0; i < total; i++) {
        // 用 locator 而不是 ElementHandle：实时流可能重建列表，句柄会失效
        await page.locator('.row').nth(i).click();
        await sleep(200);
        await page.click('#tabs [data-tab="response"]');
        await sleep(200);
        if (await page.evaluate(() => !!document.querySelector('#detail .body-view[data-json="1"]'))) {
          picked = true;
          break;
        }
      }
      ok('能选中一条 JSON 响应体请求', picked, '前 12 条里没有 JSON 响应');
      const detail = await page.evaluate(() => ({
        views: document.querySelectorAll('#detail .body-view').length,
        keys: document.querySelectorAll('#detail .body-view .jt-key').length,
        tools: document.querySelectorAll('#detail .body-tool').length,
      }));
      ok('详情响应体有 JSON 着色与工具条', detail.views >= 1 && detail.keys > 0 && detail.tools >= 4, JSON.stringify(detail));
      /* 结构化视图 = 格式化 + 树一体：默认展开、可全部折叠 / 展开 */
      const fold = await page.evaluate(() => ({
        nodes: document.querySelectorAll('#detail .json-fold details').length,
        folded: document.querySelectorAll('#detail .json-fold .jf-folded').length,
      }));
      ok('结构化视图默认展开且各层可折叠', fold.nodes > 0 && fold.folded > 0, JSON.stringify(fold));
      await page.click('#detail [data-body-fold="0"][data-body-kind="response"]');
      await sleep(250);
      const allClosed = await page.evaluate(
        () => [...document.querySelectorAll('#detail .json-fold details')].length > 0 &&
          [...document.querySelectorAll('#detail .json-fold details')].every((d) => !d.open)
      );
      ok('结构化视图「折叠全部」生效', allClosed);
      await page.click('#detail [data-body-fold="1"][data-body-kind="response"]');
      await sleep(250);
      const allOpen = await page.evaluate(
        () => [...document.querySelectorAll('#detail .json-fold details')].every((d) => d.open)
      );
      ok('结构化视图「展开全部」生效', allOpen);
      await page.click('#detail [data-body-mode="raw"][data-body-kind="response"]');
      await sleep(250);
      const rawOn = await page.evaluate(() => document.querySelector('#detail [data-body-mode="raw"][data-body-kind="response"]').classList.contains('on'));
      ok('详情「原始」视图可切换', rawOn === true);

      /* --------------------------------------------------- 结构化行号 + 详情全屏 */
      await page.click('#detail [data-body-mode="pretty"][data-body-kind="response"]');
      await sleep(250);
      const ln = await page.evaluate(() => {
        const leaf = document.querySelector('#detail .json-fold .jt-leaf');
        if (!leaf) return { has: false };
        const st = getComputedStyle(leaf, '::after');
        return { has: true, content: st.content };
      });
      ok('结构化视图带行号列', ln.has && ln.content && ln.content !== 'none' && ln.content !== 'normal', JSON.stringify(ln));
      const headLines = await page.evaluate(() => {
        const sec = [...document.querySelectorAll('#detail .sec')].find((s) => s.querySelector('.body-view'));
        return sec ? sec.querySelector('.sec-head .hint').textContent : '';
      });
      ok('sec 标题显示总行数', /\d+ 行/.test(headLines), headLines);
      await page.click('#detail [data-body-fs="response"]');
      await sleep(250);
      const fsOn = await page.evaluate(() => {
        const sec = document.querySelector('#detail .sec.body-fs');
        return sec && getComputedStyle(sec).position === 'fixed' && sec.getBoundingClientRect().height > 500;
      });
      ok('详情响应体进入全屏', fsOn === true);
      await page.keyboard.press('Escape');
      await sleep(250);
      const fsOff = await page.evaluate(() => !document.querySelector('#detail .sec.body-fs'));
      ok('Esc 退出详情全屏', fsOff === true);
      await page.click('#actReplay');
      await sleep(500);
      const replay = await page.evaluate(() => ({
        open: !document.querySelector('#modalReplay').hidden,
        monaco: document.querySelectorAll('#rpBodyEditor .monaco-editor').length,
        status: document.querySelector('#rpBodyStatus').textContent,
        source: document.querySelector('#rpBody').hidden,
      }));
      ok('重放请求体也换成 Monaco 编辑器', replay.open && replay.monaco === 1, JSON.stringify(replay));
      ok('重放隐藏 textarea 作为兼容数据源', replay.source === true);
      await page.click('#modalReplay [data-close]');
    } else {
      for (let i = 0; i < 5; i++) ok('详情/重放相关检查 ' + i, false, '没有流量');
    }

    /* --------------------------------------------- 主题 / 字号与编辑器联动 */
    await page.click('#btnRules');
    await page.click('#ruNew');
    await sleep(400);
    const lightBg = await page.evaluate(() => {
      const el = document.querySelector('#ruBodyEditor .monaco-editor-background');
      return el ? getComputedStyle(el).backgroundColor : '';
    });
    // 弹窗遮罩会挡住顶栏按钮，这里直接触发它们同一个 handler（验证联动而非点击可达性）
    const hit = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
    await hit('#btnTheme');
    await sleep(400);
    const dark = await page.evaluate(() => ({
      theme: window.ReqLiteJSON.theme,
      bg: (() => { const el = document.querySelector('#ruBodyEditor .monaco-editor-background'); return el ? getComputedStyle(el).backgroundColor : ''; })(),
    }));
    ok('切深色时 Monaco 主题同步', dark.theme === 'dark' && dark.bg !== lightBg, JSON.stringify({ lightBg, dark }));
    await hit('#btnTheme');
    await sleep(300);
    const fontSizeBefore = await page.evaluate(() => monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.fontSize));
    await hit('#fontUp');
    await sleep(350);
    const fontSizeAfter = await page.evaluate(() => monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.fontSize));
    ok('字号 + 时编辑器字号同步变大', fontSizeAfter > fontSizeBefore, `${fontSizeBefore} -> ${fontSizeAfter}`);
    await hit('#fontVal');
    await sleep(300);
    await page.click('#modalRule .modal-head [data-close]');
    // 单层弹窗的关闭按钮会 closeModals() 全关，规则列表此时已经一起关掉了

    ok('全程无 JS 报错', errs.length === 0, errs.join(' | '));
    ok('全程无 4xx 静态资源', fails.length === 0, fails.join(' | '));

    /* ------------------------------------------------- 二进制 body：预览 / Base64 / Hex / 下载 */
    const binR = await page.evaluate(async () => {
      // 造一条 1x1 PNG 的二进制 flow 走完整渲染链路
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const b64 = btoa(String.fromCharCode(...png));
      const sniff = typeof sniffMime === 'function' ? sniffMime(b64) : '';
      const bin = typeof binInfoOf === 'function' ? binInfoOf({ path: '/img/test?x=1', resBodyBase64: b64, resContentType: 'application/octet-stream', resSize: png.length }, 'response') : null;
      let previewOk = false, hexOk = false, dlOk = false;
      if (bin && document.querySelector('#detail')) {
        const holder = document.createElement('div');
        holder.innerHTML = bodySection('响应体', '1 B', '', 'application/octet-stream', 'response', bin);
        document.getElementById('detail').appendChild(holder);
        const img = holder.querySelector('.bin-preview img');
        previewOk = !!img && img.src.startsWith('data:image/png;base64,');
        dlOk = holder.querySelector('a.body-tool')?.getAttribute('download') === 'test.png';
        // 直接用 hex 模式再渲染一次验证 dump 内容（不走点击，避免触发真实 renderDetail 冲掉注入节点）
        const saved = S.bodyView.response;
        S.bodyView.response = { ...saved, mode: 'hex' };
        const hexHolder = document.createElement('div');
        hexHolder.innerHTML = bodySection('响应体', '1 B', '', 'application/octet-stream', 'response', bin);
        hexOk = /00000000  89 50 4e 47/.test(hexHolder.querySelector('.hex-view')?.textContent || '');
        S.bodyView.response = saved;
        holder.remove();
      }
      return { sniff, binMime: bin && bin.mime, isImage: bin && bin.isImage, name: bin && bin.name, previewOk, hexOk, dlOk };
    });
    ok('base64 头部嗅探出 image/png', binR.sniff === 'image/png' && binR.binMime === 'image/png', JSON.stringify(binR));
    ok('二进制默认图片预览（data URL）+ 自动补扩展名', binR.isImage && binR.name === 'test.png' && binR.previewOk, JSON.stringify(binR));
    ok('Hex 视图输出 PNG 魔数 dump + 下载文件名正确', binR.hexOk && binR.dlOk, JSON.stringify(binR));

    /* ------------------------------------------------- 头区块复制 / 原文行复制 */
    const hdrR = await page.evaluate(() => {
      if (!S.selected) return { skip: true };
      const out = {};
      window.__lastCopy = null;
      const origCopy = window.copyText;
      window.copyText = (t, msg) => { window.__lastCopy = { t, msg }; };
      try {
        // 请求页签：头区块工具条 + 行复制
        document.querySelector('[data-tab="request"]')?.click();
        const heads = Object.entries(S.selected.reqHeaders || {});
        out.firstKey = heads[0] && heads[0][0];
        out.copyAllBtn = !!document.querySelector('[data-hd-copy="req"]');
        out.copyJsonBtn = !!document.querySelector('[data-hd-json="req"]');
        out.hotRows = document.querySelectorAll('.kv.headers .kv-row.hot').length;
        document.querySelector('.kv.headers .kv-row')?.click();
        out.rowCopy = window.__lastCopy && window.__lastCopy.t === `${heads[0][0]}: ${heads[0][1]}`;
        window.__lastCopy = null;
        document.querySelector('[data-hd-json="req"]')?.click();
        out.jsonCopy = (() => { try { return JSON.stringify(JSON.parse(window.__lastCopy.t)) === JSON.stringify(S.selected.reqHeaders); } catch { return false; } })();
        window.__lastCopy = null;
        // 原始页签：行号行复制 + 仅状态行和头
        document.querySelector('[data-tab="raw"]')?.click();
        const lines = document.querySelectorAll('.raw-view .raw-line').length;
        out.rawLines = lines;
        document.querySelectorAll('.raw-view')[0].querySelectorAll('.raw-line')[1].click();
        const h0 = heads[0];
        out.lineCopy = window.__lastCopy && window.__lastCopy.t === `${h0[0]}: ${Array.isArray(h0[1]) ? h0[1].join('\n') : h0[1]}`;
        window.__lastCopy = null;
        document.querySelector('[data-raw-copy-heads="req"]')?.click();
        out.headsOnly = window.__lastCopy && !window.__lastCopy.t.includes('\n\n');
        out.headsLine1 = window.__lastCopy && window.__lastCopy.t.startsWith(`${S.selected.method} `);
      } finally {
        window.copyText = origCopy;
      }
      return out;
    });
    ok('头区块有「复制全部 / 复制 JSON」且关键头高亮', hdrR.copyAllBtn && hdrR.copyJsonBtn && hdrR.hotRows > 0, JSON.stringify(hdrR));
    ok('点击头行复制 name: value，复制 JSON 得到完整对象', hdrR.rowCopy && hdrR.jsonCopy, JSON.stringify(hdrR).slice(0, 200));
    ok('原文带行号、点击行复制、可仅复制状态行和头', hdrR.rawLines > 2 && hdrR.lineCopy && hdrR.headsOnly && hdrR.headsLine1, JSON.stringify(hdrR).slice(0, 200));
    await ctx.close();
  } catch (err) {
    ok('自检脚本执行完成（无异常中断）', false, err.stack || String(err));
  } finally {
    if (browser) await browser.close();
    // 清理：删除本次新建的规则，恢复原有顺序，清空自检流量
    try {
      const after = await api('/api/rules');
      for (const r of after) if (!beforeIds.includes(r.id)) await api('/api/rules/' + r.id, { method: 'DELETE' });
      if (beforeIds.length) await api('/api/rules/reorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: beforeIds }) });
      // 文件树自检残留清理
      await api('/api/rules/file?path=' + encodeURIComponent(TREE_DIR), { method: 'DELETE' }).catch(() => {});
      await api('/api/rules/file?path=' + encodeURIComponent(TREE_RULE + '.rule.json'), { method: 'DELETE' }).catch(() => {});
      await api('/api/flows', { method: 'DELETE' });
    } catch (e) {
      console.log('清理失败:', e.message);
    }
  }

  console.log('\n--- 结果 ---');
  for (const [name, pass] of checks) console.log(`${pass ? '✅' : '❌'} ${name}`);
  console.log(`共 ${checks.length} 项，通过 ${checks.filter((c) => c[1]).length} 项`);
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
})();
