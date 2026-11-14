'use strict';

/**
 * 自检：耗时分解（DNS / TCP / TLS / 等待首字节 / 下载）
 * ---------------------------------------------------------------------------
 * ① 事件挂载：连接 / 握手 / 请求发出 / 首字节四个时间点各自落到对应阶段
 * ② 连接复用：DNS / TCP / TLS 记 0 且 reused=true —— 不能把「没握手」画成「握手很快」
 * ③ 拿不到的阶段是 null 而不是 0：「不知道」和「很快」在排障时是两件事
 * ④ 真实请求：等待段与上游延迟对得上，各段之和不超过总耗时
 * ⑤ HTTPS：TLS 段有真实数值（自签上游 + rejectUnauthorized=false）
 * ⑥ 代理链路：flow.timings 真的落库，且 total 与 duration 同口径
 * ⑦ 重放：重放出来的记录同样带分段计时
 *
 * 代理链路部分会造流量，结束时清空流量并删掉自己生成的历史记录。
 */
const http = require('http');
const https = require('https');
const forge = require('node-forge');
const { EventEmitter } = require('events');
const { createCollector } = require('../src/timing');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}

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
  return { status: res.status, body };
};

/* ---------------------------------------------------------------- ①-③ 事件挂载 */
{
  const t = createCollector();
  const req = new EventEmitter();
  const sock = new EventEmitter();
  sock.connecting = true;
  t.attach(req);
  req.emit('socket', sock);
  sock.emit('connect');
  sock.emit('secureConnect');
  req.emit('finish');
  req.emit('response');
  const r = t.finish();
  ok('连接后 TCP 段有值', typeof r.tcp === 'number', r.tcp);
  ok('secureConnect 后 TLS 段有值', typeof r.tls === 'number', r.tls);
  ok('response 后等待段有值', typeof r.wait === 'number', r.wait);
  ok('收尾后下载段有值', typeof r.download === 'number', r.download);
  ok('没有 lookup 时 DNS 是 null（不是 0）', r.dns === null, r.dns);
  ok('首次连接不算复用', r.reused === false);
  ok('总耗时是数字', typeof r.total === 'number' && r.total >= 0, r.total);

  // 复用连接：socket 交过来时已经连好，握手三段都该是 0
  const t2 = createCollector();
  const req2 = new EventEmitter();
  const sock2 = new EventEmitter();
  sock2.connecting = false;
  t2.attach(req2);
  req2.emit('socket', sock2);
  req2.emit('finish');
  req2.emit('response');
  const r2 = t2.finish();
  ok('复用连接被标记', r2.reused === true);
  ok('复用连接 DNS / TCP / TLS 都是 0', r2.dns === 0 && r2.tcp === 0 && r2.tls === 0);

  // 没有响应（连不上 / 超时）：等待与下载都不知道，必须留 null
  const t3 = createCollector();
  const req3 = new EventEmitter();
  t3.attach(req3);
  const r3 = t3.finish();
  ok('没有响应时等待段是 null', r3.wait === null);
  ok('没有响应时下载段也是 null', r3.download === null);
}

/* ---------------------------------------------------------------- ④ 真实 HTTP */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const delay = /^\/slow/.test(req.url || '') ? 220 : 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, delay);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function timeRequest(opts) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const c = createCollector(t0, { secure: !!opts.secure });
    const mod = opts.secure ? https : http;
    const req = mod.request({ ...opts.options, lookup: c.lookup }, (res) => {
      res.resume();
      res.on('end', () => resolve(c.finish()));
    });
    c.attach(req);
    req.on('error', reject);
    req.end();
  });
}

/* ---------------------------------------------------------------- ⑤ HTTPS 上游 */
function selfSigned() {
  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 864e5);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: pki.privateKeyToPem(keys.privateKey), cert: pki.certificateToPem(cert) };
}

