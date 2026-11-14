'use strict';

/**
 * 自检：导入 HAR
 * ---------------------------------------------------------------------------
 * ① 解析：方法 / URL / 状态 / 耗时 / 请求体 / 响应体（含 base64）都要落对
 * ② 落盘：变成侧栏的一条历史记录，名字优先用 HAR 里的页面标题
 * ③ 回看：走的是和「清空留档」完全相同的读法，字段与实时抓包一致
 * ④ 标记：导入的流量带 imported / 来源应用，不和本机抓的混在一起
 * ⑤ 错误：不是 JSON / 没有 entries / 空文件，都要给 400 而不是抛异常
 * ⑥ 收尾：删掉自己造的那条记录，不留垃圾
 */
const { UI } = require('./_env');

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
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeHar() {
  return {
    log: {
      version: '1.2',
      creator: { name: 'some-tool', version: '1.0' },
      pages: [{ startedDateTime: '2026-11-14T10:00:00.000Z', id: 'page_1', title: '自检会话' }],
      entries: [
        {
          startedDateTime: '2026-11-14T10:00:01.000Z',
          time: 123,
          request: {
            method: 'GET',
            url: 'https://api.example.com/v1/user/42?x=1',
            headers: [{ name: 'Accept', value: 'application/json' }],
          },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
            content: {
              size: 24,
              mimeType: 'application/json; charset=utf-8',
              text: '{"id":42,"name":"jojo"}',
            },
          },
        },
        {
          startedDateTime: '2026-11-14T10:00:02.000Z',
          time: 88,
          request: {
            method: 'POST',
            url: 'https://api.example.com/v1/login',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            postData: { mimeType: 'application/json', text: '{"user":"a","pw":"b"}' },
          },
          response: {
            status: 401,
            statusText: 'Unauthorized',
            headers: [{ name: 'content-type', value: 'application/json' }],
            content: { size: 21, mimeType: 'application/json', text: '{"error":"bad creds"}' },
          },
        },
        {
          startedDateTime: '2026-11-14T10:00:03.000Z',
          time: 15,
          request: {
            method: 'GET',
            url: 'https://cdn.example.com/logo.png',
            headers: [],
          },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [{ name: 'content-type', value: 'image/png' }],
            content: { size: 68, mimeType: 'image/png', text: PNG_B64, encoding: 'base64' },
          },
        },
      ],
    },
  };
}

const importOnce = async (harText, name) => {
  const res = await fetch(UI + '/api/har' + (name ? `?name=${encodeURIComponent(name)}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'application/har+json' },
    body: harText,
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

(async () => {
  const har = makeHar();
  let id = '';

  try {
    // ---------------------------------------------------------- 正常导入
    const out = await importOnce(JSON.stringify(har));
    ok('导入成功', out.status === 200, `${out.status} ${out.body && (out.body.error || '')}`);
    id = (out.body && out.body.id) || '';
    ok('条数正确', out.body && out.body.count === 3, out.body && String(out.body.count));
    ok('名字取 HAR 里的页面标题', out.body && out.body.name === '自检会话', out.body && out.body.name);

    // ---------------------------------------------------------- 侧栏记录
    const hist = await jsonApi('/api/history');
    const item = (hist.body.items || []).find((x) => x.id === id);
    ok('出现在历史记录列表里', !!item, item && item.name);
    ok('记录里带条数', item && item.count === 3, item && String(item.count));
    ok('记录有文件大小', item && item.bytes > 0, item && String(item.bytes));

    // ---------------------------------------------------------- 回看
    const page = await jsonApi(`/api/history/${id}/flows?limit=50`);
    const flows = (page.body && page.body.flows) || [];
    ok('回看到 3 条', flows.length === 3, String(flows.length));

    // 回看是新→旧
    const png = flows.find((f) => String(f.url).includes('logo.png'));
    const login = flows.find((f) => String(f.url).includes('/v1/login'));
    const user = flows.find((f) => String(f.url).includes('/v1/user'));

    ok('方法保住', user && user.method === 'GET' && login && login.method === 'POST');
    ok('状态码保住', user && user.status === 200 && login && login.status === 401,
      user && `${user.status} / ${login && login.status}`);
    ok('耗时保住', user && user.duration === 123, user && String(user.duration));
    ok('接口结构归一化', user && user.route === 'GET /v1/user/:id', user && user.route);
    ok('查询串保住', user && user.path.includes('?x=1'), user && user.path);
    ok('导入的流量有来源标记', user && user.imported === true && user.app === 'HAR 导入',
      user && `${user.app} / ${user.imported}`);

    // ---------------------------------------------------------- 单条 + 请求头 / body
    const one = await jsonApi(`/api/history/${id}/flows/${user.id}`);
    ok('单条详情能取', one.status === 200 && one.body && one.body.id === user.id, String(one.status));
    ok('请求头按对象存', one.body && one.body.reqHeaders && one.body.reqHeaders.accept === 'application/json',
      one.body && JSON.stringify(one.body.reqHeaders));
    // 列表为了体积不带 body，正文只在单条里给
    const oneLogin = await jsonApi(`/api/history/${id}/flows/${login.id}`);
    ok('请求体保住', String((oneLogin.body && oneLogin.body.reqBody) || '').includes('"user":"a"'),
      oneLogin.body && String(oneLogin.body.reqBody).slice(0, 40));
    ok('响应体保住', String((one.body && one.body.resBody) || '').includes('"name":"jojo"'),
      one.body && String(one.body.resBody).slice(0, 30));
    const onePng = await jsonApi(`/api/history/${id}/flows/${png.id}`);
    ok('base64 响应体按二进制存', !!onePng.body.resBodyBase64 && onePng.body.resBody == null,
      String(!!onePng.body.resBodyBase64));
    ok('响应类型保住', png && String(png.resContentType).includes('image/png'), png && png.resContentType);

    // ---------------------------------------------------------- 指定名字
    const named = await importOnce(JSON.stringify(har), '别人给的包');
    ok('可以用调用方给的名字', named.status === 200 && named.body.name === '别人给的包', named.body && named.body.name);
    // 立刻删掉这份，别留在侧栏
    await jsonApi(`/api/history/${named.body.id}`, { method: 'DELETE' });

    // ---------------------------------------------------------- 错误分支
    const bad1 = await importOnce('not json at all');
    ok('非 JSON 给 400', bad1.status === 400, String(bad1.status) + ' ' + (bad1.body && bad1.body.error));
    const bad2 = await importOnce(JSON.stringify({ log: { version: '1.2' } }));
    ok('没有 entries 给 400', bad2.status === 400, bad2.body && bad2.body.error);
    const bad3 = await importOnce('');
    ok('空文件给 400', bad3.status === 400, bad3.body && bad3.body.error);
    const bad4 = await importOnce(JSON.stringify({ log: { entries: [] } }));
    ok('空 entries 给 400', bad4.status === 400, bad4.body && bad4.body.error);
  } finally {
    // ---------------------------------------------------------- 收尾
    if (id) await jsonApi(`/api/history/${id}`, { method: 'DELETE' });
    const after = await jsonApi('/api/history');
    const gone = !((after.body.items || []).some((x) => x.id === id));
    ok('删掉后不再出现在列表', gone);
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})();
