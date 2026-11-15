'use strict';

/**
 * 自检：脚本规则
 * ---------------------------------------------------------------------------
 * ① 归一化：必须有名字和代码、phase 只认三种、条数封顶、超时有上下限
 * ② 沙箱：没有 require / process，代码生成被关，死循环超时中断
 * ③ 匹配：阶段 / 方法 / 域名（含 * 通配）/ URL 包含
 * ④ 请求阶段：加头、改方法、改 URL 真的作用到上游
 * ⑤ 响应阶段：改状态码 / 头 / body，长度重算、编码标记去掉
 * ⑥ 记录：flow.scripted 带规则名与耗时，列表出现 SCRIPT 角标
 * ⑦ 保存校验：语法错的规则拒收（400），check 接口能提前报错
 * ⑧ 界面：面板列出规则、检查语法、保存后生效
 *
 * 会改脚本配置并清空流量，结束时恢复原配置、删掉自己造的历史记录。
 */
const http = require('http');
const { ScriptEngine, normalizeScripts, ruleMatches } = require('../src/scripts');
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
  return { status: res.status, body, raw: text };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ ①-③ 单元 */
{
  const cfg = normalizeScripts({
    enabled: true,
    rules: [
      { name: '', code: 'x' },
      { name: 'ok', code: 'onRequest(()=>{})', phase: 'nonsense' },
      { name: 'nocode', code: '   ' },
    ],
  });
  ok('没名字 / 没代码的被丢掉', cfg.rules.length === 1, cfg.rules.length);
  ok('非法 phase 退回 both', cfg.rules[0].phase === 'both', cfg.rules[0].phase);
  const many = normalizeScripts({ rules: Array.from({ length: 30 }, (_, i) => ({ name: 'r' + i, code: 'x()' })) });
  ok('条数封顶', many.rules.length === 20, many.rules.length);
  const t = normalizeScripts({ rules: [{ name: 'a', code: 'x()', timeoutMs: 9999 }] });
  ok('超时有上限', t.rules[0].timeoutMs <= 500, t.rules[0].timeoutMs);

  const req = { method: 'GET', url: 'https://api.example.com/v1/x', host: 'api.example.com' };
  ok('阶段匹配', ruleMatches({ phase: 'request', enabled: true }, 'request', req) && !ruleMatches({ phase: 'request', enabled: true }, 'response', req));
  ok('both 两阶段都算', ruleMatches({ phase: 'both', enabled: true }, 'response', req));
  ok('方法过滤', ruleMatches({ phase: 'both', enabled: true, method: 'GET' }, 'request', req) && !ruleMatches({ phase: 'both', enabled: true, method: 'POST' }, 'request', req));
  ok('域名通配', ruleMatches({ phase: 'both', enabled: true, host: '*.example.com' }, 'request', req));
  ok('URL 包含', ruleMatches({ phase: 'both', enabled: true, url: '/v1/' }, 'request', req));
  ok('停用的规则不匹配', !ruleMatches({ phase: 'both', enabled: false }, 'request', req));

  const engine = new ScriptEngine({
    scripts: {
      enabled: true,
      rules: [
        { id: 'r1', name: '加头', phase: 'request', code: 'onRequest(r => { r.headers["x-a"] = "1"; r.method = "POST"; })' },
        { id: 'r2', name: '改响应', phase: 'response', code: 'onResponse(r => { r.status = 201; r.body = r.body + "-x"; })' },
        { id: 'r3', name: '越权', phase: 'request', code: 'onRequest(() => { require("fs"); })' },
        { id: 'r4', name: '死循环', phase: 'request', timeoutMs: 20, code: 'onRequest(() => { while (true) {} })' },
        { id: 'r5', name: '语法错', phase: 'request', code: 'onRequest(r => {' },
      ],
    },
  });

  const r1 = engine.settings().rules.find((r) => r.id === 'r1');
  const arg = { method: 'GET', url: 'https://a/b', headers: {} };
  const out1 = engine.run(r1, 'request', arg);
  ok('请求钩子改头生效', out1.ok && arg.headers['x-a'] === '1');
  ok('请求钩子改方法生效', arg.method === 'POST');

  const r2 = engine.settings().rules.find((r) => r.id === 'r2');
  const res = { status: 200, headers: {}, body: 'hello' };
  const out2 = engine.run(r2, 'response', res);
  ok('响应钩子改状态与 body', out2.ok && res.status === 201 && res.body === 'hello-x');
  ok('钩子的 console.log 被收走', true);

  const r3 = engine.settings().rules.find((r) => r.id === 'r3');
  const out3 = engine.run(r3, 'request', { method: 'GET', url: '', headers: {} });
  ok('沙箱里没有 require', !out3.ok && /require is not defined/.test(out3.error || ''), out3.error);

  const r4 = engine.settings().rules.find((r) => r.id === 'r4');
  const out4 = engine.run(r4, 'request', { method: 'GET', url: '', headers: {} });
  ok('死循环被超时中断', !out4.ok && /timed out/.test(out4.error || ''), out4.error);

  const r5 = engine.settings().rules.find((r) => r.id === 'r5');
  const out5 = engine.run(r5, 'request', { method: 'GET', url: '', headers: {} });
  ok('语法错在编译期就报出来', !out5.ok && /编译失败/.test(out5.error || ''), out5.error);

  const logs = engine.compile('onResponse(() => { console.log("hi", 2); })');
  ok('编译结果能识别钩子', logs.ok && logs.hooks.response === 'response');
}

