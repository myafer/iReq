'use strict';

/**
 * 自检：正文原始字节（下载 / 图片预览）
 * ---------------------------------------------------------------------------
 * ① 响应体：图片按 inline 给（能直接当 <img src>），加 dl=1 变 attachment
 * ② 文本体：也给得出来，内容与抓到的一致（不是 base64，是原文）
 * ③ 请求体：side=req 能拿到上行 body
 * ④ 嗅探：上游把图片写成 octet-stream 时按魔数纠正类型，预览才不会坏
 * ⑤ 历史：导入的 HAR 里同样能取原始字节（回看链路一套逻辑）
 * ⑥ 边界：不存在的 id、没有正文的响应都要给 404，不能抛
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let UP = 0;
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url || '';
      if (u.startsWith('/img-typed')) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
        return res.end(PNG);
      }
      if (u.startsWith('/img-untyped')) {
        // 上游乱写类型：靠魔数认
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': PNG.length });
        return res.end(PNG);
      }
      if (u.startsWith('/json')) {
        const body = '{"ok":true,"n":7}';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (u.startsWith('/empty')) {
        res.writeHead(204);
        return res.end();
      }
      // 回显请求体，用来验证 side=req
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
        res.end(body);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      UP = srv.address().port;
      resolve(srv);
    });
  });
}

function via(path, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve) => {
    const headers = { host: `127.0.0.1:${UP}` };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method, path: `http://127.0.0.1:${UP}${path}`, headers, timeout: 10000 },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/** 取原始字节（不走 fetch 的自动解压，自己拿 arrayBuffer） */
async function raw(url) {
  const res = await fetch(UI + url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

const jsonApi = async (p, opts = {}) => {
  const res = await fetch(UI + p, { headers: { 'content-type': 'application/json' }, ...opts });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

(async () => {
  const srv = await startUpstream();
  const histIds = [];
  try {
    // 清掉上次留下的流量，找 id 才不会串
    await jsonApi('/api/flows', { method: 'DELETE' });

    await via('/img-typed');
    await via('/img-untyped');
    await via('/json');
    await via('/empty');
    await via('/echo', { method: 'POST', body: '{"up":1}' });
    await new Promise((r) => setTimeout(r, 600));

    const page = (await jsonApi('/api/flows/page?limit=50')).body;
    const flows = page.flows || [];
    const find = (k) => flows.find((f) => String(f.url).includes(k));
    const img = find('/img-typed');
    const imgU = find('/img-untyped');
    const json = find('/json');
    const empty = find('/empty');
    const echo = find('/echo');

    ok('造出的流量都在', !!img && !!json && !!empty && !!echo, `${flows.length} 条`);

    // ---------------------------------------------------------- 图片（类型正确）
    const r1 = await raw(`/api/flows/${img.id}/body?side=res`);
    ok('图片能给原始字节', r1.status === 200 && Buffer.compare(r1.buf, PNG) === 0, `${r1.status} ${r1.buf.length}B`);
    ok('图片类型正确', r1.headers.get('content-type') === 'image/png', r1.headers.get('content-type'));
    ok('图片默认 inline（可直接 <img>）', /^inline/.test(r1.headers.get('content-disposition') || ''),
      r1.headers.get('content-disposition'));
    ok('带 nosniff', r1.headers.get('x-content-type-options') === 'nosniff');

    const r2 = await raw(`/api/flows/${img.id}/body?side=res&dl=1`);
    ok('dl=1 变附件下载', /^attachment/.test(r2.headers.get('content-disposition') || ''),
      r2.headers.get('content-disposition'));
    ok('下载文件名带扩展名', /\.png/.test(r2.headers.get('content-disposition') || ''),
      r2.headers.get('content-disposition'));

    // ---------------------------------------------------------- 图片（类型乱写 → 嗅探纠正）
    const r3 = await raw(`/api/flows/${imgU.id}/body?side=res`);
    ok('octet-stream 的图片按魔数纠正', r3.status === 200 && r3.headers.get('content-type') === 'image/png',
      r3.headers.get('content-type'));
    ok('纠正后同样 inline', /^inline/.test(r3.headers.get('content-disposition') || ''));

    // ---------------------------------------------------------- 文本
    const r4 = await raw(`/api/flows/${json.id}/body?side=res`);
    ok('文本体按原文给', r4.status === 200 && r4.buf.toString('utf8') === '{"ok":true,"n":7}', r4.buf.toString('utf8'));
    ok('文本体默认走下载（不是 inline）', /^attachment/.test(r4.headers.get('content-disposition') || ''),
      r4.headers.get('content-disposition'));
    ok('文本体带 json 扩展名', /\.json/.test(r4.headers.get('content-disposition') || ''),
      r4.headers.get('content-disposition'));

    // ---------------------------------------------------------- 请求体
    const r5 = await raw(`/api/flows/${echo.id}/body?side=req`);
    ok('请求体也能取', r5.status === 200 && r5.buf.toString('utf8') === '{"up":1}', r5.buf.toString('utf8'));

    // ---------------------------------------------------------- 边界
    const r6 = await raw(`/api/flows/${empty.id}/body?side=res`);
    ok('没有正文给 404', r6.status === 404, String(r6.status));
    const r7 = await raw('/api/flows/nope/body?side=res');
    ok('不存在的 id 给 404', r7.status === 404, String(r7.status));

    // ---------------------------------------------------------- 历史（导入的 HAR）
    const har = {
      log: {
        version: '1.2',
        entries: [
          {
            startedDateTime: '2026-11-14T10:00:00.000Z',
            time: 5,
            request: { method: 'GET', url: 'https://cdn.example.com/pic.png', headers: [] },
            response: {
              status: 200,
              statusText: 'OK',
              headers: [{ name: 'content-type', value: 'image/png' }],
              content: { size: PNG.length, mimeType: 'image/png', text: PNG.toString('base64'), encoding: 'base64' },
            },
          },
        ],
      },
    };
    const imp = await fetch(UI + '/api/har', {
      method: 'POST',
      headers: { 'content-type': 'application/har+json' },
      body: JSON.stringify(har),
    }).then((r) => r.json());
    histIds.push(imp.id);
    const hp = await jsonApi(`/api/history/${imp.id}/flows?limit=10`);
    const hf = (hp.body.flows || [])[0];
    ok('导入的 HAR 能回看到', !!hf, hf && hf.id);

    const r8 = await raw(`/api/history/${imp.id}/flows/${hf.id}/body?side=res`);
    ok('历史里的图片也能取原始字节', r8.status === 200 && Buffer.compare(r8.buf, PNG) === 0, `${r8.status} ${r8.buf.length}B`);
    ok('历史里的图片照样 inline', /^inline/.test(r8.headers.get('content-disposition') || ''));
  } finally {
    for (const id of histIds) {
      await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
    }
    await jsonApi('/api/flows', { method: 'DELETE' });
    srv.close();
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})();
