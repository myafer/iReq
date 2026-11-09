'use strict';

/**
 * 代理行为自检：明文 / 443 解密 / 非 443 透传 / 长保活 / 大上传 / 握手失败诊断
 * 用法：node tools/check-proxy.js
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const PROXY = { host: '127.0.0.1', port: 9090 };
const UP_HTTP = 8098;
const UP_TLS = 8443;
const CA_PATH = path.join(__dirname, '..', 'data', 'ca', 'reqlite-ca.pem');

const log = (label, ok, extra = '') => console.log(`${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);

function proxyRequest({ method = 'GET', url, headers = {}, body = null, timeout = 15000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method,
      path: url,
      headers: { host: u.host, ...headers },
      timeout,
    });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** 通过代理 CONNECT + 自己握手（模拟不信任证书的 App：rejectUnauthorized 默认 true） */
function tlsThroughProxy({ host, port = 443, servername, rejectUnauthorized = true, useOurCa = true }) {
  return new Promise((resolve) => {
    const socket = net.connect(PROXY.port, PROXY.host);
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    socket.once('data', (buf) => {
      const head = buf.toString('latin1');
      if (!/200/.test(head.split('\r\n')[0])) {
        socket.destroy();
        return resolve({ error: 'CONNECT 失败: ' + head.split('\r\n')[0] });
      }
      const t = tls.connect(
        { socket, servername: servername || host, rejectUnauthorized, ca: rejectUnauthorized && useOurCa ? fs.readFileSync(CA_PATH) : undefined },
        () => {
          t.destroy();
          resolve({ ok: true, authorized: t.authorized, protocol: t.getProtocol() });
        }
      );
      t.on('error', (e) => {
        t.destroy();
        resolve({ error: e.code || e.message });
      });
      setTimeout(() => {
        t.destroy();
        resolve({ error: 'handshake timeout' });
      }, 8000);
    });
  });
}

function serveUpstreams() {
  http.createServer((req, res) => {
    let n = 0;
    req.on('data', (c) => (n += c.length));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ got: n, path: req.url }));
    });
  }).listen(UP_HTTP);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-'));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" 2>/dev/null`
  );
  https
    .createServer({ key: fs.readFileSync(`${tmp}/k.pem`), cert: fs.readFileSync(`${tmp}/c.pem`) }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok-from-tls-' + UP_TLS);
    })
    .listen(UP_TLS);
}