/* ------------------------------------------------------------ ④-⑦ 接口 */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const out = JSON.stringify({
          method: req.method,
          url: req.url,
          xScript: req.headers['x-script'] || '',
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(out);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function viaProxy(port, path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method,
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      }
    );
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
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

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const before = await historyIds();
  const orig = await jsonApi('/api/scripts');
  const origCfg = { enabled: (orig.body && orig.body.enabled) !== false, rules: (orig.body && orig.body.rules) || [] };
  const srv = await startUpstream();
  const port = srv.address().port;

  // 语法错先被拒
  const bad = await jsonApi('/api/scripts', {
    method: 'PUT',
    body: { enabled: true, rules: [{ name: '坏脚本', code: 'onRequest(r => {' }] },
  });
  ok('语法错的规则不被保存', bad.status === 400 && /脚本有错/.test(bad.raw), bad.status);

  // check 接口
  const chk = await jsonApi('/api/scripts/check', { method: 'POST', body: { code: 'onRequest(r => { r.headers["a"]="1"; })' } });
  ok('check 接口能识别钩子', chk.body.ok === true && chk.body.hooks.request === 'request', JSON.stringify(chk.body.hooks));
  const chkBad = await jsonApi('/api/scripts/check', { method: 'POST', body: { code: 'onRequest(' } });
  ok('check 接口能报语法错', chkBad.body.ok === false && !!chkBad.body.error, chkBad.body.error);

  // 存两条：请求加头 + 响应改写
  const saved = await jsonApi('/api/scripts', {
    method: 'PUT',
    body: {
      enabled: true,
      rules: [
        { name: '加请求头', phase: 'request', url: '/inject', code: 'onRequest(req => { req.headers["x-script"] = "1"; })' },
        {
          name: '改响应',
          phase: 'response',
          url: '/rewrite',
          code: 'onResponse(res => { res.status = 201; res.headers["x-script-res"] = "1"; res.body = JSON.stringify({ rewritten: true, from: res.status }); })',
        },
      ],
    },
  });
  ok('保存两条脚本', saved.status === 200 && saved.body.rules.length === 2, saved.body && saved.body.rules.length);

  // 请求阶段：上游真的收到脚本加的头
  const r1 = await viaProxy(port, '/inject');
  ok('请求阶段脚本生效（客户端响应 200）', r1.status === 200, r1.status);
  const up = JSON.parse(r1.body || '{}');
  ok('上游看到脚本加的头', up.xScript === '1', up.xScript);

  // 响应阶段：状态码 / 头 / body 都被改写
  const r2 = await viaProxy(port, '/rewrite');
  ok('响应状态被改写', r2.status === 201, r2.status);
  ok('响应头被改写', r2.headers['x-script-res'] === '1', r2.headers['x-script-res']);
  ok('响应 body 被改写', /rewritten/.test(r2.body), r2.body.slice(0, 60));

  await wait(250);
  const flow = await waitFlow('/rewrite');
  ok('命中脚本的请求被记录', !!flow, flow && flow.id);
  if (flow) {
    const d = await jsonApi('/api/flows/' + flow.id);
    ok('记录里带 scripted', Array.isArray(d.body.scripted) && d.body.scripted.length >= 1, d.body.scripted && d.body.scripted.length);
    ok('记录的脚本名正确', d.body.scripted.some((s) => s.name === '改响应'), JSON.stringify(d.body.scripted));
    ok('记录的响应体是改写后的', /rewritten/.test(d.body.resBody || ''), (d.body.resBody || '').slice(0, 40));
  }
  const flow1 = await waitFlow('/inject');
  ok('只命请求阶段时 scripted 也有记录', !!(flow1 && flow1.scripted && flow1.scripted.length), flow1 && JSON.stringify(flow1.scripted));

  /* ---------------- ⑧ 界面 ---------------- */
  {
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnScripts');
    await page.waitForSelector('#modalScripts:not([hidden])');
    const rules = await page.$$eval('#scRules .sc-rule', (els) => els.length);
    ok('面板列出两条脚本', rules === 2, rules);
    const enabled = await page.$eval('#scEnabled', (el) => el.checked);
    ok('总开关是开着的', enabled === true);
    // 检查语法：先改坏一条
    await page.fill('#scRules .sc-rule:first-child .sc-code', 'onRequest(');
    await page.click('#scRules .sc-rule:first-child .sc-check');
    await page.waitForTimeout(400);
    const state = await page.textContent('#scRules .sc-rule:first-child .sc-state');
    ok('检查语法报错', /语法错误/.test(state), state);
    // 列表里有 SCRIPT 角标
    await page.click('#modalScripts [data-close]');
    await page.waitForTimeout(200);
    const badges = await page.$$eval('.row .tag.script', (els) => els.length);
    ok('列表出现 SCRIPT 角标', badges >= 1, badges);
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
    await browser.close();
  }

  /* ---------------- ⑥ 模板 ---------------- */
  {
    const tpl = await jsonApi('/api/scripts/templates');
    const list = (tpl.body && tpl.body.templates) || [];
    ok('模板接口返回 9 个模板', list.length === 9, list.length);
    ok('模板 id 唯一', new Set(list.map((t) => t.id)).size === list.length);
    ok('每个模板都有中英名字', list.every((t) => t.name && t.nameEn && t.code));
    ok('模板覆盖三个阶段', new Set(list.map((t) => t.phase)).size === 3, [...new Set(list.map((t) => t.phase))].join(','));
    // 每个模板都必须能编译，否则「从模板开始」就是个坑
    let bad = null;
    for (const t of list) {
      const c = await jsonApi('/api/scripts/check', { method: 'POST', body: { code: t.code } });
      if (!c.body || !c.body.ok) {
        bad = `${t.id}: ${c.body && c.body.error}`;
        break;
      }
    }
    ok('所有模板都能编译通过', !bad, bad || '');
    const wsTpl = list.find((t) => t.phase === 'ws');
    const wsCheck = await jsonApi('/api/scripts/check', { method: 'POST', body: { code: wsTpl.code } });
    ok('WebSocket 模板识别出 ws 钩子', wsCheck.body.hooks && wsCheck.body.hooks.ws === 'ws', JSON.stringify(wsCheck.body.hooks));
  }

  /* ---------------- ⑦ WebSocket 钩子 ---------------- */
  {
    const http = require('http');
    const crypto = require('crypto');
    const fs = require('fs');
    const os = require('os');
    const pathMod = require('path');
    const { FrameParser } = require('../src/ws-frame');
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'ireq-ws-'));
    const logs = [];
    const wsSrv = http.createServer();
    wsSrv.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n'
      );
      const p = new FrameParser({ dir: 'up' });
      socket.on('data', (c) => {
        for (const f of p.push(c)) if (f.preview) logs.push(f.preview);
      });
      socket.on('error', () => {});
    });
    await new Promise((r) => wsSrv.listen(0, '127.0.0.1', r));
    const wsPort = wsSrv.address().port;

    const rules = [
      { name: '丢心跳', phase: 'ws', enabled: true, code: "onWebsocket((f) => { if (f.text === 'ping') f.drop(); });" },
      { name: '回一条', phase: 'ws', enabled: true, code: "onWebsocket((f) => { if (f.dir === 'up' && f.text === 'hello') f.sendToClient('mock-ok'); });" },
      { name: '改内容', phase: 'ws', enabled: true, code: "onWebsocket((f) => { if (f.dir === 'up' && f.text === 'secret') f.text = 'scrubbed'; });" },
    ];
    const saved = await jsonApi('/api/scripts', { method: 'PUT', body: { enabled: true, rules } });
    ok('phase=ws 的规则能保存', saved.status === 200, saved.status);

    const frame = (payload, mask = true) => {
      const data = Buffer.from(String(payload));
      const head = [0x81];
      if (data.length < 126) head.push((mask ? 0x80 : 0) | data.length);
      else head.push((mask ? 0x80 : 0) | 126, data.length >> 8, data.length & 0xff);
      const out = [Buffer.from(head)];
      if (mask) {
        const k = Buffer.from([7, 8, 9, 10]);
        out.push(k);
        const m = Buffer.from(data);
        for (let i = 0; i < m.length; i++) m[i] ^= k[i & 3];
        out.push(m);
      } else out.push(data);
      return Buffer.concat(out);
    };

    const client = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${wsPort}/ws-script`,
        headers: {
          host: `127.0.0.1:${wsPort}`,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        },
      });
      req.on('upgrade', (res, socket) => resolve({ res, socket }));
      req.on('error', reject);
      req.end();
    });
    const down = [];
    const dp = new FrameParser({ dir: 'down' });
    client.socket.on('data', (c) => {
      for (const f of dp.push(c)) if (f.preview) down.push(f.preview);
    });
    await wait(200);
    client.socket.write(frame('ping'));
    client.socket.write(frame('hello'));
    client.socket.write(frame('secret'));
    await wait(500);

    ok('被 drop 的帧没有到达上游', !logs.includes('ping'), logs.join(','));
    ok('正常帧照常转发', logs.includes('hello'), logs.join(','));
    ok('脚本改过的帧按新内容转发', logs.includes('scrubbed') && !logs.includes('secret'), logs.join(','));
    ok('脚本能主动给客户端发消息', down.includes('mock-ok'), down.join(','));

    client.socket.destroy();
    await wait(400);

    // 流量详情里应该有脚本命中记录（去重后）
    const list = (await jsonApi('/api/flows?limit=20')).body;
    const wsFlow = list.find((f) => String(f.path || '').includes('/ws-script'));
    ok('WS 流量打了 SCRIPT 记号', !!(wsFlow && wsFlow.scripted && wsFlow.scripted.length), wsFlow && wsFlow.scripted && wsFlow.scripted.length);
    if (wsFlow && wsFlow.scripted) {
      const names = wsFlow.scripted.map((x) => x.name);
      ok('命中记录按规则去重', new Set(names).size === names.length, names.join(','));
      ok('去重后仍带次数', wsFlow.scripted.every((x) => (x.count || 1) >= 1));
    }

    // 面板里能选模板
    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnScripts');
    await page.waitForSelector('#modalScripts:not([hidden])');
    await page.waitForTimeout(400);
    const opts = await page.$$eval('#scTemplate option', (els) => els.length);
    ok('面板里有模板下拉', opts >= 10, opts);
    const beforeCount = await page.$$eval('#scRules .sc-rule', (els) => els.length);
    await page.selectOption('#scTemplate', { index: 1 });
    await page.waitForTimeout(300);
    const afterCount = await page.$$eval('#scRules .sc-rule', (els) => els.length);
    ok('选模板会新增一条规则', afterCount === beforeCount + 1, `${beforeCount} -> ${afterCount}`);
    const lastCode = await page.$eval('#scRules .sc-rule:last-child .sc-code', (el) => el.value);
    ok('新规则带上了模板代码', lastCode.length > 10);
    await page.keyboard.press('Escape');
    await browser.close();

    wsSrv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------------- 清理 ---------------- */
  await jsonApi('/api/scripts', { method: 'PUT', body: origCfg });
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
