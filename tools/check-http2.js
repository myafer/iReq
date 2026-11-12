'use strict';

/**
 * 自检：MITM 隧道按 ALPN 协商 HTTP/2，h2 客户端不再握手失败。
 *
 * 回归点（gsa-gpk.apple.com 这类只提 h2 的端点踩过的坑）：
 *  1. 解密隧道 ALPN 固定 http/1.1 → 客户端只要 h2 就 alert 120 直接断开。
 *  2. h2 流量要走完主链路：转发 / Mock / 断网 / 弱网 / 记录 / 筛选一个不少。
 *  3. 伪首部与连接级头不能混进记录或转发。
 *  4. h2Enabled=false 必须完整回退到纯 HTTP/1.1 解密。
 *
 * 会改 h2Enabled / mitmPorts / networkSim 并清空流量，脚本结束自己恢复现场。
 */
const http = require('http');
const http2 = require('http2');
const https = require('https');
const net = require('net');
const tls = require('tls');
const forge = require('node-forge');
const { UI, PROXY_PORT } = require('./_env');

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
const putCfg = (body) =>
  api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const SIM = (rules) => ({
  enabled: true,
  latencyMs: 400,
  kbps: 64,
  timeoutMs: 1200,
  rules,
});

/** 现生成一对自签证书给上游 TLS 服务用（MITM 只解密真 TLS 端口） */
function selfSignedPems() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400 * 1000);
  const attrs = [{ name: 'commonName', value: 'upstream.test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

const upstream = https.createServer(selfSignedPems(), (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: body, method: req.method }));
      return;
    }
    const buf = Buffer.from(JSON.stringify({ ok: true, path: req.url }));
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': buf.length,
    });
    res.end(buf);
  });
});

/** CONNECT 隧道 + TLS 握手（可选 ALPN），成功返回协商完成的 TLSSocket */
function mitmConnect(port, alpn) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(PROXY_PORT, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => reject(new Error('CONNECT timeout')), 4000);
    raw.on('connect', () =>
      raw.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    );
    raw.on('data', (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      if (!/^HTTP\/1\.1 200/.test(buf)) return reject(new Error(buf.split('\r\n')[0]));
      const t = tls.connect({
        socket: raw,
        servername: '127.0.0.1',
        ALPNProtocols: alpn,
        rejectUnauthorized: false,
      });
      t.once('secure', () => resolve(t));
      t.once('error', (e) => reject(e));
    });
    raw.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    raw.on('close', () => {
      clearTimeout(timer);
      reject(new Error('connection reset'));
    });
  });
}

function h2Session(tlsSocket) {
  return http2.connect('https://127.0.0.1', { createConnection: () => tlsSocket });
}

function h2Request(session, method, path, body = '', extra = {}) {
  return new Promise((resolve) => {
    const headers = { ':method': method, ':path': path, ...extra };
    if (body) headers['content-type'] = 'application/json';
    const st = session.request(headers);
    let out = '';
    let status = 0;
    let resHeaders = {};
    const timer = setTimeout(() => resolve({ error: 'timeout', status }), 6000);
    st.on('response', (h) => {
      status = Number(h[':status']);
      resHeaders = h;
    });
    st.on('data', (c) => (out += c));
    st.on('end', () => {
      clearTimeout(timer);
      resolve({ status, body: out, headers: resHeaders });
    });
    st.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message, status });
    });
    if (body) st.end(body);
    else st.end();
  });
}

const flowsList = async (q = 'limit=200') => {
  const fl = await api('/api/flows?' + q);
  return Array.isArray(fl) ? fl : fl.flows || [];
};
/** 摘要接口不带 body / 完整头，断言细节要走详情接口 */
const flowDetail = async (id) => api('/api/flows/' + id);

function destroyAll(...conns) {
  for (const c of conns) {
    try {
      if (c && c.close) c.close();
      if (c && c.destroy) c.destroy();
    } catch (_) {
      /* noop */
    }
  }
}

