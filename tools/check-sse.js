'use strict';

/**
 * 自检：SSE 消息视图
 * ---------------------------------------------------------------------------
 * ① 基本分帧：event + data，空行为分隔
 * ② 多行 data：按规范用 \n 连接成一条
 * ③ 注释心跳：`:` 开头的行单独计数，不算消息
 * ④ 行尾：\n / \r\n / \r 三种都要认，且允许跨 TCP 包
 * ⑤ 元数据：id / retry 带出来
 * ⑥ 只有 event 没有 data 的块不算消息（规范如此）
 * ⑦ 上限：超出保留条数只计数
 * ⑧ 收尾：没有结尾空行的最后一条也要算
 * ⑨ 端到端：经代理的 SSE 流能按消息列出，且筛选条 sse 能筛到
 * ⑩ 界面：消息页签列出消息、事件名、心跳计数，点一条能看完整 data
 *
 * 会造流量，结束时清空流量并删掉自己生成的历史记录。
 */
const http = require('http');
const { SseParser } = require('../src/sse');
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

/* ------------------------------------------------------------ ①-⑧ 单元 */
{
  const p = new SseParser();
  const out = p.push('event: tick\ndata: {"n":1}\n\n: ping\n\ndata: a\ndata: b\n\n');
  ok('两条消息 + 一条注释', out.length === 2 && p.comments === 1, `${out.length}/${p.comments}`);
  ok('event 名带出来', out[0].event === 'tick', out[0].event);
  ok('默认事件名是 message', out[1].event === 'message', out[1].event);
  ok('多行 data 用换行连接', out[1].preview === 'a\nb', JSON.stringify(out[1].preview));
  ok('消息按顺序编号', out[0].i === 1 && out[1].i === 2);
  ok('体积按 UTF-8 字节算', out[0].size === Buffer.byteLength('{"n":1}'), out[0].size);

  // 只有 event / retry 的块不算消息
  const p2 = new SseParser();
  const onlyEvent = p2.push('event: ping\n\nretry: 3000\n\n');
  ok('没有 data 的块不算消息', onlyEvent.length === 0 && p2.count === 0, onlyEvent.length);

  // id / retry
  const p3 = new SseParser();
  const meta = p3.push('id: 42\nretry: 1500\ndata: x\n\n');
  ok('id 带出来', meta[0].id === '42', meta[0].id);
  ok('retry 带出来', meta[0].retry === 1500, meta[0].retry);

  // 行尾三种 + 跨包
  const p4 = new SseParser();
  const a = p4.push('data: one\r');
  const b = p4.push('\ndata: two\r\n\r\n');
  ok('\\r 与 \\r\\n 行尾都能认', b.map((x) => x.preview).join('|') === 'one|two', b.map((x) => x.preview).join('|'));
  const c = p4.push('data: three\n\n');
  ok('后续消息继续正常切', c.length === 1 && c[0].preview === 'three', c[0] && c[0].preview);

  // 冒号后的单个空格是分隔符，后面的空格属于内容
  const p5 = new SseParser();
  const sp = p5.push('data:  two-spaces\n\n');
  ok('只吃掉一个分隔空格', sp[0].preview === ' two-spaces', JSON.stringify(sp[0].preview));

  // 上限
  const p6 = new SseParser({ limit: 2 });
  let last = [];
  for (let i = 0; i < 4; i++) last = p6.push('data: m' + i + '\n\n');
  ok('只保留上限内的消息', p6.messages.length === 2, p6.messages.length);
  ok('超出部分计入 dropped 与 count', p6.count === 4 && p6.dropped === 2, `${p6.count}/${p6.dropped}`);

  // 收尾：没有结尾空行
  const p7 = new SseParser();
  p7.push('data: tail');
  const tail = p7.flush();
  ok('flush 补上最后一条', !!tail && tail.preview === 'tail', tail && tail.preview);
}

/* ------------------------------------------------------------ ⑨ 端到端 */
function startSseUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: tick\ndata: {"n":1}\n\n');
      setTimeout(() => res.write(': heartbeat\n\n'), 40);
      setTimeout(() => res.write('id: 7\ndata: line1\ndata: line2\n\n'), 80);
      setTimeout(() => {
        res.write('data: final\n\n');
        res.end();
      }, 120);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function viaProxy(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', () => resolve({ status: 0, text: '' }));
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
  const srv = await startSseUpstream();
  const port = srv.address().port;

  const r = await viaProxy(port, '/events');
  ok('流式响应完整转发给客户端', r.status === 200 && r.text.includes('line1'), r.status);
  await wait(150);

  const flow = await waitFlow('/events');
  ok('代理记录了这条 SSE 请求', !!flow, flow && flow.id);
  if (flow) {
    const m = await jsonApi('/api/flows/' + flow.id + '/messages');
    ok('消息接口返回 sse 段', !!(m.body && m.body.sse), m.body && Object.keys(m.body).join(','));
    const sse = (m.body && m.body.sse) || {};
    ok('切出三条消息', sse.count === 3, sse.count);
    const list = sse.messages || [];
    ok('第一条是 tick', list[0] && list[0].event === 'tick' && list[0].preview === '{"n":1}',
      list[0] && `${list[0].event}:${list[0].preview}`);
    ok('心跳注释单独计数', sse.comments === 1, sse.comments);
    ok('带 id 的消息保留 id', list[1] && list[1].id === '7', list[1] && list[1].id);
    ok('多行 data 合成一条', list[1] && list[1].preview === 'line1\nline2', list[1] && JSON.stringify(list[1].preview));
    ok('最后一条也在', list[2] && list[2].preview === 'final', list[2] && list[2].preview);
    ok('流结束后不再是 live', sse.live === false, sse.live);

    const detail = await jsonApi('/api/flows/' + flow.id);
    ok('摘要里带消息条数', Number(detail.body.sseCount) === 3, detail.body.sseCount);
    ok('响应类型是 event-stream', /text\/event-stream/i.test(detail.body.resContentType || ''), detail.body.resContentType);

    const filtered = await jsonApi('/api/flows?status=sse');
    const hit = (filtered.body || []).some((f) => f.id === flow.id);
    ok('筛选条 sse 能筛到这条', hit, (filtered.body || []).length);
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
    const row = await page.$('.row:has-text("/events")');
    ok('列表里能找到这条 SSE', !!row);
    if (row) {
      await row.click();
      await page.waitForSelector('#tabs');
      const tab = await page.$('#tabs button[data-tab="messages"]');
      ok('SSE 详情有「消息」页签', !!tab);
      if (tab) {
        await tab.click();
        await page.waitForTimeout(400);
        const rows = await page.$$eval('#msgList .msg-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
        ok('页签里列出消息', rows.length === 3, rows.length);
        ok('事件名显示出来', rows.some((r) => r.includes('tick')), rows.join(' | '));
        ok('心跳计入统计', (await page.textContent('#msgComments')).includes('1'), await page.textContent('#msgComments'));
        await page.click('#msgList .msg-item');
        await page.waitForTimeout(150);
        const body = await page.$eval('#msgList .msg-body', (el) => el.textContent.trim()).catch(() => '');
        ok('点一条能看完整 data', body === '{"n":1}', body);
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
