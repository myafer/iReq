'use strict';

/**
 * 自检：设备分组把 127.0.0.1 / ::1 / 本机网卡 IP 合并成「本机」，
 * 且标签不再随 UA 闪跳（以前会在 iOS 127.0.0.1 / 未知 127.0.0.1 之间来回变）。
 *
 * 三段：① 纯单元（local-address + store）② 真实 API ③ Playwright 控制台。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const { seedFlows } = require('./_seed');
const L = require('../src/local-address');
const { FlowStore } = require('../src/store');
const { ProcessMap } = require('../src/process-map');

const API = 'http://127.0.0.1:9091';
const REMOTE = '203.0.113.7';
const checks = [];
const ok = (name, cond, extra = '') => {
  checks.push([name, !!cond]);
  if (!cond) console.log('   ↳', extra);
};

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n && n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}
const LAN = lanIps()[0] || '';

const api = async (p, opts) => {
  const r = await fetch(API + p, opts);
  return r.json();
};

/** 用本机网卡 IP 作为 TCP 源地址连代理，制造一条「局域网 IP 来源」的真实流量 */
function viaLan(lan) {
  return new Promise((resolve) => {
    const tag = 'devcheck' + Date.now();
    const req = http.request(
      {
        host: lan,
        port: 9090,
        localAddress: lan,
        method: 'GET',
        path: `http://127.0.0.1:9091/api/status?tag=${tag}`,
        headers: { host: '127.0.0.1:9091', 'user-agent': 'curl/8.7.1' },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, tag }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

(async () => {
  /* ------------------------------------------------------------ ① 单元 */
  ok('IPv4-mapped 回环归一', L.normalizeIp('::ffff:127.0.0.1') === '127.0.0.1');
  ok('::1 归一到 127.0.0.1', L.normalizeIp('::1') === '127.0.0.1');
  ok('IPv6 zone 后缀被去掉', L.normalizeIp('fe80::1%en0') === 'fe80::1');
  ok(
    '回环各种写法都算本机',
    ['127.0.0.1', '127.0.0.2', '::ffff:127.0.0.1', '::1', '0:0:0:0:0:0:0:1'].every(
      L.isLocalClientIp
    )
  );
  ok('本机网卡 IP 也算本机', !!LAN && L.isLocalClientIp(LAN), 'LAN=' + LAN);
  ok('远程 IP 不算本机', !L.isLocalClientIp(REMOTE));
  ok(
    '本机 key / 标签稳定（不依赖 UA）',
    L.deviceKeyOf('127.0.0.1') === 'local' &&
      L.deviceKeyOf(LAN) === 'local' &&
      L.deviceLabelOf('127.0.0.1', '未知') === '本机' &&
      L.deviceLabelOf('127.0.0.1', 'iOS') === '本机'
  );
  ok(
    '远程标签不再写「未知」',
    L.deviceLabelOf(REMOTE, '未知') === REMOTE &&
      L.deviceLabelOf(REMOTE, 'iOS') === `iOS ${REMOTE}`
  );
  ok(
    '进程识别也认本机网卡 IP，但不认远程',
    (!LAN || ProcessMap.isLocalAddress(LAN)) && !ProcessMap.isLocalAddress(REMOTE)
  );

  // 用临时目录造一组「无 UA 的本机请求排在前面」，专门复现闪跳场景
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-device-'));
  const st = new FlowStore({ dir });
  let n = 0;
  const mk = (clientIp, ua) => ({
    id: 'dev-' + ++n,
    ts: Date.now(),
    method: 'GET',
    url: 'http://example.test/api/' + n,
    host: 'example.test',
    path: '/api/' + n,
    scheme: 'http',
    status: 200,
    clientIp,
    reqHeaders: ua ? { 'user-agent': ua } : {},
    resHeaders: {},
  });
  st.add(mk('127.0.0.1', '')); // 故意：第一条无 UA
  st.add(mk('127.0.0.1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120'));
  st.add(mk(LAN || '127.0.0.3', 'echo/1.8.0 (iPhone; iOS 17.0) CFNetwork/1496'));
  st.add(mk(REMOTE, 'okhttp/4.12.0 (Android 14; Pixel 8)'));

  let f = st.facets();
  const local = f.devices.find((d) => d.key === 'local');
  const remote = f.devices.find((d) => d.key === REMOTE);
  console.log('单元 facets.devices:', JSON.stringify(f.devices));
  ok('回环 + 网卡 IP 合并成一个「本机」', !!local && local.label === '本机' && local.count === 3);
  ok('远程设备独立成组且带平台', !!remote && remote.label.includes('Android'));
  ok('设备标签里没有「未知 127.0.0.1」', f.devices.every((d) => !/未知/.test(d.label)));

  for (let i = 0; i < 4; i++) st.add(mk(i % 2 ? '127.0.0.1' : LAN || '127.0.0.3', i % 3 ? '' : 'curl/8.7.1'));
  f = st.facets();
  ok('反复插入无 UA 本机流量后标签仍是「本机」', f.devices.find((d) => d.key === 'local').label === '本机');
  ok('按 local 筛选命中全部本机流量', st.list({ ip: 'local' }).length === 7);
  ok('老书签里的具体 IP 仍能筛', st.list({ ip: '127.0.0.1' }).length >= 3);
  ok('搜「本机」能搜到本机流量', st.list({ query: '本机' }).length === 7);
  ok('列表 summary 带 deviceLabel', st.list()[0].deviceLabel === '本机');
  ok('详情接口也补算 deviceLabel', st.get('dev-1').deviceLabel === '本机');
  fs.rmSync(dir, { recursive: true, force: true });

  /* ------------------------------------------------------------ ② API */
  console.log('注入测试流量:', JSON.stringify(await seedFlows()));
  const lanHit = LAN ? await viaLan(LAN) : { ok: false };
  console.log('局域网 IP 来源请求:', JSON.stringify(lanHit));
  ok('能从本机网卡 IP 发出请求', lanHit.ok);
  await new Promise((r) => setTimeout(r, 400));

  const facets = await api('/api/facets');
  console.log('API devices:', JSON.stringify(facets.devices));
  ok('API 只有一个 local 设备项', facets.devices.filter((d) => d.key === 'local').length === 1);
  ok('API 本机标签是「本机」', facets.devices.some((d) => d.key === 'local' && d.label === '本机'));
  ok('API 没有「未知 127.0.0.1」', facets.devices.every((d) => !/未知\s*127/.test(d.label)));
  const labels = [];
  for (let i = 0; i < 3; i++) {
    const fx = await api('/api/facets');
    labels.push((fx.devices.find((d) => d.key === 'local') || {}).label);
  }
  ok('连续三次聚合标签不闪跳', labels.every((x) => x === '本机'), JSON.stringify(labels));

  const localFlows = await api('/api/flows?ip=local&limit=2000');
  const ips = [...new Set(localFlows.map((x) => x.clientIp))];
  console.log('local 筛选 IP 集合:', JSON.stringify(ips));
  ok('local 筛选同时含回环与网卡 IP', ips.includes('127.0.0.1') && (!LAN || ips.includes(LAN)));
  ok('local 筛选结果全部标为本机', localFlows.length > 0 && localFlows.every((x) => x.deviceLabel === '本机'));
  ok('远程 IP 不会混进 local 筛选', !ips.includes(REMOTE) && !ips.includes('10.131.47.43'));
  ok('按具体 IP 筛选仍可用', (await api('/api/flows?ip=127.0.0.1&limit=2000')).length > 0);
  ok('搜索「本机」可用', (await api('/api/flows?q=' + encodeURIComponent('本机') + '&limit=2000')).length > 0);

  /* -------------------------------------------------------------- ③ UI */
  const browser = await chromium.launch({ executablePath: EXEC });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(API + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const readDevices = () =>
    page.$$eval('[data-group="devices"] .sitem', (els) =>
      els.map((e) => ({ value: e.dataset.value, label: e.querySelector('.lbl').textContent.trim() }))
    );
  const d0 = await readDevices();
  console.log('侧栏设备项:', JSON.stringify(d0));
  ok('侧栏显示「本机」且只有一个', d0.filter((d) => d.label === '本机' && d.value === 'local').length === 1);
  ok('侧栏不再出现「未知 127.0.0.1」', d0.every((d) => !/未知\s*127/.test(d.label)));
  ok('回环与网卡 IP 没被拆成两项', !d0.some((d) => /127\.0\.0\.1/.test(d.label)));
  ok(
    '设备分组每项都带设备图标',
    await page.evaluate(() => {
      const items = document.querySelectorAll('[data-group="devices"] .sitem');
      const icons = document.querySelectorAll('[data-group="devices"] .app-icon.device');
      return items.length > 0 && icons.length === items.length;
    })
  );

  const stable = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => loadFacets());
    await page.waitForTimeout(300);
    const d = await readDevices();
    stable.push((d.find((x) => x.value === 'local') || {}).label);
  }
  console.log('连续刷新 facets 的本机标签:', JSON.stringify(stable));
  ok('反复刷新侧栏标签不闪跳', stable.every((x) => x === '本机'));

  await page.click('[data-facet="ip"][data-value="local"]');
  await page.waitForTimeout(700);
  const filtered = await page.evaluate(() => ({
    chip: document.querySelector('#chips').innerText.trim(),
    ip: S.filter.ip,
    ips: [...new Set(S.flows.map((f) => f.clientIp))],
    rows: S.flows.length,
  }));
  console.log('点「本机」后:', JSON.stringify(filtered));
  ok('chip 显示「本机」而不是 local', filtered.chip.includes('本机') && !filtered.chip.includes('local'));
  ok('筛选条件用合并后的 key', filtered.ip === 'local' && filtered.rows > 0);
  ok('筛选结果只有本机地址', filtered.ips.every((ip) => ['127.0.0.1', LAN, '::1'].includes(ip)));

  const saveBtn = await page.$('[data-save-bookmark]');
  if (saveBtn) {
    await saveBtn.click();
    await page.waitForTimeout(500);
    const bm = await page.$$eval('[data-bookmark]', (els) => els.map((e) => e.innerText.trim()));
    console.log('书签:', JSON.stringify(bm));
    ok('书签标签写「本机」', bm.some((t) => t.includes('本机') && !t.includes('local')));
    const del = await page.$('[data-del-bookmark]');
    if (del) {
      await page.hover('[data-bookmark]');
      await del.click();
      await page.waitForTimeout(300);
    }
  } else {
    ok('书签标签写「本机」', false, '未出现收藏按钮');
  }

  await page.click('#chips [data-clear="ip"]');
  await page.waitForTimeout(400);
  // 用页面内同步 click：SSE 随时会重绘列表，拿 ElementHandle 再点容易 detached
  const clicked = await page.evaluate(() => {
    const r = document.querySelector('.row');
    if (!r) return false;
    r.click();
    return true;
  });
  if (clicked) {
    // SSE 可能刚好重绘详情，轮询取值而不是只等一次
    let devText = '';
    for (let i = 0; i < 8 && !devText; i++) {
      await page.waitForTimeout(250);
      devText = await page.evaluate(() => {
        const dds = [...document.querySelectorAll('.kv dd')];
        const dts = [...document.querySelectorAll('.kv dt')];
        const i = dts.findIndex((d) => d.textContent.trim() === '设备');
        return i >= 0 ? dds[i].textContent.trim() : '';
      });
    }
    console.log('详情设备行:', devText);
    ok('详情显示「本机 · IP」', /本机/.test(devText) && /\d+\.\d+\.\d+\.\d+/.test(devText), devText);
    ok('详情不再显示「未知 127.0.0.1」', !/未知/.test(devText), devText);
  } else {
    ok('详情显示「本机 · IP」', false, '没有可点请求');
    ok('详情不再显示「未知 127.0.0.1」', false, '没有可点请求');
  }

  ok('无 JS 报错', errs.length === 0, errs.join(' | '));
  await browser.close();

  console.log('\n--- 结果 ---');
  for (const [name, pass] of checks) console.log(`${pass ? '✅' : '❌'} ${name}`);
  console.log(`共 ${checks.length} 项，通过 ${checks.filter((c) => c[1]).length} 项`);
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
})();
