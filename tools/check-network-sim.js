'use strict';

/**
 * 网络模拟自检：断网 / 弱网 / 超时在 HTTP 层与 CONNECT 层都生效，
 * 规则按 app / host / * 匹配，UI 面板与侧栏开关实时同步。
 *
 * 会修改 networkSim 配置并清空流量，故排在 check-all 的最后；结束前恢复现场。
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
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
const putSim = (sim) =>
  api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ networkSim: sim }),
  });
const SIM = (rules, over = {}) => ({
  enabled: true,
  latencyMs: 300,
  kbps: 32,
  timeoutMs: 900,
  rules,
  ...over,
});
const oneRule = (match, mode) => [{ id: 'net-test', match, mode }];

let TARGET_PORT = 0;
const target = http.createServer((req, res) => {
  if (req.url.startsWith('/big')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(64 * 1024, 7));
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  }
});

/** 明文 HTTP 经代理打到临时目标服务 */
function proxyGet(p, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${TARGET_PORT}${p}`,
        headers: { Host: `127.0.0.1:${TARGET_PORT}`, 'User-Agent': 'NetSimTest/1.0' },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => (bytes += c.length));
        res.on('end', () =>
          resolve({ ok: true, status: res.statusCode, bytes, ms: Date.now() - started })
        );
      }
    );
    r.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }));
    r.setTimeout(timeoutMs, () => r.destroy(new Error('client timeout')));
    r.end();
  });
}

/** CONNECT 层：正常情况下会收到 200 Connection Established */
function proxyConnect(host, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch (_) {
        /* noop */
      }
      resolve({ ...r, ms: Date.now() - started });
    };
    s.on('connect', () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    s.on('data', (d) => finish({ ok: true, reply: String(d).split('\r\n')[0] }));
    s.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    s.on('close', () => finish({ ok: false, error: 'closed' }));
    setTimeout(() => finish({ ok: false, error: 'client timeout' }), timeoutMs);
  });
}

const flows = async () => {
  const d = await api('/api/flows?limit=200');
  return Array.isArray(d) ? d : d.flows || d.items || [];
};

(async () => {
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  TARGET_PORT = target.address().port;

  // UA 别名让「按应用」的匹配目标可预测
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uaAppMapText: 'NetSimTest=测试应用' }),
  });
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  await putSim(SIM([]));
  await sleep(150);

  const base = await proxyGet('/small');
  ok('无规则时请求正常', base.ok && base.status === 200, JSON.stringify(base));

  // ---------- 断网 ----------
  await putSim(SIM(oneRule('host:127.0.0.1', 'offline')));
  const off = await proxyGet('/small');
  ok('断网：连接被重置', !off.ok, JSON.stringify(off));
  await sleep(180);
  let fl = await flows();
  const offFlow = fl.find((f) => f.simMode === 'offline');
  ok('断网：列表出现 status=0 的模拟 flow', !!offFlow && offFlow.status === 0, JSON.stringify(offFlow || {}));
  ok('断网：flow 记下命中的规则', !!offFlow && offFlow.simRule === 'host:127.0.0.1');

  await putSim(SIM(oneRule('app:测试应用', 'offline')));
  ok('按应用名匹配生效', !(await proxyGet('/small')).ok);
  await putSim(SIM(oneRule('app:不存在的应用', 'offline')));
  ok('不匹配的应用不受影响', (await proxyGet('/small')).ok);
  await putSim(SIM(oneRule('*', 'offline')));
  ok('* 命中全部流量', !(await proxyGet('/small')).ok);

  // ---------- 超时 ----------
  await putSim(SIM(oneRule('*', 'timeout'), { timeoutMs: 700 }));
  const to = await proxyGet('/small', 5000);
  ok('超时：挂起后才断开', !to.ok && to.ms >= 600, JSON.stringify(to));
  await sleep(180);
  fl = await flows();
  const toFlow = fl.find((f) => f.simMode === 'timeout');
  ok('超时：flow 标记与时长', !!toFlow && toFlow.duration >= 600, JSON.stringify(toFlow || {}));

  // ---------- 弱网 ----------
  await putSim(SIM(oneRule('*', 'weak'), { latencyMs: 300, kbps: 32 }));
  const slow = await proxyGet('/small');
  ok('弱网：附加延迟生效', slow.ok && slow.ms >= 280, JSON.stringify(slow));
  const big = await proxyGet('/big', 15000);
  ok('弱网：大响应被限速', big.ok && big.ms > slow.ms + 400, `small=${slow.ms}ms big=${big.ms}ms`);
  await sleep(180);
  fl = await flows();
  ok('弱网：flow 标记', fl.some((f) => f.simMode === 'weak'));

  // ---------- CONNECT 层 ----------
  await putSim(SIM([]));
  const connOK = await proxyConnect('netsim.example.test', 4000);
  ok('CONNECT 基线建立隧道', connOK.ok && /200/.test(connOK.reply || ''), JSON.stringify(connOK));
  await putSim(SIM(oneRule('*', 'offline')));
  const connOff = await proxyConnect('netsim.example.test', 4000);
  ok('CONNECT 断网立刻重置', !connOff.ok && connOff.ms < 800, JSON.stringify(connOff));
  await sleep(180);
  fl = await flows();
  ok('CONNECT 断网留下记录', fl.some((f) => f.method === 'CONNECT' && f.simMode === 'offline'));
  await putSim(SIM(oneRule('*', 'timeout'), { timeoutMs: 700 }));
  const connTo = await proxyConnect('netsim.example.test', 4000);
  ok('CONNECT 超时挂起', !connTo.ok && connTo.ms >= 600, JSON.stringify(connTo));

  // ---------- 总开关 / 会话级 ----------
  await putSim(SIM(oneRule('*', 'offline'), { enabled: false }));
  ok('总开关关闭后规则暂停', (await proxyGet('/small')).ok);
  const uc = fs.readFileSync(path.join(ROOT, 'src', 'user-config.js'), 'utf8');
  ok('网络模拟不落盘（重启自动恢复）', !/networkSim/.test(uc));

  // ---------- UI ----------
  await putSim(SIM(oneRule('*', 'offline')));
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(UI + '/', { waitUntil: 'networkidle' });
  // S 是顶层 const，不是 window 属性；等 loadStatus 把角标刷出来即可
  await page.waitForFunction(
    () => document.querySelector('#btnNetwork') && document.querySelector('#netCount')?.textContent === '1',
    null,
    { timeout: 10000 }
  );
  ok('顶栏角标显示规则数', (await page.locator('#netCount').innerText()) === '1');
  await page.click('#btnNetwork');
  await page.waitForSelector('#modalNetwork:not([hidden])');
  ok('面板规则行渲染', (await page.locator('#netRules .net-rule').count()) === 1);
  ok('参数回显', (await page.locator('#netLatency').inputValue()) === '300');
  ok('候选 chips 含全部流量', (await page.locator('[data-net-quick="*"]').count()) === 1);
  ok('列表出现模拟角标', (await page.locator('.tag.sim').count()) > 0);

  await page.selectOption('#netRules .net-mode', 'weak');
  await sleep(700);
  let cfg = await api('/api/config');
  ok('面板改模式即时保存', cfg.networkSim.rules[0].mode === 'weak', JSON.stringify(cfg.networkSim.rules));

  const dot = page.locator('.net-dot').first();
  ok('侧栏应用行有快捷开关', (await dot.count()) > 0);
  if (await dot.count()) {
    // 弹窗是全屏遮罩，会挡住侧栏；真实使用时两者也不会同时操作
    await page.evaluate(() => closeModals());
    await dot.click();
    await sleep(200);
    const modeItems = await page.locator('#ctxMenu:not([hidden]) [data-net-set]').count();
    ok('侧栏点开关弹出四种模式', modeItems === 4, String(modeItems));
    await page.click('#ctxMenu [data-net-set="offline"]');
    await sleep(700);
    cfg = await api('/api/config');
    ok('侧栏一键开关新增 app 规则', cfg.networkSim.rules.some((r) => r.match.startsWith('app:')));
    await page.click('#btnNetwork');
    await page.waitForSelector('#modalNetwork:not([hidden])');
  }

  // SSE：外部改配置，已打开的窗口要跟着变
  await putSim(SIM(oneRule('*', 'timeout'), { timeoutMs: 900 }));
  await page
    .waitForFunction(() => {
      const el = document.querySelector('#netRules .net-mode');
      return el && el.value === 'timeout';
    }, null, { timeout: 5000 })
    .catch(() => {});
  cfg = await api('/api/config');
  ok('SSE 同步其它窗口的配置变更', cfg.networkSim.rules[0].mode === 'timeout');
  ok('SSE 后面板跟着刷新', (await page.locator('#netRules .net-mode').inputValue()) === 'timeout');

  await page.evaluate(() => {
    window.ReqLiteI18N.setLang('en');
    renderNetPanel();
  });
  await sleep(250);
  ok('英文标题', (await page.locator('#modalNetwork .modal-head h2').innerText()) === 'Network Simulation');
  const opts = await page.locator('#netRules .net-mode option').allInnerTexts();
  ok('英文模式选项无中文残留', opts.every((t) => !/[\u4e00-\u9fa5]/.test(t)), opts.join('|'));
  ok('英文模式按钮', (await page.locator('#netAllOff').innerText()) === 'Block all');
  await page.evaluate(() => window.ReqLiteI18N.setLang('auto'));
  ok('UI 无 JS 报错', errs.length === 0, errs.join(';'));

  await browser.close();

  // ---------- 现场恢复 ----------
  await putSim(SIM([]));
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  await fetch(UI + '/api/diagnostics', { method: 'DELETE' });
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uaAppMapText: '' }),
  });
  target.close();
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await putSim(SIM([]));
  } catch (_) {
    /* noop */
  }
  target.close();
  process.exit(1);
});
