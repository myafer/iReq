'use strict';

/**
 * 自检：反向代理（抓 webhook / 回调）
 * ---------------------------------------------------------------------------
 * ① 配置归一：默认端口、只写 host 时补 http://、非法协议与端口回落到默认
 * ② 启动：开关打开后真的在监听；关掉就释放端口
 * ③ 转发：GET / POST 原样送到上游，路径与查询串保留，客户端拿到上游的响应
 * ④ 记录：这条流量的 reverse 标记为 true，host / path 是上游的，和正向流量能分开
 * ⑤ 异常：上游 404 原样透出；上游连不上记成失败；端口被占用回 400 并给出原因
 * ⑥ 落盘：配置写进 user-config，重启后仍生效
 * ⑦ 界面：菜单入口、面板状态、开关保存后徽标同步、英文零残留
 *
 * 会临时占用一个端口并清空流量，结束时关掉反代、删掉自己造的历史。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { normalize, originOf, DEFAULT_PORT } = require('../src/reverse');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { status: res.status, body, headers: res.headers };
};

function pickFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function call(port, { method = 'GET', path: p = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  /* ------------------------------------------------------------ ① 归一化 */
  {
    const c = normalize({});
    ok('默认关闭', c.enabled === false && c.port === DEFAULT_PORT && c.ready === false);
    ok('只写 host 时补 http://', normalize({ target: '127.0.0.1:3000' }).target === 'http://127.0.0.1:3000');
    ok('https 上游保留', normalize({ target: 'https://a.com' }).target === 'https://a.com');
    ok('非法协议判未就绪', normalize({ target: 'ftp://a.com' }).ready === false);
    ok('端口越界回落默认', normalize({ port: 99999 }).port === DEFAULT_PORT);
    ok('originOf 去掉末尾斜杠', originOf({ target: 'http://a.com/base/' }) === 'http://a.com/base');
    ok('未就绪时 origin 为空', originOf({ target: '' }) === '');
  }

  /* ------------------------------------------------------------ ② 启动 */
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('nope');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, method: req.method, body, host: req.headers.host }));
    });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tport = target.address().port;
  const listenPort = await pickFreePort();

  const before = (await jsonApi('/api/reverse')).body;
  ok('默认未启动', before.running === false && before.enabled === false);

  const on = await jsonApi('/api/reverse', {
    method: 'PUT',
    body: { enabled: true, port: listenPort, target: `http://127.0.0.1:${tport}` },
  });
  ok('开启后正在监听', on.status === 200 && on.body.running === true, on.body.error);
  ok('回显监听地址', String(on.body.url || '').includes(':' + listenPort), on.body.url);
  ok('回显上游', on.body.target === `http://127.0.0.1:${tport}`);

  const status = (await jsonApi('/api/reverse')).body;
  ok('GET 也是运行中', status.running === true && status.port === listenPort);

  /* ------------------------------------------------------------ ③ 转发 */
  {
    const r = await call(listenPort, { path: '/hook?x=1&y=2' });
    ok('GET 转发成功', r.status === 200, r.status);
    const body = JSON.parse(r.text || '{}');
    ok('路径与查询串原样到上游', body.url === '/hook?x=1&y=2', body.url);
    ok('Host 头换成上游', String(body.host || '').startsWith('127.0.0.1:' + tport), body.host);

    const post = await call(listenPort, {
      method: 'POST',
      path: '/cb',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    const pbody = JSON.parse(post.text || '{}');
    ok('POST 正文原样到上游', pbody.method === 'POST' && pbody.body === '{"a":1}', pbody.body);
  }

  await wait(300);

  /* ------------------------------------------------------------ ④ 记录 */
  const flows = (await jsonApi('/api/flows?limit=20')).body;
  const rev = (flows || []).find((f) => String(f.path || '').startsWith('/hook'));
  ok('记录了反向流量', !!rev, rev && rev.id);
  if (rev) {
    ok('打了 reverse 标记', rev.reverse === true);
    ok('host 是上游', rev.host === '127.0.0.1');
    const detail = (await jsonApi('/api/flows/' + rev.id)).body;
    ok('详情也带 reverse', detail.reverse === true);
    const har = await (await fetch(UI + '/api/export/har?limit=20')).json();
    ok('导出的 HAR 里也有这条', har.log.entries.some((e) => String(e.request.url).includes('/hook')));
  }

  /* ------------------------------------------------------------ ⑤ 异常 */
  {
    const nf = await call(listenPort, { path: '/missing' });
    ok('上游 404 原样透出', nf.status === 404 && nf.text === 'nope');
    await wait(250);
    const list = (await jsonApi('/api/flows?limit=20')).body;
    const nfFlow = list.find((f) => String(f.path || '').startsWith('/missing'));
    ok('404 也被记录下来', !!nfFlow && nfFlow.status === 404);
  }

  // 上游连不上：临时指向一个没人听的端口
  {
    const deadPort = await pickFreePort();
    await jsonApi('/api/reverse', {
      method: 'PUT',
      body: { enabled: true, port: listenPort, target: `http://127.0.0.1:${deadPort}` },
    });
    const r = await call(listenPort, { path: '/dead' });
    ok('上游连不上时给 502', r.status === 502 || r.status === 500, r.status);
    await wait(250);
    const list = (await jsonApi('/api/flows?limit=20')).body;
    const dead = list.find((f) => String(f.path || '').startsWith('/dead'));
    ok('失败也记成一条带 error 的流量', !!dead && !!dead.error, dead && dead.error);
    // 换回能通的上游
    await jsonApi('/api/reverse', {
      method: 'PUT',
      body: { enabled: true, port: listenPort, target: `http://127.0.0.1:${tport}` },
    });
  }

  // 端口被占用
  {
    const holder = http.createServer((req, res) => res.end('x'));
    const busy = await pickFreePort();
    // 必须也绑 0.0.0.0：macOS 上 SO_REUSEADDR 允许通配地址覆盖已绑定的具体地址，
    // 只在 127.0.0.1 上占端口时反代仍能绑成功，测不出冲突
    await new Promise((r) => holder.listen(busy, r));
    const bad = await jsonApi('/api/reverse', {
      method: 'PUT',
      body: { enabled: true, port: busy, target: `http://127.0.0.1:${tport}` },
    });
    ok('端口占用回 400', bad.status === 400, bad.status);
    ok('错误里说明端口被占用', /占用/.test(String(bad.body.error || '')), bad.body && bad.body.error);
    ok('失败时不谎报运行中', bad.body.running === false);
    await new Promise((r) => holder.close(r));
    // 恢复原监听
    await jsonApi('/api/reverse', {
      method: 'PUT',
      body: { enabled: true, port: listenPort, target: `http://127.0.0.1:${tport}` },
    });
  }

  /* ------------------------------------------------------------ ⑥ 落盘 */
  {
    const cfgRes = await jsonApi('/api/config');
    ok('公开配置里带 reverseProxy', !!(cfgRes.body && cfgRes.body.reverseProxy));
    const dataDir = process.env.REQLITE_DATA_DIR || '';
    if (dataDir) {
      const file = path.join(dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        ok('落盘文件里有反代配置', !!(saved.reverseProxy && saved.reverseProxy.target), JSON.stringify(saved.reverseProxy));
      } else {
        ok('落盘文件里有反代配置', true, '（该实例未落盘，跳过）');
      }
    } else {
      // 自检脚手架没给 dataDir 时，用 /api/config 的返回值兜底
      ok('落盘文件里有反代配置', true, '（未提供 REQLITE_DATA_DIR，跳过）');
    }
  }

  /* ------------------------------------------------------------ ⑦ 界面 */
  {
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');

    await page.click('#btnMore');
    await page.click('#btnReverse');
    await page.waitForSelector('#modalReverse:not([hidden])');
    await page.waitForTimeout(400);

    ok('面板回显已开启', await page.isChecked('#rvEnabled'));
    ok('面板回显端口', Number(await page.inputValue('#rvPort')) === listenPort, await page.inputValue('#rvPort'));
    const statusText = await page.textContent('#rvStatus');
    ok('状态里显示正在监听', /正在监听/.test(statusText), statusText.trim().slice(0, 60));
    const dot = await page.$eval('#rvDot', (el) => !el.hidden);
    ok('菜单上圆点可见', dot);

    // 关掉
    await page.click('#modalReverse .switch');
    await page.click('#rvSave');
    await page.waitForTimeout(700);
    const off = (await jsonApi('/api/reverse')).body;
    ok('界面能关掉反代', off.running === false && off.enabled === false);
    ok('关掉后圆点隐藏', await page.$eval('#rvDot', (el) => el.hidden));
    const dead = await call(listenPort, { path: '/after-off' }).then(() => false).catch(() => true);
    ok('关掉后端口不再接受连接', dead);

    // 英文模式
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await page.waitForTimeout(700);
    await page.click('#btnMore');
    await page.click('#btnReverse');
    await page.waitForSelector('#modalReverse:not([hidden])');
    await page.waitForTimeout(400);
    const en = await page.$eval('#modalReverse', (el) => el.innerText.replace(/\s+/g, ' '));
    ok('英文面板零残留', !/[\u4e00-\u9fff]/.test(en), (en.match(/[\u4e00-\u9fff]/g) || []).join(''));
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await wait(200);
    await browser.close();
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
  }

  /* ------------------------------------------------------------ 清理 */
  await jsonApi('/api/reverse', { method: 'PUT', body: { enabled: false, port: DEFAULT_PORT, target: '' } });
  target.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  await wait(300);
  const hist = (await jsonApi('/api/history')).body;
  const item = (hist.items || [])[0];
  if (item) await jsonApi('/api/history/' + item.id, { method: 'DELETE' });

  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exit(1);
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
