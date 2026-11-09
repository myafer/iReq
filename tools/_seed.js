'use strict';

/**
 * 自检用的测试流量生成器（不依赖 Playwright）。
 *
 * 之前的 UI 自检脚本都假设「控制台里已经有流量」，一旦数据是空的，
 * .row / [data-facet=host] 根本不存在，脚本就崩在 getComputedStyle(null)。
 * 这里通过真实代理打一组请求，保证每次运行自检时四个派生维度都有数据：
 *   设备(clientIp) / 应用(UA) / 域名(host) / 接口结构(route)
 *
 * 用法：const { seedFlows } = require('./_seed'); await seedFlows();
 */

const http = require('http');

const PROXY_HOST = '127.0.0.1';
const { UI: CONSOLE, PROXY_PORT } = require('./_env');

const UAS = [
  'demo-app/2.0.0 (iPhone; iOS 17.0) CFNetwork/1496',
  'okhttp/4.12.0 (Android 14; Pixel 8)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'reader/3.2.1 (iPad; iOS 16.4) Alamofire/5.8',
];

/** 路径刻意带数字 id / uuid，用来验证接口结构归一化 (:id / :uuid) */
const CASES = [
  { method: 'GET', path: '/api/v1/users/42' },
  { method: 'GET', path: '/api/v1/users/77/profile' },
  { method: 'POST', path: '/api/v1/orders' },
  { method: 'GET', path: '/api/v1/orders/9f8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/broken' },
  { method: 'PUT', path: '/api/v1/lessons/1024' },
  { method: 'GET', path: '/api/v2/config?env=fat' },
  { method: 'DELETE', path: '/api/v1/sessions/315' },
  { method: 'GET', path: '/assets/app.js' },
];

function startOrigin() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url || '').split('?')[0];
      if (p === '/broken') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"intentional 500"}');
      }
      if (p.startsWith('/assets/')) {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return res.end('window.__seed = true;');
      }
      if (p === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: p, echo: body.slice(0, 64) }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function viaProxy({ originPort, hostname, method, path, ua }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: PROXY_HOST,
        port: PROXY_PORT,
        method,
        path: `http://${hostname}:${originPort}${path}`,
        headers: {
          host: `${hostname}:${originPort}`,
          'user-agent': ua,
          'accept': '*/*',
          connection: 'close',
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, status: res.statusCode }));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    if (method === 'POST' || method === 'PUT') req.write(JSON.stringify({ seed: true }));
    req.end();
  });
}

async function ensureCaptureOn() {
  // 别的自检（check-proxy）可能临时关过抓包开关，这里兜底恢复
  await new Promise((resolve) => {
    const req = http.request(
      `${CONSOLE}/api/config`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(JSON.stringify({ capture: true }));
  });
}

/**
 * 造一批流量。hostname 在 127.0.0.1 / localhost 之间切换，
 * 让「域名」分组至少有两个可点项。
 */
async function seedFlows() {
  await ensureCaptureOn();
  const server = await startOrigin();
  const originPort = server.address().port;
  const results = [];
  try {
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const hostname = i % 2 === 0 ? '127.0.0.1' : 'localhost';
      results.push(await viaProxy({ originPort, hostname, ...c, ua: UAS[i % UAS.length] }));
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  // 给 store 的落盘 / SSE 一点时间
  await new Promise((r) => setTimeout(r, 150));
  const ok = results.filter((r) => r.ok).length;
  return { attempted: CASES.length, ok, originPort };
}

module.exports = { seedFlows };
