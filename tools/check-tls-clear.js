'use strict';

/**
 * 自检：握手失败诊断行「处理后立即消失」。
 *
 * 回归点（用户反馈：加入跳过解密后，TLS 失败记录还一直顶在列表最上面）：
 *  1. 后端 clearTlsFailures()：按域名 / 规则（含子域）删除，只在删到东西时广播 tls-remove。
 *  2. /api/config PUT 写入 passthrough 后，被覆盖域名的诊断记录立即清除并同步到所有窗口。
 *  3. 已加白名单的域名即使旧连接晚一点报错，也不会把诊断行「复活」。
 *  4. 诊断行 ✕ 可忽略单条（服务端一并删除），不影响其它域名。
 *  5. 详情「加入跳过解密」按钮：行、角标、选中详情一起清干净。
 *
 * 只造「CONNECT 后立刻断开」的握手失败，不依赖外网；结束前恢复 passthrough 配置。
 * 会清空流量 / 诊断数据，所以在一键回归里排在末尾段。
 */
const net = require('net');
const { EventEmitter } = require('events');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const { ProxyServer, passthroughMatches } = require('../src/proxy');

const RULE = 'example.test';
const HOST_A = 'pin.example.test';
const HOST_B = 'deep.pin.example.test';
const HOST_C = 'other.test';
const HOST_D = 'pin2.other.test';

