'use strict';

/**
 * 生成 README 用的截图。
 *
 * 为什么要脚本而不是随手截：图里一旦混进真实域名、内网 IP、令牌或用户名，
 * 就是一次泄漏，而且很难事后发现。这里所有流量都是现造的假数据，
 * 域名统一走 `*.demo.example`（靠域名映射指到本地），并在截图前断言页面上
 * 没有局域网 IP、没有 /Users/ 路径、没有用户名。
 *
 * 用法：
 *   node bin/ireq.js start -p 9393 -u 9394 -b 127.0.0.1 -d /tmp/ireq-shots --no-persist
 *   node tools/shots.js
 *
 * 产物写到 docs/shots/（已在 README 里引用）。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium, EXEC } = require('./_pw');

const UI = 'http://127.0.0.1:' + (process.env.REQLITE_UI_PORT || 9394);
const PROXY = Number(process.env.REQLITE_PROXY_PORT || 9393);
const OUT = path.join(__dirname, '..', 'docs', 'shots');

const leakPatterns = [
  [/(^|\D)(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}/, '局域网 IP'],
  [/\/Users\//, '/Users/ 路径'],
  [/\bjojo\b/i, '用户名'],
  // 域名段必须以字母开头：不然 /cover/home@2x.png 这种路径会被当成邮箱（踩过）
  [/[\w.+-]+@(?!demo\.example)[a-z][\w-]*\.[a-z]{2,}/i, '真实邮箱'],
];

function audit(text) {
  const hits = [];
  for (const [re, label] of leakPatterns) if (re.test(text)) hits.push(label);
  return hits;
}
const api = (p, o = {}) => fetch(UI + p, { headers: { 'content-type': 'application/json' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 演示用上游：全是假数据 ---------------- */
const FEED = {
  code: 0,
  data: {
    items: [
      { id: 101, title: '一次函数与图像', subject: 'math', progress: 0.62, duration: 1260 },
      { id: 102, title: '文言文阅读：岳阳楼记', subject: 'chinese', progress: 0.18, duration: 1540 },
      { id: 103, title: '完形填空专项', subject: 'english', progress: 0.95, duration: 980 },
    ],
    next_cursor: '',
  },
};
const SCHEDULE = {
  code: 0,
  data: { lesson_id: 4821, date: '2026-11-16', start: '19:30', minutes: 45, teacher: '王老师', room: 'A-203' },
};

function makeUpstream() {
  return http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req_demo_7f21' });
        res.end(JSON.stringify(obj));
      };
      if (u === '/v1/home/feed') return setTimeout(() => json(FEED), 40);
      if (u === '/v1/lesson/4821/schedule') return setTimeout(() => json(SCHEDULE), 90);
      if (u === '/v1/auth/login') return setTimeout(() => json({ code: 0, data: { token: 'demo-token-9f3a71c4', uid: 88021 } }), 120);
      if (u === '/v1/user/profile') return setTimeout(() => json({ code: 0, data: { nickname: '同学 A', grade: 8, vip: false } }), 60);
      if (u === '/v1/pay/order/88213') {
        return setTimeout(() => json({ code: 50021, message: 'upstream timeout' }, 500), 240);
      }
      if (u === '/v1/legacy/notice') return setTimeout(() => json({ message: 'not found' }, 404), 30);
      if (u === '/v1/report/export') return setTimeout(() => json({ code: 0, data: { rows: 128, url: 'https://cdn.demo.example/report/2026-10.xlsx' } }), 900);
      if (u === '/v1/home/recommend') return setTimeout(() => json({ code: 0, data: { items: [{ id: 7, title: '错题本精选' }] } }), 70);
      if (u === '/v1/search') return setTimeout(() => json({ code: 0, data: { total: 3, hits: [] } }), 150);
      if (u === '/cover/home@2x.png') {
        // 1x1 透明 PNG：只为了列表里有一条图片请求
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
        return res.end(png);
      }
      json({ code: 0, data: {} });
    });
  });
}

/* ---------------- SSE / WS 上游 ---------------- */
function makeSse() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('event: tick\ndata: {"lesson":4821,"seconds_left":2700}\n\n');
    setTimeout(() => res.write('event: tick\ndata: {"lesson":4821,"seconds_left":2640}\n\n'), 80);
    setTimeout(() => res.write(': heartbeat\n\n'), 140);
    setTimeout(() => { res.write('event: done\ndata: {"lesson":4821,"reason":"teacher_end"}\n\n'); res.end(); }, 220);
  });
}

function makeWs() {
  const srv = http.createServer();
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const send = (t) => {
      const d = Buffer.from(t);
      const head = [0x81, d.length];
      socket.write(Buffer.concat([Buffer.from(head), d]));
    };
    setTimeout(() => send('{"type":"welcome","session":"demo-2f81"}'), 60);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  return srv;
}

