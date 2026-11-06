'use strict';

/**
 * 端到端验收：开启系统代理后，本机浏览器发出的请求真的会出现在列表里。
 *
 * 用 Chromium（macOS 下默认跟随系统代理）访问本机局域网 IP 上的一个临时 HTTP 服务，
 * 这个地址不在 bypass 列表里，因此会经过 reqLite。抓到的 flow 应满足：
 *   url 带唯一 tag、status 200、clientIp = 127.0.0.1（本机，区别于手机设备）
 * 跑完必定还原系统代理。
 *
 * 前提：reqLite 服务已在 9090/9091 运行。
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PW = '/Users/jojo/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const { SystemProxy } = require('../src/system-proxy');
const EXEC =
  '/Users/jojo/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}

(async () => {
  if (!new SystemProxy({}).supported) {
    console.log('⚠️ 非 macOS，跳过本机流量端到端验收');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-lt-'));
  const sp = new SystemProxy({ proxyPort: 9090, dataDir: tmp });
  const svc = sp.primaryService();
  const original = sp.snapshot(svc);
  const checks = [];
  const tag = `reqlite-local-check-${Date.now()}`;
  let browser;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const url = `http://${lanIp()}:${server.address().port}/${tag}`;
  console.log('本机目标:', url);

  try {
    checks.push(['开启系统代理', sp.enable(svc).ok]);
    browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage();
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      status = resp && resp.status();
    } catch (e) {
      console.log('页面打开失败:', e.message.split('\n')[0]);
    }
    await page.waitForTimeout(1200);
    checks.push(['浏览器经代理访问成功', status === 200]);

    const flows = await fetch('http://127.0.0.1:9091/api/flows?limit=800').then((r) => r.json());
    const hit = flows.filter((f) => f.url.includes(tag));
    console.log('抓到的记录:', JSON.stringify(hit.map((f) => ({ url: f.url, clientIp: f.clientIp, status: f.status }))));
    checks.push(['★ 本机请求出现在流量列表', hit.length > 0]);
    checks.push(['记录标记为本机 IP（可区分手机设备）', hit.some((f) => f.clientIp === '127.0.0.1')]);
    checks.push(['请求被正确转发（200）', hit.some((f) => f.status === 200)]);
  } catch (err) {
    checks.push(['流程无异常', false]);
    console.error('异常:', err && err.stack ? err.stack : err);
  } finally {
    if (browser) await browser.close();
    sp.disable(svc);
    if (JSON.stringify(sp.snapshot(svc)) !== JSON.stringify(original)) sp.restore(original, svc);
    checks.push(['系统代理已还原', JSON.stringify(sp.snapshot(svc)) === JSON.stringify(original)]);
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