(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  await putCfg({ h2Enabled: true, mitmPorts: [443, upPort], networkSim: SIM([]) });
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  await sleep(120);

  /* ---------- A. ALPN 协商 + 单条 h2 请求 ---------- */
  const sock = await mitmConnect(upPort, ['h2', 'http/1.1']);
  ok('代理与客户端协商出 h2', sock.alpnProtocol === 'h2', String(sock.alpnProtocol));
  const session = h2Session(sock);
  const r1 = await h2Request(session, 'GET', '/json');
  ok('h2 GET 拿到上游响应', r1.status === 200 && /"ok"\s*:\s*true/.test(r1.body), JSON.stringify(r1).slice(0, 140));
  await sleep(180);
  const flows = await flowsList();
  const h2flows = flows.filter((f) => f.httpVersion === 'HTTP/2.0');
  ok('h2 流量记录为 HTTP/2.0', h2flows.some((f) => f.url.includes('/json')),
    JSON.stringify(flows.slice(0, 3).map((f) => f.httpVersion)));
  const jsonDetail = await flowDetail(h2flows.find((f) => f.url.includes('/json')).id);
  ok('伪首部与连接级头不入库',
    !!jsonDetail &&
      !Object.keys(jsonDetail.reqHeaders || {}).some(
        (k) => k.startsWith(':') || k === 'connection' || k === 'transfer-encoding'
      ),
    JSON.stringify(Object.keys((jsonDetail && jsonDetail.reqHeaders) || {}))
  );

  /* ---------- B. 同一连接多路复用并发 ---------- */
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => h2Request(session, 'GET', '/json?i=' + i)));
  ok('同一连接并发 5 条全部成功', many.every((r) => r.status === 200),
    JSON.stringify(many.map((r) => r.status || r.error)));
  await sleep(220);
  const flows2 = await flowsList();
  ok('并发请求逐条入库（h2 多路复用不是一条）', flows2.filter((f) => f.httpVersion === 'HTTP/2.0').length >= 6,
    String(flows2.filter((f) => f.httpVersion === 'HTTP/2.0').length));

  /* ---------- C. POST 请求体 ---------- */
  const rp = await h2Request(session, 'POST', '/echo', '{"hello":"h2"}');  ok('h2 POST 拿到上游回显', rp.status === 200 && /hello/.test(rp.body), JSON.stringify(rp).slice(0, 140));
  await sleep(180);
  const echoFlow = (await flowsList()).find((f) => f.url.includes('/echo'));
  const echoDetail = echoFlow ? await flowDetail(echoFlow.id) : null;
  ok('h2 请求体被记录',
    !!echoDetail && String(echoDetail.reqBody || '').includes('"hello":"h2"'),
    JSON.stringify((echoDetail && echoDetail.reqBody) || null).slice(0, 120));

  /* ---------- D. 筛选条 HTTP2 ---------- */
  const f2 = await flowsList('status=http2&limit=200');
  ok('筛选 HTTP2 命中', f2.length >= 6 && f2.every((f) => String(f.httpVersion).startsWith('HTTP/2')),
    String(f2.length));
  const f1 = await flowsList('status=http1&limit=200');
  ok('筛选 HTTP1 不含 h2 记录', f1.every((f) => !String(f.httpVersion).startsWith('HTTP/2')));

  /* ---------- E. Mock 命中 h2 ---------- */
  const rule = await api('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'h2-mock-check',
      host: '127.0.0.1',
      urlMatch: '/h2mock',
      status: 200,
      body: '{"mock":true}',
    }),
  });
  ok('Mock 规则创建成功', !!rule && !!rule.id, JSON.stringify(rule).slice(0, 100));
  const rm = await h2Request(session, 'GET', '/h2mock');
  ok('h2 请求命中 Mock（本地直返）',
    rm.status === 200 && /"mock"\s*:\s*true/.test(rm.body) && !!rm.headers['x-reqlite-mock'],
    JSON.stringify({ status: rm.status, body: rm.body.slice(0, 60) }));
  await sleep(160);
  const mockFlow = (await flowsList()).find((f) => f.url.includes('/h2mock'));
  ok('Mock 记录带 mocked 标记', !!mockFlow && mockFlow.mocked === true && mockFlow.httpVersion === 'HTTP/2.0',
    JSON.stringify(mockFlow && { mocked: mockFlow.mocked, httpVersion: mockFlow.httpVersion }));
  await api('/api/rules/' + rule.id, { method: 'DELETE' });

  /* ---------- F. 弱网按 stream 生效 ----------
   * 规则变更会切断命中规则的存量连接（这是断网/弱网即时生效的正确行为），
   * 所以每次改规则都要新建会话。 */
  await putCfg({ networkSim: SIM([{ id: 'h2-weak', match: 'host:127.0.0.1', mode: 'weak' }]) });
  await sleep(120);
  const sockW = await mitmConnect(upPort, ['h2']);
  const sessionW = h2Session(sockW);
  const t0 = Date.now();
  const rw = await h2Request(sessionW, 'GET', '/json');
  ok('弱网对 h2 生效（响应被延迟）', rw.status === 200 && Date.now() - t0 >= 330,
    `${Date.now() - t0}ms status=${rw.status}`);

  /* ---------- G. 断网对 h2 生效 ----------
   * 断网在 CONNECT 层就拦截（与 h1 行为一致：不回 200 直接重置，客户端看到的是连接被断） */
  await putCfg({ networkSim: SIM([{ id: 'h2-off', match: 'host:127.0.0.1', mode: 'offline' }]) });
  await sleep(120);
  let offRejected = false;
  try {
    const sockO = await mitmConnect(upPort, ['h2']);
    destroyAll(sockO);
  } catch (_) {
    offRejected = true;
  }
  ok('断网对 h2 生效（CONNECT 被重置）', offRejected);
  await sleep(160);
  const offFlow = (await flowsList()).find((f) => f.simMode === 'offline');
  ok('断网记录带 offline 标记', !!offFlow, JSON.stringify(offFlow && offFlow.simMode));
  destroyAll(sessionW, sockW);
  await putCfg({ networkSim: SIM([]) });

  /* ---------- H. h2Enabled=false 回退 ---------- */
  await putCfg({ h2Enabled: false });
  await sleep(80);
  const st = await api('/api/status');
  ok('状态接口反映 h2Enabled=false', st.h2Enabled === false);
  const sock3 = await mitmConnect(upPort, ['h2', 'http/1.1']);
  ok('关闭 h2：ALPN 退回 http/1.1', sock3.alpnProtocol === 'http/1.1', String(sock3.alpnProtocol));
  const h1res = await new Promise((resolve) => {
    const req = https.request(
      {
        createConnection: () => sock3,
        rejectUnauthorized: false,
        host: '127.0.0.1',
        port: upPort,
        path: '/json',
        headers: { Host: `127.0.0.1:${upPort}` },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
  ok('回退后 HTTP/1.1 解密链路正常', h1res.status === 200 && /"ok"\s*:\s*true/.test(h1res.body),
    JSON.stringify(h1res).slice(0, 120));
  destroyAll(sock3, session, sock);

  /* ---------- 现场恢复 ---------- */
  await putCfg({ h2Enabled: true, mitmPorts: [443], networkSim: SIM([]) });
  await fetch(UI + '/api/flows', { method: 'DELETE' });
  upstream.close();
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await putCfg({ h2Enabled: true, mitmPorts: [443], networkSim: SIM([]) });
  } catch (_) {}
  upstream.close();
  process.exit(1);
});