async function api(pathname, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: 9091, method: options.method || 'GET', path: pathname, headers: { 'content-type': 'application/json' } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (_) {
            resolve(d);
          }
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

(async () => {
  serveUpstreams();
  await new Promise((r) => setTimeout(r, 400));

  // 1. 明文 HTTP 经代理
  const plain = await proxyRequest({ url: `http://127.0.0.1:${UP_HTTP}/plain` });
  log('明文 HTTP 转发', plain.status === 200, `${plain.status} ${plain.body || plain.error}`);

  // 2. 非 443 端口应原样透传（上游自签证书，端到端保留）
  const tunneled = await tlsThroughProxy({ host: 'localhost', port: UP_TLS, rejectUnauthorized: false });
  log('非 443 端口透传（不解密）', !!tunneled.ok, JSON.stringify(tunneled));

  // 3. 大上传（chunked，8MB）不应被卡住
  const big = await proxyRequest({
    method: 'POST',
    url: `http://127.0.0.1:${UP_HTTP}/upload`,
    headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    body: Buffer.alloc(8 * 1024 * 1024, 97),
    timeout: 30000,
  });
  const bigOk = big.status === 200 && /"got":8388608/.test(big.body || '');
  log('8MB chunked 上传流式转发', bigOk, big.body || big.error);

  // 4. 长保活：同一 socket 上 8 秒后再发第二个请求
  const keepalive = await new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const one = () =>
      new Promise((res) => {
        const req = http.request(
          { host: PROXY.host, port: PROXY.port, method: 'GET', path: `http://127.0.0.1:${UP_HTTP}/ka`, agent },
          (r) => {
            r.resume();
            r.on('end', () => res(r.statusCode));
          }
        );
        req.on('error', (e) => res('ERR ' + e.code));
        req.end();
      });
    one().then((first) =>
      setTimeout(async () => {
        const second = await one();
        agent.destroy();
        resolve({ first, second });
      }, 8000)
    );
  });
  log('保活 8 秒后复用连接', keepalive.first === 200 && keepalive.second === 200, JSON.stringify(keepalive));

  // 5. 真实 443 站点：信任 CA 时握手成功（解密生效）
  const realTls = await tlsThroughProxy({ host: 'www.baidu.com', port: 443, rejectUnauthorized: true });
  log('443 解密（用 reqLite CA 校验）', !!realTls.ok, JSON.stringify(realTls));

  // 6. 客户端握手中断（证书固定类客户端常见：直接 reset）
  const abruptOnce = () =>
    new Promise((resolve) => {
      const sock = net.connect(PROXY.port, PROXY.host);
      sock.write('CONNECT www.apple.com:443 HTTP/1.1\r\nHost: www.apple.com:443\r\n\r\n');
      sock.once('data', () => {
        sock.destroy();
        resolve('reset');
      });
      sock.on('error', () => resolve('error'));
    });
  const abrupt = await Promise.all([abruptOnce(), abruptOnce(), abruptOnce()]);
  log('模拟证书固定客户端（握手中断 ×3）', abrupt.every((r) => r === 'reset'), abrupt.join(','));
  await new Promise((r) => setTimeout(r, 600));
  const diag = await api('/api/diagnostics');
  const failedHosts = (diag.tlsFailures || []).map((f) => f.host);
  const repeated = (diag.tlsFailures || []).filter((f) => f.count >= 2).map((f) => f.host);
  log('诊断里出现反复失败的域名', repeated.includes('www.apple.com'), JSON.stringify(diag.tlsFailures));

  // 7. 加进透传后应恢复
  const cfg = await api('/api/config');
  await api('/api/config', {
    method: 'PUT',
    body: { passthrough: [...(cfg.passthrough || []), 'apple.com'], mitmPorts: [443, UP_TLS] },
  });
  const afterBypass = await tlsThroughProxy({ host: 'www.apple.com', port: 443, rejectUnauthorized: false });
  log('加入透传后 apple.com 可连通', !!afterBypass.ok, JSON.stringify(afterBypass));

  // 8. 配置里允许 8443 解密后，本地 TLS 上游应被解密（证书换成 reqLite 签的）
  const mitmLocal = await tlsThroughProxy({ host: 'localhost', port: UP_TLS, rejectUnauthorized: true });
  log('mitmPorts 加入 8443 后被解密', !!mitmLocal.ok, JSON.stringify(mitmLocal));

  // 9. 抓包开关必须真的生效（曾经因为 config 被复制导致无效）
  await api('/api/config', { method: 'PUT', body: { capture: false } });
  const before = (await api('/api/status')).store.total;
  await proxyRequest({ url: `http://127.0.0.1:${UP_HTTP}/while-off` });
  await new Promise((r) => setTimeout(r, 400));
  const afterOff = (await api('/api/status')).store.total;
  await api('/api/config', { method: 'PUT', body: { capture: true } });
  await proxyRequest({ url: `http://127.0.0.1:${UP_HTTP}/while-on` });
  await new Promise((r) => setTimeout(r, 400));
  const afterOn = (await api('/api/status')).store.total;
  log('抓包开关生效', afterOff === before && afterOn > afterOff, `off:${before}->${afterOff} on:->${afterOn}`);

  // 还原配置
  await api('/api/config', { method: 'PUT', body: { passthrough: cfg.passthrough || [], mitmPorts: [443] } });
  console.log('\n完成后记得 Ctrl+C 结束；此脚本仅用于自检。');
  process.exit(0);
})();
