'use strict';

/**
 * 自检：断网 / 弱网「点了真的有用」。
 *
 * 回归点（都是真机上踩过的坑）：
 *  1. 控制坞原来的开关只翻 enabled 布尔值，默认规则是空的 —— 点来点去没有任何
 *     请求被拦。现在单击必须落一条 * 规则，再点撤销。
 *  2. 规则只在新连接进来时判定。App 复用已建好的 keep-alive / CONNECT 隧道时，
 *     中途打开断网完全无效 —— 配置变更必须切断受影响的存量连接。
 *  3. 不能一刀切全断：只断「新旧规则解析结果不同」的连接。
 *
 * 会修改 networkSim 配置，放一键回归末段；结束前恢复现场。
 */
const http = require('http');
const net = require('net');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log('✅ ' + name);
  } else {
    fail++;
    console.log('❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opt) => {
  const r = await fetch(UI + p, opt);
  return r.json().catch(() => ({}));
};
const putSim = (networkSim) =>
  api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ networkSim }),
  });
const SIM = (rules, over = {}) => ({
  enabled: true,
  latencyMs: 500,
  kbps: 16,
  timeoutMs: 1200,
  rules,
  ...over,
});
const rule = (match, mode) => ({ id: 'net-live-' + match.replace(/\W/g, ''), match, mode });

const target = http.createServer((req, res) => {
  const n = req.url.startsWith('/big') ? 48 * 1024 : 16;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': n });
  res.end(Buffer.alloc(n, 7));
});
target.keepAliveTimeout = 60000;
const echo = net.createServer((s) => s.pipe(s));

