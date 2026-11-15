'use strict';

/**
 * 自检：WebSocket 帧记录
 * ---------------------------------------------------------------------------
 * ① 单帧：文本 / 二进制 / ping / pong / close 的 opcode 与体积
 * ② 掩码：客户端帧解掩码后文本才对，掩码位也要记下来
 * ③ 分块：一帧被拆到多个 TCP 包里要能拼回来（帧头跨块最容易崩）
 * ④ 多帧同包：一次收到三帧要全部解析，不能只认第一帧
 * ⑤ 分片消息：continuation 片要沿用它首片的 opcode 按文本解
 * ⑥ permessage-deflate：RSV1 置位的压缩帧不解压，只标 compressed
 * ⑦ 上限：超过保留条数只计数；超过 4MB 的大帧不缓冲但也不丢后续帧
 * ⑧ 端到端：经代理连 WS，握手 101 / 子协议 / 双向帧 / 客户端掩码文本都要对
 * ⑨ 被拒升级：上游回 403 时状态码记 403 且不当成 WebSocket
 * ⑩ 界面：消息页签列出帧、可展开、可按上下行过滤；筛选条的 WebSocket 按钮可用
 * ⑪ wss：经 MITM 的加密 WebSocket，上游要再握一次 TLS，帧同样能记
 *
 * 会造流量，结束时清空流量并删掉自己生成的历史记录。
 */