function frame(payload) {
  const d = Buffer.from(String(payload));
  const head = [0x81];
  if (d.length < 126) head.push(0x80 | d.length);
  else head.push(0x80 | 126, d.length >> 8, d.length & 0xff);
  const k = Buffer.from([3, 1, 4, 1]);
  const m = Buffer.from(d);
  for (let i = 0; i < m.length; i++) m[i] ^= k[i & 3];
  return Buffer.concat([Buffer.from(head), k, m]);
}

function viaProxy(host, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY, method, path: `http://${host}${path}`, headers: { host, ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const up = makeUpstream();
  await new Promise((r) => up.listen(9401, '127.0.0.1', r));
  const sse = makeSse();
  await new Promise((r) => sse.listen(9402, '127.0.0.1', r));
  const ws = makeWs();
  await new Promise((r) => ws.listen(9403, '127.0.0.1', r));

  // 域名映射：演示流量都走假域名，截图里不会出现任何真实主机
  await api('/api/hostmap', {
    method: 'PUT',
    body: {
      enabled: true,
      rules: [
        { from: 'api.demo.example', to: 'http://127.0.0.1:9401' },
        { from: 'cdn.demo.example', to: 'http://127.0.0.1:9401' },
      ],
    },
  });

  const AUTH = { authorization: 'Bearer demo-token-9f3a71c4', 'x-client': 'android/8.2.0' };
  await viaProxy('api.demo.example', '/v1/home/feed?page=1&size=20', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/lesson/4821/schedule?date=2026-11-16', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/auth/login?access_token=demo-abc123', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"account":"demo","password":"demo-pass"}',
  });
  await viaProxy('cdn.demo.example', '/cover/home@2x.png', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/user/profile', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/pay/order/88213', { method: 'POST', headers: AUTH, body: '{"sku":"term_8_1","amount":199}' });
  await viaProxy('api.demo.example', '/v1/legacy/notice', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/report/export?month=2026-10', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/home/recommend', { headers: AUTH });
  await viaProxy('api.demo.example', '/v1/search?q=physics', { headers: AUTH });
  await wait(400);

  // 标注：让列表有颜色条 + 星标 + 备注徽标
  const flows = (await api('/api/flows?limit=30')).body;
  const pay = flows.find((f) => f.path.startsWith('/v1/pay'));
  const sched = flows.find((f) => f.path.startsWith('/v1/lesson/4821'));
  if (pay) await api(`/api/flows/${pay.id}/annotation`, { method: 'PUT', body: { note: '首次点击支付失败，上游 5s 超时；重试两次仍 500', color: 'red', pinned: true } });
  if (sched) await api(`/api/flows/${sched.id}/annotation`, { method: 'PUT', body: { note: '登录后这份课表是关键路径，P95 要盯住', color: 'blue' } });

  const browser = await chromium.launch({ executablePath: EXEC });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(UI + '/', { waitUntil: 'networkidle' });
  await page.keyboard.press('Escape');

  // 顶栏切到本机回环，避免把局域网 IP 拍进去
  const headText = await page.$eval('#addrBox', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
  if (!/127\.0\.0\.1/.test(headText)) {
    await page.click('#addrPick');
    await page.waitForSelector('#addrOptions .addr-opt[data-addr="127.0.0.1"]');
    await page.click('#addrOptions .addr-opt[data-addr="127.0.0.1"]');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(600);

  const leaks = audit(await page.innerText('body'));
  console.log('sensitive check:', leaks.length ? 'FOUND ' + leaks.join(',') : 'clean');
  if (leaks.length) throw new Error('截图里出现敏感信息: ' + leaks.join(','));

  // 选中支付那条（有红色标注 + 500）
  const payRow = await page.$('.row:has-text("/v1/pay/order/88213")');
  if (payRow) { await payRow.click(); await page.waitForTimeout(500); }

  await page.screenshot({ path: path.join(OUT, 'main.png') });
  console.log('shot main-light');

  // 会话总览
  await page.click('#btnMore');
  await page.click('#btnOverview');
  await page.waitForSelector('#modalOverview:not([hidden])');
  await page.waitForTimeout(800);
  await page.locator('.ov-dialog').screenshot({ path: path.join(OUT, 'overview.png') });
  console.log('shot overview');
  await page.keyboard.press('Escape');

  // 脱敏对照：先选那条 URL 带 access_token 的登录请求
  const loginRow = await page.$('.row:has-text("/v1/auth/login")');
  if (loginRow) { await loginRow.click(); await page.waitForTimeout(300); }
  await page.click('#btnMore');
  await page.click('#btnRedact');
  await page.waitForSelector('#modalRedact:not([hidden])');
  await page.waitForTimeout(900);
  await page.locator('.rd-dialog').screenshot({ path: path.join(OUT, 'redact.png') });
  console.log('shot redact');
  await page.keyboard.press('Escape');

  // 深色主界面
  await page.click('#btnMore');
  await page.click('#btnTheme');
  await page.waitForTimeout(500);
  if (payRow) { const r2 = await page.$('.row:has-text("/v1/pay/order/88213")'); if (r2) await r2.click(); }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'main-dark.png') });
  console.log('shot main-dark');
  await page.click('#btnMore');
  await page.click('#btnTheme');
  await page.waitForTimeout(300);

  // WebSocket 与 SSE：只拍详情里的「消息」页签，不出主机名
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PROXY, path: 'http://127.0.0.1:9403/ws/lesson/4821',
      headers: { host: '127.0.0.1:9403', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') },
    });
    req.on('upgrade', (res, socket) => {
      setTimeout(() => socket.write(frame('{"type":"join","lesson":4821}')), 150);
      setTimeout(() => socket.write(frame('{"type":"answer","qid":12,"ok":true}')), 300);
      setTimeout(() => { socket.destroy(); resolve(); }, 700);
    });
    req.on('error', reject);
    req.end();
  });
  await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PROXY, path: 'http://127.0.0.1:9402/events', headers: { host: '127.0.0.1:9402' } }, (r) => { r.resume(); r.on('end', resolve); });
  });
  await wait(600);

  // 列表会随新流量重绘：一律用选择器点击（会自动重新解析），不要留着旧 handle
  await page.waitForTimeout(300);
  if (await page.$('.row:has-text("/ws/lesson/4821")')) {
    await page.click('.row:has-text("/ws/lesson/4821")');
    await page.waitForSelector('#tabs');
    if (await page.$('#tabs button[data-tab="messages"]')) {
      await page.click('#tabs button[data-tab="messages"]');
      await page.waitForTimeout(700);
    }
    await page.locator('#detail').screenshot({ path: path.join(OUT, 'messages.png') });
    console.log('shot messages');
  }

  // 性能 / 总览之外的第三张：详情概览（含耗时瀑布）
  // 列表会随新流量重绘，旧 handle 可能已经脱离 DOM：这里每次都重新查
  // 详情概览（含分段耗时瀑布）：列表 / 详情都会被新流量重绘，
  // 每步都要确认「选中的确实是这条」，否则会拍到一个没有瀑布图的 WS 详情
  let shotTiming = false;
  for (let i = 0; i < 6 && !shotTiming; i++) {
    try {
      const clicked = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#list .row')].filter((r) =>
          r.textContent.includes('/v1/lesson/4821/schedule'));
        const row = rows.find((r) => r.getBoundingClientRect().height > 0) || rows[0];
        if (!row) return false;
        row.click();
        return true;
      });
      if (!clicked) {
        await page.waitForTimeout(350);
        continue;
      }
      await page.waitForSelector('#tabs', { timeout: 2000 });
      const onSchedule = await page.evaluate(() =>
        ((document.querySelector('#detail .durl') || {}).textContent || '').includes('schedule'));
      if (!onSchedule) {
        await page.waitForTimeout(350);
        continue;
      }
      const tab = await page.$('#tabs button[data-tab="timing"]');
      if (!tab) {
        await page.waitForTimeout(350);
        continue;
      }
      await tab.click();
      await page.waitForSelector('#detail .wf-row', { timeout: 2000 });
      await page.waitForTimeout(400);
      await page.locator('#detail').screenshot({ path: path.join(OUT, 'timing.png') });
      console.log('shot timing');
      shotTiming = true;
    } catch (err) {
      console.log('timing retry ' + (i + 1) + ':', String((err && err.message) || err).split('\n')[0]);
      await page.waitForTimeout(400);
    }
  }
  if (!shotTiming) console.log('⚠️ 耗时截图跳过：没等到 #detail .wf-row');

  await browser.close();
  up.close(); sse.close(); ws.close();

  // 全窗口图缩到 1800 宽：README 里按 900 显示，2x 屏刚好，体积也小一半
  if (process.platform === 'darwin') {
    for (const name of ['main.png', 'main-dark.png']) {
      try {
        require('child_process').execFileSync('sips', ['-Z', '1800', path.join(OUT, name)], { stdio: 'ignore' });
      } catch (_) {
        /* 没装 sips（非 macOS）就保持原尺寸，不影响使用 */
      }
    }
  }
  console.log('\n写好了：' + OUT);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