/** 经代理打本地上游，返回 { ok, ms, bytes } */
function proxyGet(path, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${target.address().port}${path}`,
        headers: { Host: `127.0.0.1:${target.address().port}` },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => (bytes += c.length));
        res.on('end', () => resolve({ ok: true, bytes, ms: Date.now() - t }));
      }
    );
    r.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t }));
    r.setTimeout(timeoutMs, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

/** 建一条透传 CONNECT 隧道（非 443 端口一定走 passthrough，不需要证书） */
function openTunnel(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PROXY_PORT, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => reject(new Error('CONNECT timeout')), 4000);
    socket.on('connect', () =>
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    );
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      if (!/^HTTP\/1\.1 200/.test(buf)) return reject(new Error(buf.split('\r\n')[0]));
      resolve({ socket });
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 往隧道里写一个标记，看是否还能 echo 回来（收不到 = 连接已被切断） */
function tunnelEcho(t, tag, ms = 800) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      t.socket.removeListener('data', onData);
      t.socket.removeListener('close', onClose);
      clearTimeout(timer);
      resolve(v);
    };
    const onData = (d) => { if (d.toString('latin1').includes(tag)) finish(true); };
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    t.socket.on('data', onData);
    t.socket.on('close', onClose);
    t.socket.write(tag);
  });
}

const closeTunnel = (t) => { try { t.socket.destroy(); } catch (_) {} };

(async () => {
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  await new Promise((r) => echo.listen(9399, '127.0.0.1', r));
  await putSim(SIM([]));
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  await sleep(120);

  const baseline = await proxyGet('/small');
  ok('起点：无规则时请求正常', baseline.ok, JSON.stringify(baseline));

  /* ---------- A. 存量长连接：规则变更后必须断 ---------- */
  const t1 = await openTunnel('127.0.0.1', 9399);
  ok('存量 CONNECT 隧道可往返', await tunnelEcho(t1, 'PING-1'));
  await putSim(SIM([rule('*', 'offline')]));
  await sleep(150);
  ok('隧道建好后再开全部断网：存量连接被切断', !(await tunnelEcho(t1, 'PING-2')));
  closeTunnel(t1);

  /* ---------- B. 不误伤：规则不匹配的连接保持原样 ---------- */
  await putSim(SIM([]));
  const t2 = await openTunnel('127.0.0.1', 9399);
  ok('恢复后新隧道可往返', await tunnelEcho(t2, 'PING-3'));
  await putSim(SIM([rule('host:not-match.example', 'offline')]));
  await sleep(150);
  ok('规则不匹配时：存量连接不被误断', await tunnelEcho(t2, 'PING-4'));
  closeTunnel(t2);
  await putSim(SIM([]));
  await sleep(100);

  /* ---------- C. 控制坞一键：UI 点击 → 真实流量立刻变化 ---------- */
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(UI + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#dockOffline'), null, { timeout: 10000 });
  ok('控制坞新增「断网」按钮', (await page.locator('#dockOffline').count()) === 1);
  ok('初始两个一键按钮都不亮', await page.evaluate(() =>
    !document.querySelector('#dockOffline').classList.contains('on') &&
    !document.querySelector('#dockNet').classList.contains('weak-on')
  ));

  // 弱网：点一下必须真的落规则，并让请求变慢
  await page.click('#dockNet');
  await page.waitForFunction(async () => {
    const c = await (await fetch('/api/config')).json();
    return c.networkSim.rules.some((r) => r.match === '*' && r.mode === 'weak');
  }, null, { timeout: 5000 }).catch(() => {});
  let cfg = await api('/api/config');
  const globalRule = cfg.networkSim.rules.find((r) => r.match === '*');
  ok('单击弱网：自动生成全局 * 规则', cfg.networkSim.enabled === true && !!globalRule && globalRule.mode === 'weak',
    JSON.stringify(cfg.networkSim.rules));
  ok('单击弱网：按钮点亮', await page.evaluate(() =>
    document.querySelector('#dockNet').classList.contains('weak-on')
  ));
  const slow = await proxyGet('/small');
  ok('单击弱网：真实请求被加上延迟', slow.ok && slow.ms >= 430, JSON.stringify(slow));

  // 断网：切到另一个模式，存量全局规则被替换而不是叠加
  await page.click('#dockOffline');
  await page.waitForFunction(async () => {
    const c = await (await fetch('/api/config')).json();
    return c.networkSim.rules.some((r) => r.match === '*' && r.mode === 'offline');
  }, null, { timeout: 5000 }).catch(() => {});
  cfg = await api('/api/config');
  ok('单击断网：全局规则切为 offline 且不重复',
    cfg.networkSim.rules.length === 1 && cfg.networkSim.rules[0].mode === 'offline',
    JSON.stringify(cfg.networkSim.rules));
  ok('单击断网：断网按钮亮、弱网按钮不亮', await page.evaluate(() =>
    document.querySelector('#dockOffline').classList.contains('on') &&
    !document.querySelector('#dockNet').classList.contains('weak-on')
  ));
  const blocked = await proxyGet('/small');
  ok('单击断网：真实请求被重置', !blocked.ok, JSON.stringify(blocked));
  await sleep(200);
  const st = await api('/api/status');
  ok('模拟计数增长（证明真的拦到了）', (st.stats.simulated || 0) >= 1, JSON.stringify(st.stats));
  const fl = await api('/api/flows?limit=100');
  const list = Array.isArray(fl) ? fl : fl.flows || [];
  ok('列表出现 offline 模拟记录', list.some((f) => f.simMode === 'offline'));

  // 面板状态条
  await page.click('#btnNetwork');
  await page.waitForSelector('#modalNetwork:not([hidden])');
  ok('状态条显示当前全局模式', (await page.textContent('#netLiveText')).trim() === '全部流量：断网');
  ok('状态条显示已模拟条数', /已模拟 \d+ 条请求/.test((await page.textContent('#netHit')).trim()));
  await page.keyboard.press('Escape');
  await sleep(150);

  // 再点一次 = 撤销，流量恢复
  await page.click('#dockOffline');
  await page.waitForFunction(async () => {
    const c = await (await fetch('/api/config')).json();
    return !c.networkSim.rules.some((r) => r.match === '*');
  }, null, { timeout: 5000 }).catch(() => {});
  const restored = await proxyGet('/small');
  ok('再点断网：撤销全局规则且流量恢复', restored.ok && restored.ms < 400, JSON.stringify(restored));
  ok('撤销后两个按钮都不亮', await page.evaluate(() =>
    !document.querySelector('#dockOffline').classList.contains('on') &&
    !document.querySelector('#dockNet').classList.contains('weak-on')
  ));

  // 右键仍直达设置
  await page.click('#dockOffline', { button: 'right' });
  await sleep(350);
  ok('右键断网打开网络模拟设置', await page.evaluate(() => !document.querySelector('#modalNetwork').hidden));
  await page.keyboard.press('Escape');

  // 英文模式
  await page.evaluate(() => window.ReqLiteI18N.setLang('en'));
  await sleep(300);
  ok('英文：dock 无中文残留', await page.evaluate(() =>
    !/[\u4e00-\u9fff]/.test(document.querySelector('#dock').textContent)
  ));
  await page.click('#dockNet');
  await sleep(350);
  await page.click('#btnNetwork');
  await page.waitForSelector('#modalNetwork:not([hidden])');
  ok('英文：状态条无中文残留', await page.evaluate(() =>
    !/[\u4e00-\u9fff]/.test(document.querySelector('#netLive').textContent)
  ));
  await page.evaluate(() => window.ReqLiteI18N.setLang('auto'));
  ok('UI 无 JS 报错', errs.length === 0, errs.join(';'));
  await browser.close();

  /* ---------- 现场恢复 ---------- */
  await putSim(SIM([]));
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  target.close();
  echo.close();
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await putSim(SIM([])); } catch (_) {}
  target.close();
  echo.close();
  process.exit(1);
});
