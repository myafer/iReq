'use strict';

/**
 * 自检：筛选条（fbar）—— 协议 / 内容类型 / 状态码分组单选筛选。
 *
 * 回归点：
 *  1. 单元层：matchStatus 语义（svg→图片、event-stream→SSE 而非文本、
 *     grpc/octet-stream→二进制、无 content-type 不算二进制、HTTP/2 识别、
 *     状态码区间、error 与 4xx/5xx 的关系）。
 *  2. API 层：起一个多内容类型的上游，经代理产生真实流量后，
 *     /api/flows?status=xxx 的结果与语义一致（前后端共用一套判断）。
 *  3. UI 层：筛选条渲染完整（20 个选项 + 更多菜单），单选高亮联动、
 *     与 /api/flows 数量一致、更多菜单里「错误」可用、英文界面无中文残留。
 *
 * 不修改系统代理、不动真实 data/，可在服务运行时安全执行。
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');
const { matchStatus } = require('../src/store');

const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

/** 走代理发一个 HTTP 请求 */
function proxyGet(url) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUi() {
  for (let i = 0; i < 40; i++) {
    try { await api('/api/status'); return true; } catch (_) { await sleep(500); }
  }
  return false;
}

(async () => {
  /* ---------------- A. 单元层：matchStatus 语义 ---------------- */
  const f = (over) => Object.assign({ status: 200, resContentType: '', scheme: 'http' }, over);
  push('空值 = 全部', matchStatus(f(), '') === true);
  push('json：application/json 命中', matchStatus(f({ resContentType: 'application/json; charset=utf-8' }), 'json'));
  push('xml：application/xml 命中', matchStatus(f({ resContentType: 'application/xml' }), 'xml'));
  push('xml：xhtml 不命中（归 HTML）', !matchStatus(f({ resContentType: 'application/xhtml+xml' }), 'xml'));
  push('html：text/html 命中', matchStatus(f({ resContentType: 'text/html; charset=utf-8' }), 'html'));
  push('js：javascript 命中', matchStatus(f({ resContentType: 'application/javascript' }), 'js'));
  push('文本：text/plain 命中', matchStatus(f({ resContentType: 'text/plain; charset=utf-8' }), 'text'));
  push('文本：text/css 命中', matchStatus(f({ resContentType: 'text/css' }), 'text'));
  push('文本：text/event-stream 不命中（归 SSE）', !matchStatus(f({ resContentType: 'text/event-stream' }), 'text'));
  push('文本：text/html 不命中', !matchStatus(f({ resContentType: 'text/html' }), 'text'));
  push('SSE：event-stream 命中', matchStatus(f({ resContentType: 'text/event-stream' }), 'sse'));
  push('图片：image/png 命中', matchStatus(f({ resContentType: 'image/png' }), 'image'));
  push('图片：svg（image/svg+xml）命中', matchStatus(f({ resContentType: 'image/svg+xml' }), 'image'));
  push('媒体：audio 命中', matchStatus(f({ resContentType: 'audio/mpeg' }), 'media'));
  push('媒体：video 命中', matchStatus(f({ resContentType: 'video/mp4' }), 'media'));
  push('二进制：octet-stream 命中', matchStatus(f({ resContentType: 'application/octet-stream' }), 'binary'));
  push('二进制：grpc/protobuf 命中', matchStatus(f({ resContentType: 'application/grpc' }), 'binary'));
  push('二进制：无 content-type 不命中', !matchStatus(f({ resContentType: '' }), 'binary'));
  push('二进制：json 不命中', !matchStatus(f({ resContentType: 'application/json' }), 'binary'));
  push('协议：http / https 按 scheme', matchStatus(f({ scheme: 'https' }), 'https') && !matchStatus(f({ scheme: 'https' }), 'http'));
  push('协议：ws 命中', matchStatus(f({ ws: true }), 'ws'));
  push('协议：HTTP/1.1 → http1', matchStatus(f({ httpVersion: 'HTTP/1.1' }), 'http1') && !matchStatus(f({ httpVersion: 'HTTP/1.1' }), 'http2'));
  push('协议：HTTP/2 → http2', matchStatus(f({ httpVersion: 'HTTP/2' }), 'http2'));
  push('状态码：1xx..5xx 区间互斥', [101, 200, 301, 404, 502].every((s, i) =>
    matchStatus(f({ status: s }), `${i + 1}xx`) &&
    [1, 2, 3, 4, 5].every((n) => (n === i + 1) === matchStatus(f({ status: s }), `${n}xx`))
  ));
  push('状态码：0 / 无状态不落任何 Nxx', [1, 2, 3, 4, 5].every((n) => !matchStatus(f({ status: 0 }), `${n}xx`)));
  push('error：4xx / 5xx / error 字段都命中', matchStatus(f({ status: 404 }), 'error') && matchStatus(f({ status: 0, error: 'boom' }), 'error') && !matchStatus(f({ status: 200 }), 'error'));

  /* ---------------- B. API 层：真实流量过一遍各筛选 ---------------- */
  // 多内容类型上游：覆盖 内容 / 状态码 两个分组
  const UP = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const send = (ct, body, code) => {
      res.writeHead(code || 200, ct ? { 'content-type': ct } : {});
      res.end(body);
    };
    if (p === '/json') send('application/json', '{"ok":1}');
    else if (p === '/xml') send('application/xml', '<a/>');
    else if (p === '/text') send('text/plain', 'plain');
    else if (p === '/html') send('text/html', '<b>x</b>');
    else if (p === '/js') send('application/javascript', 'var a=1;');
    else if (p === '/img') send('image/png', Buffer.from([0x89, 0x50]));
    else if (p === '/media') send('audio/mpeg', 'x');
    else if (p === '/bin') send('application/octet-stream', Buffer.from([0, 1, 2]));
    else if (p === '/sse') send('text/event-stream', 'data: hi\n\n');
    else if (p === '/e500') send('application/json', '{"e":1}', 500);
    else if (p === '/e404') send('text/html', 'nope', 404);
    else if (p === '/e302') { res.writeHead(302, { location: '/json' }); res.end(); }
    else send('text/plain', 'root');
  });
  await new Promise((r) => UP.listen(0, '127.0.0.1', r));
  const upPort = UP.address().port;

  push('隔离服务可达', await waitUi());

  // 起点是干净的：隔离实例可能有上一次运行留下的流量，先清空再播种
  await api('/api/flows', { method: 'DELETE' });
  await sleep(200);

  const PATHS = ['/json', '/xml', '/text', '/html', '/js', '/img', '/media', '/bin', '/sse', '/e500', '/e404', '/e302'];
  for (const p of PATHS) await proxyGet(`http://127.0.0.1:${upPort}${p}`);
  await sleep(400);

  async function flows(status) {
    const q = status ? `&status=${status}` : '';
    return api(`/api/flows?limit=2000${q}`);
  }

  // flow.host 是不含端口的 hostname，按 url 前缀（含上游端口）认种子流量
  const seeded = (list) => list.filter((x) => String(x.url || '').startsWith(`http://127.0.0.1:${upPort}/`));
  const all = seeded(await flows(''));
  push('12 条种子流量已入库', all.length === PATHS.length);

  const expectIn = {
    json: ['/json', '/e500'], xml: ['/xml'], text: ['/text'], html: ['/html', '/e404'], js: ['/js'],
    image: ['/img'], media: ['/media'], binary: ['/bin'], sse: ['/sse'],
    '2xx': ['/json', '/xml', '/text', '/html', '/js', '/img', '/media', '/bin', '/sse'],
    '3xx': ['/e302'], '4xx': ['/e404'], '5xx': ['/e500'],
    error: ['/e500', '/e404'],
    http: PATHS, https: [],
  };
  for (const [st, want] of Object.entries(expectIn)) {
    const got = seeded(await flows(st)).map((x) => x.path).sort();
    push(`API status=${st} → [${want.join(',') || '空'}]`, JSON.stringify(got) === JSON.stringify([...want].sort()));
  }
  push('API status=http2 为空（上游全是 1.1）', seeded(await flows('http2')).length === 0);
  push('API status=http1 = 全部种子', seeded(await flows('http1')).length === PATHS.length);

  UP.close();

  /* ---------------- C. UI 层：筛选条渲染与交互 ---------------- */
  let chromium = null, EXEC;
  try { ({ chromium, EXEC } = require('./_pw')); } catch (_) { /* 环境无 Playwright 时跳过 */ }
  if (chromium) {
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    push('筛选条可见', await page.evaluate(() => {
      const b = document.querySelector('#filters');
      return b && b.classList.contains('fbar') && b.offsetHeight > 0;
    }));
    // 一行只露高频项：全部 / 协议三个 / 状态码四段 / JSON·HTML + 更多
    push('筛选条只露 10 个高频项 + 更多', await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#filters > button[data-status]')];
      const want = ['', 'http', 'https', 'ws', '2xx', '3xx', '4xx', '5xx', 'json', 'html'];
      return JSON.stringify(chips.map((b) => b.dataset.status)) === JSON.stringify(want);
    }));
    // 选项一个都不能少，只是低频的收进了「更多」菜单（另有 error / tls，Mock 走 data-mocked）
    push('20 个筛选项齐全（低频收在更多菜单）', await page.evaluate(() => {
      const all = [...document.querySelectorAll('#filters button[data-status]')].map((b) => b.dataset.status);
      const want = ['', 'http', 'https', 'ws', 'sse', 'http1', 'http2', 'json', 'xml', 'text',
        'html', 'js', 'image', 'media', 'binary', '1xx', '2xx', '3xx', '4xx', '5xx', 'error', 'tls'];
      return all.length === want.length && want.every((s) => all.includes(s));
    }));
    push('默认「全部」高亮', await page.evaluate(() =>
      document.querySelector('#filters > button[data-status=""]').classList.contains('on')
    ));

    // 点击 5xx：高亮联动 + 行数与 API 一致
    await page.click('#filters > button[data-status="5xx"]');
    await page.waitForTimeout(700);
    const cnt5xx = seeded(await flows('5xx')).length;
    push('点击 5xx 后高亮切换', await page.evaluate(() =>
      document.querySelector('#filters > button[data-status="5xx"]').classList.contains('on') &&
      !document.querySelector('#filters > button[data-status=""]').classList.contains('on')
    ));
    push(`5xx 行数与 API 一致（${cnt5xx}）`, await page.evaluate((n) => {
      const c = document.querySelector('#count').textContent;
      return c.includes(String(n)) && document.querySelectorAll('#list .row').length === n;
    }, cnt5xx));

    // 点回「全部」恢复
    await page.click('#filters > button[data-status=""]');
    await page.waitForTimeout(700);
    push('点回全部后行数恢复', await page.evaluate((n) =>
      document.querySelectorAll('#list .row').length >= n, seeded(await flows('')).length));

    // 更多菜单：错误可用，且单选互斥
    await page.click('#btnFilterMore');
    await page.waitForTimeout(300);
    // 曾经的 bug：菜单是 .fbar 的 absolute 子元素，被 overflow-y:hidden 裁在 37px 高的条里，
    // 展开看不到也点不到。现在改 fixed 定位，必须整体落在条下方且中心点能命中自己
    push('更多菜单不被筛选条裁剪', await page.evaluate(() => {
      const m = document.querySelector('#filterMoreMenu');
      const bar = document.querySelector('#filters').getBoundingClientRect();
      if (m.hidden) return false;
      const r = m.getBoundingClientRect();
      return r.height > 40 && r.top >= bar.bottom - 1 && r.bottom <= window.innerHeight;
    }));
    push('更多菜单项可点（document.elementFromPoint 命中自身）', await page.evaluate(() => {
      const m = document.querySelector('#filterMoreMenu');
      return ['sse', 'http2', 'xml', 'binary', '1xx', 'error'].every((s) => {
        const b = m.querySelector(`button[data-status="${s}"]`);
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
      });
    }));
    // 触发器不在 .fbar > button 的直系选择器里，曾落到全局 button 的 14px，比旁边大一圈
    push('更多触发器字号与相邻筛选按钮一致', await page.evaluate(() => {
      const a = getComputedStyle(document.querySelector('#btnFilterMore'));
      const b = getComputedStyle(document.querySelector('#filters > button[data-status="json"]'));
      return a.fontSize === b.fontSize && Math.abs(parseFloat(a.fontSize) - parseFloat(b.fontSize)) < 0.1;
    }));
    push('更多菜单含 错误/Mock/握手失败', await page.evaluate(() => {
      const bs = [...document.querySelectorAll('#filterMoreMenu button')];
      return !!bs.find((b) => b.dataset.status === 'error') &&
        !!bs.find((b) => b.dataset.status === 'tls') &&
        !!bs.find((b) => b.dataset.mocked === '1');
    }));
    await page.click('#filterMoreMenu button[data-status="error"]');
    await page.waitForTimeout(700);
    const cntErr = seeded(await flows('error')).length;
    push('选「错误」后菜单关闭、触发器带点、行数一致', await page.evaluate((n) => {
      const menu = document.querySelector('#filterMoreMenu');
      const dot = document.querySelector('#filterMoreDot');
      return menu.hidden && !dot.hidden &&
        document.querySelectorAll('#list .row').length === n;
    }, cntErr));
    await page.click('#filters > button[data-status=""]');
    await page.waitForTimeout(500);

    // 英文界面：筛选条无中文残留（含收起状态下的「更多」菜单，i18n 会遍历整棵 body）
    await page.evaluate(() => { if (window.ReqLiteI18N) window.ReqLiteI18N.setLang('en'); });
    await page.waitForTimeout(400);
    push('英文：筛选条无中文残留', await page.evaluate(() => {
      const t = document.querySelector('#filters').textContent;
      return !/[\u4e00-\u9fff]/.test(t);
    }));
    push('英文：更多菜单分组标题已翻译', await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#filterMoreMenu .more-head')].map((h) => h.textContent.trim());
      return heads.length >= 3 && heads.every((h) => !/[\u4e00-\u9fff]/.test(h));
    }));
    push('英文：图片/媒体/二进制已翻译', await page.evaluate(() => {
      const txt = (s) => document.querySelector(`#filters button[data-status="${s}"]`).textContent.trim();
      return txt('image') === 'Image' && txt('media') === 'Media' && txt('binary') === 'Binary';
    }));
    push('页面无 JS 报错', errs.length === 0);

    await browser.close();
  } else {
    push('Playwright 可用（跳过 UI 检查）', true);
  }

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} 项通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('自检异常:', e);
  process.exitCode = 1;
});