const http = require('http');
const crypto = require('crypto');
const { FrameParser, mergeDirections } = require('../src/ws-frame');
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一帧（测试侧自己编码，不依赖被测代码） */
function frame(payload, { op = 1, mask = false, fin = true, rsv1 = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | op];
  if (data.length < 126) {
    head.push((mask ? 0x80 : 0) | data.length);
  } else if (data.length < 65536) {
    head.push((mask ? 0x80 : 0) | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    head.push((mask ? 0x80 : 0) | 127, 0, 0, 0, 0,
      (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
  }
  const out = [Buffer.from(head)];
  if (mask) {
    const key = Buffer.from([9, 8, 7, 6]);
    out.push(key);
    const m = Buffer.from(data);
    for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
    out.push(m);
  } else {
    out.push(data);
  }
  return Buffer.concat(out);
}

/* ------------------------------------------------------------ ①-⑦ 单元 */
{
  const p = new FrameParser({ dir: 'up' });
  const out = p.push(
    Buffer.concat([
      frame('hello', { mask: true }),
      frame(Buffer.from([0, 1, 2]), { op: 2, mask: true }),
      frame('', { op: 9, mask: true }),
      frame('', { op: 10, mask: true }),
      frame(Buffer.from([0x03, 0xe8]), { op: 8, mask: true }),
    ])
  );
  ok('一包五帧全部解析', out.length === 5, out.length);
  ok('文本帧解掩码后是原文', out[0].op === 'text' && out[0].preview === 'hello', out[0].preview);
  ok('掩码位被记下来', out[0].masked === true);
  ok('二进制帧只记体积不给预览', out[1].op === 'binary' && out[1].size === 3 && out[1].preview === null);
  ok('ping / pong 识别', out[2].op === 'ping' && out[3].op === 'pong');
  ok('close 带状态码', out[4].op === 'close' && out[4].preview === 'close 1000', out[4].preview);

  // 帧头 / 载荷跨 TCP 包
  const p2 = new FrameParser({ dir: 'down' });
  const raw = frame('split-me-please', { mask: false });
  const a = p2.push(raw.subarray(0, 1));
  const b = p2.push(raw.subarray(1, 5));
  const c = p2.push(raw.subarray(5));
  ok('帧头跨包时不抢跑', a.length === 0 && b.length === 0, `${a.length}/${b.length}`);
  ok('载荷跨包后拼回一条', c.length === 1 && c[0].preview === 'split-me-please', c[0] && c[0].preview);

  // 分片消息：首片 text + 后续 continuation
  const p3 = new FrameParser({ dir: 'down' });
  p3.push(frame('part1', { mask: false, fin: false }));
  const cont = p3.push(frame('part2', { mask: false, fin: true, op: 0 }));
  ok('continuation 片按首片 opcode 解出文本', cont[0].preview === 'part2', cont[0].preview);
  ok('continuation 片被标记', cont[0].cont === true);

  // 压缩帧（permessage-deflate）
  const p4 = new FrameParser({ dir: 'down' });
  const cz = p4.push(frame(Buffer.from([1, 2, 3]), { op: 1, rsv1: true, mask: false }));
  ok('压缩帧标 compressed', cz[0].compressed === true);
  ok('压缩帧不给预览（不解压）', cz[0].preview === null);

  // 保留上限
  const p5 = new FrameParser({ dir: 'up', limit: 2 });
  const many = [];
  for (let i = 0; i < 5; i++) many.push(frame('f' + i, { mask: true }));
  p5.push(Buffer.concat(many));
  ok('只保留上限内的帧', p5.frames.length === 2, p5.frames.length);
  ok('超出部分计入 dropped 与 count', p5.count === 5 && p5.dropped === 3, `${p5.count}/${p5.dropped}`);

  // 超大帧：跳过 payload，后面的帧还能继续解析
  const p6 = new FrameParser({ dir: 'down' });
  const huge = frame(Buffer.alloc(4 * 1024 * 1024 + 10), { op: 2, mask: false });
  const big = p6.push(huge.subarray(0, 32));
  ok('超大帧先出一条占位记录', big.length === 1 && big[0].size === 4 * 1024 * 1024 + 10, big[0] && big[0].size);
  ok('超大帧不缓冲 payload', big[0].preview === null && big[0].big === true);
  const after = p6.push(Buffer.concat([huge.subarray(32), frame('after-big', { mask: false })]));
  ok('超大帧之后仍能继续解析', after.some((f) => f.preview === 'after-big'), after.map((f) => f.preview).join(','));

  // 两个方向合并顺序
  const seq = { n: 0 };
  const up = new FrameParser({ dir: 'up', seq });
  const down = new FrameParser({ dir: 'down', seq });
  up.push(frame('u1', { mask: true }));
  down.push(frame('d1', { mask: false }));
  up.push(frame('u2', { mask: true }));
  const merged = mergeDirections(up, down);
  ok('双向按到达顺序合并', merged.map((f) => f.preview).join('>') === 'u1>d1>u2', merged.map((f) => f.preview).join('>'));
}

/* ------------------------------------------------------------ ⑧⑨ 端到端 */
function startWsUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(404);
      res.end('not ws');
    });
    srv.on('upgrade', (req, socket) => {
      if (/reject/.test(req.url || '')) {
        socket.write('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nnope!');
        return socket.end();
      }
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + accept + '\r\n' +
          'Sec-WebSocket-Protocol: chat\r\n\r\n'
      );
      socket.write(frame('server-hello', { mask: false }));
      socket.on('data', () => socket.write(frame('echo', { mask: false })));
      socket.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function openWs(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PROXY_PORT,
      path: `http://127.0.0.1:${port}${path}`,
      headers: {
        host: `127.0.0.1:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket) => resolve({ res, socket }));
    req.on('response', (res) => resolve({ res, socket: null }));
    req.on('error', reject);
    req.end();
  });
}

function selfSigned() {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 864e5);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

/** CONNECT 穿隧道，再跟代理自己签的证书握手（不校验，测试只关心能不能建起来） */
function mitmTunnel(host, port) {
  const net = require('net');
  const tls = require('tls');
  return new Promise((resolve, reject) => {
    const raw = net.connect(PROXY_PORT, '127.0.0.1', () =>
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    );
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      raw.removeListener('data', onData);
      if (!/^HTTP\/1\.1 200/.test(buf.subarray(0, idx).toString())) {
        return reject(new Error('CONNECT 被拒'));
      }
      const rest = buf.subarray(idx + 4);
      const sock = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false }, () => {
        resolve({ sock, rest });
      });
      sock.on('error', reject);
    };
    raw.on('data', onData);
    raw.on('error', reject);
  });
}

async function waitFlow(path, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonApi('/api/flows?limit=50');
    const hit = (Array.isArray(list.body) ? list.body : []).find((f) => String(f.path).startsWith(path));
    if (hit) return hit;
    await wait(80);
  }
  return null;
}

async function waitClosed(id, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await jsonApi('/api/flows/' + id + '/messages');
    if (r.body && r.body.ws && !r.body.ws.live) return r.body;
    await wait(80);
  }
  const last = await jsonApi('/api/flows/' + id + '/messages');
  return last.body;
}

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const before = await historyIds();
  const srv = await startWsUpstream();
  const port = srv.address().port;

  /* ---------------- 正常会话 ---------------- */
  const { res, socket } = await openWs(port, '/socket');
  ok('握手成功且状态码 101', res.statusCode === 101, res.statusCode);
  ok('子协议透传给客户端', res.headers['sec-websocket-protocol'] === 'chat', res.headers['sec-websocket-protocol']);

  await wait(120);
  socket.on('data', () => {});
  // 客户端两帧（带掩码）+ 一个 ping
  socket.write(frame('client-hello', { mask: true }));
  socket.write(frame(Buffer.from([1, 2, 3, 4]), { op: 2, mask: true }));
  socket.write(frame('', { op: 9, mask: true }));
  await wait(200);

  const flow = await waitFlow('/socket');
  ok('代理记录了这条 WS 请求', !!flow, flow && flow.id);
  ok('列表里带 ws 标记', !!(flow && flow.ws));

  if (flow) {
    // 会话还没结束：帧应该在实时接口里就能看到
    const live = await jsonApi('/api/flows/' + flow.id + '/messages');
    ok('会话进行中也能取到帧（live）', !!(live.body && live.body.ws && live.body.ws.live));
    ok('进行中已经能数到帧', !!(live.body.ws && live.body.ws.count >= 3), live.body.ws && live.body.ws.count);
  }

  socket.end();
  await wait(80);
  socket.destroy();

  if (flow) {
    const m = await waitClosed(flow.id);
    ok('会话结束后帧落库', !!(m && m.ws && m.ws.live === false), m && m.ws && m.ws.live);
    const frames = (m && m.ws && m.ws.frames) || [];
    const previews = frames.map((f) => f.preview).filter(Boolean);
    ok('服务端推送的文本帧在列', previews.includes('server-hello'), previews.join(','));
    ok('客户端掩码文本帧解出原文', previews.includes('client-hello'), previews.join(','));
    ok('上行 / 下行两个方向都有', frames.some((f) => f.dir === 'up') && frames.some((f) => f.dir === 'down'));
    ok('二进制帧不给预览但记了体积', frames.some((f) => f.op === 'binary' && f.size === 4 && f.preview === null));
    ok('ping 帧也在列', frames.some((f) => f.op === 'ping'));
    ok('握手协议记下来了', m.ws.protocol === 'chat', m.ws.protocol);
    const detail = await jsonApi('/api/flows/' + flow.id);
    ok('详情里状态码是 101', detail.body && detail.body.status === 101, detail.body && detail.body.status);
    ok('帧数写进了摘要', Number(detail.body.wsFrameCount) >= 3, detail.body.wsFrameCount);
  }

  /* ---------------- 被拒的升级 ---------------- */
  const rej = await openWs(port, '/reject');
  ok('被拒的升级拿到 403', rej.res.statusCode === 403, rej.res.statusCode);
  if (rej.socket) rej.socket.destroy();
  await wait(200);
  const rejFlow = await waitFlow('/reject');
  ok('被拒的请求也记录了', !!rejFlow, rejFlow && rejFlow.id);
  if (rejFlow) {
    const d = await jsonApi('/api/flows/' + rejFlow.id);
    ok('状态码记成 403 而不是 101', d.body && d.body.status === 403, d.body && d.body.status);
    ok('没升级成功就不标 ws', d.body && !d.body.ws);
    const m = await jsonApi('/api/flows/' + rejFlow.id + '/messages');
    ok('被拒的请求没有帧', m.body && m.body.ws === null);
  }

  /* ---------------- ⑪ wss：加密 WebSocket ---------------- */
  {
    const https = require('https');
    const cfg = await jsonApi('/api/config');
    const origMitm = (cfg.body && cfg.body.mitmPorts) || [443];
    const pair = selfSigned();
    const wssSrv = https.createServer(pair, (req, res) => {
      res.writeHead(404);
      res.end();
    });
    wssSrv.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      socket.write(frame('wss-server', { mask: false }));
      socket.on('data', () => socket.write(frame('wss-echo', { mask: false })));
      socket.on('error', () => {});
    });
    await new Promise((r) => wssSrv.listen(0, '127.0.0.1', r));
    const wssPort = wssSrv.address().port;
    // MITM 只解密 mitmPorts 里的端口，测试端口要临时加进去
    await jsonApi('/api/config', { method: 'PUT', body: { mitmPorts: [...new Set([...origMitm, wssPort])] } });

    let tunnel = null;
    try {
      // 用域名而不是 IP：没有 SNI 时 MITM 服务器不知道该签哪张证书（真实浏览器都会带 SNI）
      tunnel = await mitmTunnel('localhost', wssPort);
      ok('wss：客户端跟代理的 MITM 证书握手成功', !!tunnel.sock);
      const wsKey = crypto.randomBytes(16).toString('base64');
      tunnel.sock.write(
        `GET /wss HTTP/1.1\r\nHost: localhost:${wssPort}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey}\r\n\r\n`
      );
      const down = new FrameParser({ dir: 'down', startAt: Date.now() });
      let hs = Buffer.alloc(0);
      let upgraded = false;
      tunnel.sock.on('data', (d) => {
        if (!upgraded) {
          hs = Buffer.concat([hs, d]);
          const idx = hs.indexOf('\r\n\r\n');
          if (idx < 0) return;
          upgraded = /^HTTP\/1\.1 101/.test(hs.subarray(0, idx).toString());
          const rest = hs.subarray(idx + 4);
          hs = Buffer.alloc(0);
          if (rest.length) down.push(rest);
          return;
        }
        down.push(d);
      });
      await wait(150);
      ok('wss：拿到 101', upgraded);
      tunnel.sock.write(frame('wss-client', { mask: true }));
      await wait(250);
      const previews = down.frames.map((f) => f.preview).filter(Boolean);
      ok('wss：服务端推送的帧能解出来', previews.includes('wss-server'), previews.join(','));
      ok('wss：客户端帧转发到上游并收到回帧', previews.includes('wss-echo'), previews.join(','));
      tunnel.sock.destroy();

      const wssFlow = await waitFlow('/wss');
      ok('wss：代理记录了这条连接', !!wssFlow, wssFlow && wssFlow.id);
      if (wssFlow) {
        const m = await waitClosed(wssFlow.id);
        const frames = (m && m.ws && m.ws.frames) || [];
        ok('wss：帧落库且双向都有',
          frames.some((f) => f.dir === 'up') && frames.some((f) => f.dir === 'down'),
          frames.map((f) => `${f.dir}:${f.preview}`).join(' | '));
        ok('wss：客户端掩码帧解出原文', frames.some((f) => f.preview === 'wss-client'));
        const d = await jsonApi('/api/flows/' + wssFlow.id);
        ok('wss：协议记成 https', d.body && d.body.scheme === 'https', d.body && d.body.scheme);
      }
    } finally {
      if (tunnel && tunnel.sock) tunnel.sock.destroy();
      await jsonApi('/api/config', { method: 'PUT', body: { mitmPorts: origMitm } });
      wssSrv.close();
    }
  }

  /* ---------------- ⑩ 界面：消息页签 ---------------- */
  if (flow) {
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');
    // 筛选条上的 WebSocket 按钮现在应该是可用的
    const wsBtn = await page.$('.fbar [data-status="ws"]');
    ok('WebSocket 筛选按钮不再是禁用态', !!(wsBtn && !(await wsBtn.evaluate((el) => el.disabled))));

    const row = await page.$(`.row:has-text("${'/socket'}")`);
    ok('列表里能找到这条 WS', !!row);
    if (row) {
      await row.click();
      await page.waitForSelector('#tabs');
      const tab = await page.$('#tabs button[data-tab="messages"]');
      ok('WS 详情有「消息」页签', !!tab);
      if (tab) {
        await tab.click();
        await page.waitForTimeout(400);
        const rows = await page.$$eval('#msgList .msg-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
        ok('页签里列出帧', rows.length >= 3, rows.length);
        ok('上行下行都能看到', rows.some((r) => r.includes('↑')) && rows.some((r) => r.includes('↓')),
          rows.join(' | '));
        ok('客户端掩码文本渲染成原文', rows.some((r) => r.includes('client-hello')));
        // 点一条展开完整内容
        await page.click('#msgList .msg-item');
        await page.waitForTimeout(150);
        const body = await page.$eval('#msgList .msg-body', (el) => el.textContent.trim()).catch(() => '');
        ok('点一行能展开完整帧', !!body, body.slice(0, 30));
        // 只看上行
        await page.click('#msgDirBar [data-msg-dir="up"]');
        await page.waitForTimeout(200);
        const upOnly = await page.$$eval('#msgList .msg-row', (els) => els.map((e) => e.innerText));
        ok('上行筛选只剩上行帧', upOnly.length >= 1 && upOnly.every((r) => r.includes('↑')), upOnly.length);
      }
    }
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
    await browser.close();
  }

  /* ---------------- 清理 ---------------- */
  srv.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  const after = await historyIds();
  for (const id of after) {
    if (!before.has(id)) await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((err) => {
  console.error('自检异常:', err && err.message);
  process.exitCode = 1;
});
