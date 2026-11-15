'use strict';

/**
 * 自检：请求标注（备注 / 颜色 / 重点）
 * ---------------------------------------------------------------------------
 * ① 存储：合并语义、三种字段都空时删除、颜色白名单、备注截断、条数上限
 * ② 落盘：写到 data/annotations.json，重开一个实例还在（用同一文件再读一次验证）
 * ③ 接口：PUT / DELETE / 列表与详情带标注 / 不存在的 id 404
 * ④ 出口：导出 HAR 的 _iReq 带 note/color/pinned；总览报告有「标注过的请求」
 * ⑤ 界面：右键菜单能开面板、选颜色保存、行上出现色条与星标、备注徽标、
 *    再次打开能读回、删除后恢复、英文模式零残留
 *
 * 会改自己的标注并清空流量，结束时删标注、删历史。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Annotations, COLORS, NOTE_MAX } = require('../src/annotations');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonApi = async (p, opts = {}) => {
  const res = await fetch(UI + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
};

function viaProxy(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: `http://127.0.0.1:${port}${p}`, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  /* ------------------------------------------------------------ ① 存储 */
  {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ireq-annot-'));
    const a = new Annotations({ file: path.join(dir, 'annotations.json') });
    ok('空文件读出空表', a.stats().total === 0);
    const one = a.set('f1', { note: '第一条' });
    ok('写入后能读回', one && one.note === '第一条' && a.get('f1').note === '第一条');
    a.set('f1', { color: 'RED' });
    ok('合并语义：只改传进来的字段', a.get('f1').note === '第一条' && a.get('f1').color === 'red', JSON.stringify(a.get('f1')));
    a.set('f1', { color: 'chartreuse' });
    ok('非法颜色被忽略', a.get('f1').color === 'red');
    a.set('f2', { note: 'x'.repeat(NOTE_MAX + 50) });
    ok('备注截断到上限', a.get('f2').note.length === NOTE_MAX, a.get('f2').note.length);
    a.set('f3', { note: '', color: '', pinned: false });
    ok('三个字段都空等于删除', a.get('f3') === null);
    a.set('f4', { pinned: true });
    ok('只置重点也算一条', a.stats().pinned === 1 && a.stats().total === 3, JSON.stringify(a.stats()));
    ok('颜色白名单给出', JSON.stringify(a.stats().colors) === JSON.stringify(COLORS));

    // 上限：超过 max 时淘汰最早那条
    const small = new Annotations({ file: '', max: 2 });
    small.set('a', { note: '1' });
    small.set('b', { note: '2' });
    small.set('c', { note: '3' });
    ok('超过上限淘汰最早的', small.get('a') === null && small.get('c') !== null && small.stats().total === 2);

    // apply 不改原对象
    const flow = { id: 'f1', url: 'x' };
    const merged = a.apply(flow);
    ok('apply 不修改原对象', merged.note === '第一条' && flow.note === undefined);
    ok('没有标注的 flow 原样返回', a.apply({ id: 'nope' }).note === undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------ ② 落盘 */
  {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ireq-annot2-'));
    const file = path.join(dir, 'annotations.json');
    const a = new Annotations({ file });
    a.set('persist-1', { note: '重启也要在', color: 'blue' });
    a.save();
    const b = new Annotations({ file });
    ok('重新加载后还在', b.get('persist-1') && b.get('persist-1').note === '重启也要在');
    ok('颜色一并恢复', b.get('persist-1').color === 'blue');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------ 造流量 */
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":1}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await viaProxy(port, '/annot-target');
  await wait(250);

  const list = (await jsonApi('/api/flows?limit=10')).body;
  const flow = (list || []).find((f) => String(f.path || '').startsWith('/annot-target'));
  ok('抓到目标流量', !!flow, flow && flow.id);

  /* ------------------------------------------------------------ ③ 接口 */
  let markId = flow ? flow.id : '';
  if (flow) {
    const bad = await jsonApi('/api/flows/not-a-real-id/annotation', { method: 'PUT', body: { note: 'x' } });
    ok('不存在的 id 回 404', bad.status === 404, bad.status);

    const put = await jsonApi(`/api/flows/${flow.id}/annotation`, {
      method: 'PUT',
      body: { note: '登录后第一次点击超时', color: 'red', pinned: true },
    });
    ok('保存成功', put.status === 200 && put.body.annotation.note.includes('超时'));
    const got = (await jsonApi('/api/flows/' + flow.id)).body;
    ok('详情带备注与颜色', got.note === '登录后第一次点击超时' && got.color === 'red' && got.pinned === true);
    const inList = (await jsonApi('/api/flows?limit=10')).body.find((f) => f.id === flow.id);
    ok('列表也带标注', inList && inList.note && inList.color === 'red');

    const patch = await jsonApi(`/api/flows/${flow.id}/annotation`, { method: 'PUT', body: { pinned: false } });
    ok('合并更新不动备注', patch.body.annotation.note.includes('超时') && patch.body.annotation.pinned === false);

    const stats = (await jsonApi('/api/annotations')).body;
    ok('统计接口给数量', stats.total >= 1 && Array.isArray(stats.colors) && stats.colors.length === 6);
  }

  /* ------------------------------------------------------------ ④ 出口 */
  if (flow) {
    await jsonApi(`/api/flows/${flow.id}/annotation`, {
      method: 'PUT',
      body: { note: '登录后第一次点击超时', color: 'red', pinned: true },
    });
    const har = await (await fetch(UI + '/api/export/har?limit=20')).json();
    const entry = har.log.entries.find((e) => String(e.request.url).includes('/annot-target'));
    ok('HAR 的 _iReq 带备注', entry && entry._iReq && entry._iReq.note === '登录后第一次点击超时');
    ok('HAR 的 _iReq 带颜色与重点', entry && entry._iReq.color === 'red' && entry._iReq.pinned === true);

    const md = await (await fetch(UI + '/api/overview/report.md?limit=20')).text();
    ok('报告有标注段', md.includes('## 标注过的请求'));
    ok('报告里带备注原文', md.includes('登录后第一次点击超时'));
    ok('重点请求带星标', /★ `GET .*annot-target/.test(md), md.split('\n').find((l) => l.includes('★')) || '');
  }

  /* ------------------------------------------------------------ ⑤ 界面 */
  {
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');

    // 右键「备注与颜色…」
    const row = await page.$('.row:has-text("/annot-target")');
    ok('列表里能找到目标行', !!row);
    if (row) {
      await row.click({ button: 'right' });
      await page.waitForSelector('#ctxMenu:not([hidden])');
      const item = await page.$('#ctxMenu [data-cmd="note"]');
      ok('右键菜单有备注入口', !!item);
      await item.click();
      await page.waitForSelector('#modalNote:not([hidden])');
      await page.waitForTimeout(300);
      ok('面板能带出已有备注', (await page.inputValue('#ntText')).includes('超时'));
      ok('颜色有六个可选项', (await page.$$('#ntColors .nt-sw')).length === 7); // 6 色 + 无颜色

      await page.fill('#ntText', '界面写的备注');
      await page.click('#ntColors .nt-sw.sw-blue');
      await page.click('#ntSave');
      await page.waitForTimeout(600);

      const saved = (await jsonApi('/api/flows/' + markId)).body;
      ok('界面保存生效', saved.note === '界面写的备注' && saved.color === 'blue');
      const marked = await page.$('.row.mark-blue');
      ok('行上出现色条', !!marked);
      const star = await page.$('.row.mark-blue .pin');
      ok('行上有重点星标', !!star);
      const badge = await page.$('.row .tag.note');
      ok('行上有备注徽标', !!badge);
      const title = await page.$eval('.row.mark-blue', (el) => el.getAttribute('title'));
      ok('行 title 是备注内容', title === '界面写的备注', title);

      // 取消重点 + 删除备注
      await page.click('.row.mark-blue', { button: 'right' });
      await page.waitForSelector('#ctxMenu:not([hidden])');
      const pinItem = await page.$('#ctxMenu [data-cmd="pin"]');
      ok('菜单里显示「取消重点」', pinItem && /取消重点/.test(await pinItem.innerText()));
      await pinItem.click();
      await page.waitForTimeout(500);
      ok('取消重点后不再有星标', !(await page.$('.row .pin')));

      await page.click('.row', { button: 'right' });
      await page.waitForSelector('#ctxMenu:not([hidden])');
      await page.click('#ctxMenu [data-cmd="note"]');
      await page.waitForSelector('#modalNote:not([hidden])');
      await page.click('#ntRemove');
      await page.waitForTimeout(500);
      const after = (await jsonApi('/api/flows/' + markId)).body;
      ok('删除后备注清空', !after.note && !after.color);
    }

    // 英文模式
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await page.waitForTimeout(700);
    const row2 = await page.$('.row:has-text("/annot-target")');
    if (row2) {
      await row2.click({ button: 'right' });
      await page.waitForSelector('#ctxMenu:not([hidden])');
      const menuText = await page.$eval('#ctxMenu', (el) => el.innerText);
      ok('英文菜单零残留', !/[\u4e00-\u9fff]/.test(menuText), menuText.replace(/\n/g, ' | '));
      await page.click('#ctxMenu [data-cmd="note"]');
      await page.waitForSelector('#modalNote:not([hidden])');
      await page.waitForTimeout(300);
      const en = await page.$eval('#modalNote', (el) => el.innerText.replace(/\s+/g, ' '));
      ok('英文面板零残留', !/[\u4e00-\u9fff]/.test(en), (en.match(/[\u4e00-\u9fff]/g) || []).join(''));
      await page.keyboard.press('Escape');
    }
    await page.click('#btnMore');
    await page.click('#btnLang');
    await wait(200);
    await browser.close();
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
  }

  /* ------------------------------------------------------------ 清理 */
  if (markId) await jsonApi('/api/flows/' + markId + '/annotation', { method: 'DELETE' });
  srv.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  await wait(300);
  const hist = (await jsonApi('/api/history')).body;
  const item = (hist.items || [])[0];
  if (item) await jsonApi('/api/history/' + item.id, { method: 'DELETE' });

  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exit(1);
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
