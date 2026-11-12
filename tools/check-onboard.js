'use strict';

/**
 * 首启引导自检（自己起一个干净实例，不连外部环境）
 *
 * 为什么自起：引导是「一次性」行为 —— 只要 data/config.json 里写过 onboarded，
 * 之后永远不弹。复用 check-all 的实例根本测不到首启路径，只能靠独立数据目录。
 *
 * 覆盖：首启出现 / 三步内容 / 反馈入口链接 / 英文无中文残留 /
 *       关闭后落盘 / 刷新不再弹 / 只允许置 true 的护栏。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium, EXEC } = require('./_pw');

const ROOT = path.join(__dirname, '..');
const results = [];

function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${pass || !detail ? '' : ' — ' + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ireq-onboard-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const [proxyPort, uiPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${uiPort}`;

  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'bin', 'ireq.js'), 'start', '-p', String(proxyPort), '-u', String(uiPort),
      '--data', dataDir, '--no-persist'],
    { cwd: ROOT, env: { ...process.env, REQLITE_CA_DIR: path.join(tmp, 'ca') }, stdio: 'ignore' }
  );

  let browser = null;
  try {
    const ready = await waitFor(base + '/api/status');
    assert(ready, '实例没起来');
    const st0 = await (await fetch(base + '/api/status')).json();
    ok('干净实例初始 onboarded=false', st0.onboarded === false, JSON.stringify(st0.onboarded));

    browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, locale: 'zh-CN' });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    /* ---------- 首启弹窗 ---------- */
    ok('首次打开弹出引导', await page.isVisible('#modalWelcome'));
    ok('标题正确', (await page.locator('#modalWelcome .modal-head h2').innerText()).includes('欢迎使用 iReq'));

    const steps = await page.evaluate(() =>
      [...document.querySelectorAll('#modalWelcome .welcome-steps li')].map((li) => ({
        num: (li.querySelector('.welcome-num') || {}).textContent || '',
        title: (li.querySelector('b') || {}).textContent || '',
        body: (li.querySelector('.welcome-step-text span') || {}).textContent || '',
      }))
    );
    ok('三步闭环齐全（序号 1/2/3）', steps.length === 3 && steps.map((s) => s.num.trim()).join() === '1,2,3',
      JSON.stringify(steps.map((s) => s.num)));
    ok('三步都有标题与说明', steps.every((s) => s.title.trim() && s.body.trim().length > 10),
      JSON.stringify(steps.map((s) => s.title)));
    // 飞轮的三环必须是「能提 → 会分流 → 会进版本」，缺一环承诺就不成立
    const joined = steps.map((s) => s.title + s.body).join(' ');
    ok('讲清了「反馈 → 分流 → 进版本」这条链',
      /提/.test(joined) && /分流|分类/.test(joined) && /版本/.test(joined), joined.slice(0, 80));

    const fb = await page.evaluate(() => {
      const a = document.querySelector('#wlFeedback');
      return a ? { href: a.href, target: a.target, rel: a.rel } : null;
    });
    ok('反馈入口直达 GitHub issue 选择页',
      fb && /github\.com\/.+\/issues\/new\/choose$/.test(fb.href), fb && fb.href);
    ok('反馈入口新窗口打开且带 noreferrer', fb && fb.target === '_blank' && /noreferrer/.test(fb.rel));

    /* ---------- 英文界面 ---------- */
    await page.evaluate(() => window.ReqLiteI18N && window.ReqLiteI18N.setLang('en'));
    await page.waitForTimeout(400);
    const en = await page.evaluate(() => ({
      title: (document.querySelector('#modalWelcome .modal-head h2') || {}).textContent || '',
      hint: (document.querySelector('#modalWelcome .welcome-foot-hint') || {}).textContent || '',
      start: (document.querySelector('#wlStart') || {}).textContent || '',
      hasHan: /[\u4e00-\u9fff]/.test(document.querySelector('#modalWelcome').innerText),
    }));
    ok('英文模式标题已翻译', /Welcome/i.test(en.title), en.title);
    ok('英文模式无中文残留', !en.hasHan, en.title + ' / ' + en.hint + ' / ' + en.start);
    await page.evaluate(() => window.ReqLiteI18N && window.ReqLiteI18N.setLang('zh-CN'));
    await page.waitForTimeout(300);

    /* ---------- 关闭后落盘 ---------- */
    await page.click('#wlStart');
    await page.waitForTimeout(600);
    ok('点「开始使用」后弹窗关闭', !(await page.isVisible('#modalWelcome')));
    const st1 = await (await fetch(base + '/api/status')).json();
    ok('看过标记已落盘', st1.onboarded === true, JSON.stringify(st1.onboarded));

    // 护栏：前端不该能把标记翻回 false，否则每次刷新都弹一遍
    await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onboarded: false }),
    });
    const st2 = await (await fetch(base + '/api/status')).json();
    ok('标记只允许置 true（PUT false 无效）', st2.onboarded === true, JSON.stringify(st2.onboarded));

    /* ---------- 刷新不再弹 ---------- */
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    ok('刷新后不再弹引导', !(await page.isVisible('#modalWelcome')));

    /* ---------- 入口仍在（不能只靠首启这一次机会） ---------- */
    await page.click('#btnMore');
    await page.waitForTimeout(300);
    const entry = await page.evaluate(() => {
      const a = document.querySelector('#btnFeedback');
      return a ? { href: a.href, visible: !!a.offsetParent } : null;
    });
    ok('「更多」菜单里仍保留反馈入口', entry && entry.visible && /issues\/new\/choose/.test(entry.href), JSON.stringify(entry));

    /* ---------- config.json 里确实只写了 true ---------- */
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    ok('config.json 已写入 onboarded: true', cfg.onboarded === true, JSON.stringify(cfg.onboarded));
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      child.kill('SIGTERM');
    } catch (_) {
      /* noop */
    }
    await sleep(300);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* noop */
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