/* ------------------------------------------------------- ⑥ 代理链路 / ⑦ 重放 */
function viaProxy(upPort, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method: 'GET',
        path: `http://127.0.0.1:${upPort}${path}`,
        headers: { host: `127.0.0.1:${upPort}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const srv = await startUpstream();
  const upPort = srv.address().port;

  const slow = await timeRequest({ options: { host: '127.0.0.1', port: upPort, path: '/slow' } });
  ok('IP 直连时没有 DNS 段', slow.dns === null, slow.dns);
  ok('等待段 ≥ 上游延迟', slow.wait >= 200, `${slow.wait}ms`);
  ok('下载段很小（上游一次性写完）', slow.download !== null && slow.download < 100, `${slow.download}ms`);
  ok('总耗时不小于等待段', slow.total >= slow.wait, `${slow.total} vs ${slow.wait}`);

  const byName = await timeRequest({ options: { host: 'localhost', port: upPort, path: '/' } });
  ok('域名访问时 DNS 段有值', typeof byName.dns === 'number', byName.dns);

  const fast = await timeRequest({ options: { host: '127.0.0.1', port: upPort, path: '/' } });
  const sum = [fast.dns, fast.tcp, fast.tls, fast.wait, fast.download]
    .filter((v) => typeof v === 'number')
    .reduce((a, b) => a + b, 0);
  ok('各段之和不超过总耗时（最多差 2ms 的取整）', sum <= fast.total + 2, `${sum} vs ${fast.total}`);

  // HTTPS：真实握手一次，TLS 段必须有值
  const pair = selfSigned();
  const tlsSrv = https.createServer(pair, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tls-ok');
  });
  await new Promise((r) => tlsSrv.listen(0, '127.0.0.1', r));
  const tlsPort = tlsSrv.address().port;
  const sec = await timeRequest({
    secure: true,
    options: { host: '127.0.0.1', port: tlsPort, path: '/', rejectUnauthorized: false },
  });
  ok('HTTPS 的 TLS 段是真数值', typeof sec.tls === 'number', `${sec.tls}ms`);
  ok('HTTPS 首次连接不算复用', sec.reused === false);
  tlsSrv.close();

  /* ---------------- 代理链路 ---------------- */
  const before = await historyIds();
  const status = await viaProxy(upPort, '/slow');
  ok('经代理的请求成功', status === 200, status);
  // 等落库（SSE 广播是同步的，这里只是给事件循环一点余量）
  await new Promise((r) => setTimeout(r, 120));

  const flows = await jsonApi(`/api/flows?q=${encodeURIComponent('/slow')}&limit=20`);
  const hit = (flows.body || []).find((f) => String(f.path).startsWith('/slow'));
  ok('代理记录里有这条请求', !!hit, hit && hit.id);
  ok('flow 带 timings', !!(hit && hit.timings), hit && JSON.stringify(hit.timings));
  if (hit && hit.timings) {
    ok('代理链路的等待段也对得上延迟', Number(hit.timings.wait) >= 200, `${hit.timings.wait}ms`);
    ok('timings.total 与 duration 同口径', Math.abs(Number(hit.timings.total) - Number(hit.duration)) <= 5,
      `${hit.timings.total} vs ${hit.duration}`);
    ok('明文 HTTP 没有 TLS 段（记 0）', hit.timings.tls === 0, hit.timings.tls);
  }

  if (hit) {
    const rp = await jsonApi(`/api/flows/${hit.id}/replay`, { method: 'POST', body: {} });
    const rf = rp.body && rp.body.flow;
    ok('重放记录也带 timings', !!(rf && rf.timings), rf && JSON.stringify(rf.timings));
    ok('重放的等待段也能测出来', !!(rf && rf.timings && Number(rf.timings.wait) >= 200), rf && rf.timings && rf.timings.wait);
  }

  /* ---------------- 清理 ---------------- */
  await jsonApi('/api/flows', { method: 'DELETE' });
  const after = await historyIds();
  for (const id of after) {
    if (!before.has(id)) await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
  }
  srv.close();

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})();