const checks = [];
const push = (name, ok, extra) => checks.push([name, Boolean(ok), extra || '']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

const jsonOpts = (body, method = 'PUT') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function waitUi() {
  for (let i = 0; i < 40; i++) {
    try {
      await api('/api/status');
      return true;
    } catch (_) {
      await sleep(500);
    }
  }
  return false;
}

/** CONNECT 之后立刻断开：TLS 握手必然失败，但不需要真外网 */
function abruptHandshake(host) {
  return new Promise((resolve) => {
    const sock = net.connect(PROXY_PORT, '127.0.0.1');
    sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    sock.once('data', () => { sock.destroy(); resolve('reset'); });
    sock.on('error', () => resolve('error'));
    setTimeout(() => { sock.destroy(); resolve('timeout'); }, 3000);
  });
}

const diagHosts = (d) => (d.tlsFailures || []).map((f) => f.host).sort();

(async () => {
  push('隔离服务可达', await waitUi());
  const cfg0 = await api('/api/config');
  const savedPassthrough = cfg0.passthrough || [];
  let browser;

  // 单元：规则匹配 + 按规则级联删除（不需要真代理实例）
  push('规则匹配：自身域名', passthroughMatches('example.test', [RULE]));
  push('规则匹配：子域', passthroughMatches(HOST_A, [RULE]));
  push('规则匹配：多级子域 + *. 前缀', passthroughMatches(HOST_B, ['*.' + RULE]));
  push('规则匹配：大小写不敏感', passthroughMatches('PIN.Example.Test', [RULE]));
  push('规则匹配：相似域名不误伤', !passthroughMatches('notexample.test', [RULE]));
  push('规则匹配：空规则不误伤', !passthroughMatches(HOST_A, ['', '  ']));

  const fake = Object.create(ProxyServer.prototype);
  EventEmitter.call(fake);
  fake.config = { passthrough: [] };
  fake.tlsFailures = new Map([
    [HOST_A, { host: HOST_A, count: 1 }],
    [HOST_B, { host: HOST_B, count: 2 }],
    [HOST_C, { host: HOST_C, count: 3 }],
  ]);
  let events = [];
  fake.on('tls-remove', (e) => events.push(e));
  const removed = fake.clearTlsFailures('*.' + RULE);
  push('级联删除：一次清掉自身与所有子域', removed === 2 && fake.tlsFailures.size === 1, 'removed=' + removed);
  push('级联删除：保留不相关域名', fake.tlsFailures.has(HOST_C));
  push('级联删除：广播被删的域名', events.length === 1 && events[0].hosts.sort().join() === [HOST_A, HOST_B].sort().join(), JSON.stringify(events));
  events = [];
  push('级联删除：删不到时不广播', fake.clearTlsFailures(HOST_A) === 0 && events.length === 0);

  try {
    await api('/api/config', jsonOpts({ passthrough: [] }));
    await api('/api/diagnostics', { method: 'DELETE' });
    await api('/api/flows', { method: 'DELETE' });

    // 三个域名各造一次握手失败
    await Promise.all([abruptHandshake(HOST_A), abruptHandshake(HOST_B), abruptHandshake(HOST_C)]);
    await sleep(900);
    const diag0 = await api('/api/diagnostics');
    push('后端先记下三条诊断', diagHosts(diag0).join() === [HOST_A, HOST_B, HOST_C].sort().join(), JSON.stringify(diagHosts(diag0)));

    browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof S !== 'undefined' && !!document.querySelector('#tlsCount'), null, { timeout: 12000 });
    await page.waitForTimeout(700);
    push('页面初始三条诊断行', (await page.locator('.row.tls').count()) === 3, 'rows=' + (await page.locator('.row.tls').count()));
    push('初始角标为 3', (await page.locator('#tlsCount').innerText()).trim() === '3');

    // 模拟「设置页手填跳过解密的域名并保存」：不是详情按钮，也能清
    const cfg1 = await api('/api/config', jsonOpts({ passthrough: [RULE] }));
    push('配置已写入跳过解密规则', (cfg1.passthrough || []).includes(RULE));
    const diag1 = await api('/api/diagnostics');
    push('后端只保留不受规则覆盖的域名', diagHosts(diag1).join() === HOST_C, JSON.stringify(diagHosts(diag1)));
    await page.waitForTimeout(450);
    const leftHosts = await page.locator('.row.tls .cellurl .p').allInnerTexts();
    push('SSE 同步：被覆盖的两行即时消失', leftHosts.length === 1 && leftHosts[0].trim() === HOST_C, JSON.stringify(leftHosts));
    push('SSE 同步：角标跟着变 1', (await page.locator('#tlsCount').innerText()).trim() === '1');

    // 白名单生效后，旧的 MITM 连接晚到的报错不能把诊断行顶回来
    await abruptHandshake(HOST_A);
    await sleep(700);
    const diag2 = await api('/api/diagnostics');
    push('已加白名单的域名不再产生新诊断', diagHosts(diag2).join() === HOST_C, JSON.stringify(diagHosts(diag2)));
    push('页面也没有复活的行', (await page.locator('.row.tls').count()) === 1);

    // ✕ 忽略单条：只清这一条，服务端也删掉
    await page.locator('.row.tls [data-tls-dismiss]').first().click();
    await page.waitForTimeout(450);
    push('✕ 忽略后行消失', (await page.locator('.row.tls').count()) === 0);
    push('✕ 忽略后角标隐藏', await page.locator('#tlsCount').isHidden());
    const diag3 = await api('/api/diagnostics');
    push('✕ 忽略后服务端记录也清掉', (diag3.tlsFailures || []).length === 0, JSON.stringify(diagHosts(diag3)));

    // 详情里的「加入跳过解密」：行 + 选中详情一起清干净
    await abruptHandshake(HOST_D);
    await sleep(700);
    push('新域名的诊断行出现', (await page.locator('.row.tls').count()) === 1);
    await page.locator('.row.tls').first().click();
    await page.waitForTimeout(180);
    push('选中后详情有透传按钮', (await page.locator('#detail [data-block-host]').count()) === 1);
    await page.locator('#detail [data-block-host]').click();
    await page.waitForTimeout(450);
    push('一键透传后诊断行消失', (await page.locator('.row.tls').count()) === 0);
    push('一键透传后详情回到空状态', (await page.locator('#detail .tls-error').count()) === 0);
    const cfg2 = await api('/api/config');
    push('一键透传写入了配置', (cfg2.passthrough || []).includes(HOST_D), JSON.stringify(cfg2.passthrough));
    const diag4 = await api('/api/diagnostics');
    push('一键透传后端记录清空', (diag4.tlsFailures || []).length === 0);

    push('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    if (browser) await browser.close();
    await api('/api/config', jsonOpts({ passthrough: savedPassthrough })).catch(() => {});
    await api('/api/diagnostics', { method: 'DELETE' }).catch(() => {});
    await api('/api/flows', { method: 'DELETE' }).catch(() => {});
  }

  let pass = 0;
  for (const [name, ok, extra] of checks) {
    if (ok) pass += 1;
    console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
  }
  console.log(`共 ${checks.length} 项，通过 ${pass} 项`);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
