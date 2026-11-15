'use strict';

/**
 * 自检：脱敏（导出 / MCP / redact=1）
 * ---------------------------------------------------------------------------
 * ① 头部：命中名单（大小写不敏感）、数组值、保留认证 scheme、未命中原样
 * ② 查询串：命中参数的只换值、没命中的不动（code 这类泛化名字不误伤）
 * ③ 正文：JSON 嵌套 / 数组 / 三种命名风格、表单、纯文本、二进制不动
 * ④ 开关：关掉时一条都不动（返回同一个对象，不产生副本）
 * ⑤ 派生列：按列配置的 path 判断，值里的 token 也打码
 * ⑥ 额外名单：数组与「逗号分隔字符串」都认
 * ⑦ 接口：GET / PUT /api/redact 往返；预览接口给「打码前 / 后」与处数
 * ⑧ 出口：实时导出 HAR 打码 + log.comment + x-ireq-redacted；关掉后导出原值
 * ⑨ 出口：历史记录导出同样打码
 * ⑩ 出口：GET /api/flows/:id?redact=1 与正文下载 ?redact=1
 * ⑪ MCP：get_flow 给模型的内容已打码，并写明打了几处
 * ⑫ 界面：面板能开、预览有高亮、子开关即时重算、保存后徽标更新、英文模式零残留
 *
 * 会改脱敏配置并清空流量，结束时恢复配置、删掉自己造的历史与令牌。
 */
const http = require('http');
const {
  redactFlow,
  redactFlows,
  redactUrl,
  redactBodyText,
  normalize,
  lists,
  PLACEHOLDER,
  DEFAULT_HEADERS,
} = require('../src/redact');
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

function viaProxy(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method: opts.method || 'GET',
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}`, ...(opts.headers || {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  /* ---------------------------------------------------------- ① 头部 */
  {
    const f = {
      url: 'https://a.com/x',
      reqHeaders: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        cookie: 'sid=abc; theme=dark',
        'X-Trace-Id': 'keep-me',
      },
      resHeaders: { 'Set-Cookie': ['sid=1; Path=/', 'theme=dark'] },
    };
    const out = redactFlow(f, { enabled: true });
    ok('认证头保留 scheme', out.reqHeaders.Authorization === 'Bearer ' + PLACEHOLDER, out.reqHeaders.Authorization);
    ok('Cookie 整体打码', out.reqHeaders.cookie === PLACEHOLDER);
    ok('Set-Cookie 数组逐项打码', Array.isArray(out.resHeaders['Set-Cookie']) && out.resHeaders['Set-Cookie'].length === 2 && out.resHeaders['Set-Cookie'][0] === PLACEHOLDER);
    ok('普通头不动', out.reqHeaders['X-Trace-Id'] === 'keep-me');
    ok('大小写不敏感', redactFlow({ url: 'https://a.com', reqHeaders: { AUTHORIZATION: 'Basic dXNlcjpwdw==' } }, { enabled: true }).reqHeaders.AUTHORIZATION === 'Basic ' + PLACEHOLDER);
    ok('不修改原对象', f.reqHeaders.Authorization.startsWith('Bearer ey'));
  }

  /* ---------------------------------------------------------- ② 查询串 */
  {
    const cfg = { enabled: true };
    const url = redactUrl('https://a.com/api?token=abc&id=7&access_token=zz&code=200', { query: lists(cfg).query }, { n: 0, parts: new Set() });
    ok('查询串命中值的打码', url.includes(`token=${encodeURIComponent(PLACEHOLDER)}`), url);
    ok('查询串下划线名也命中', url.includes(`access_token=${encodeURIComponent(PLACEHOLDER)}`));
    ok('普通参数不动', url.includes('id=7'));
    ok('泛化的 code 不误伤', url.includes('code=200'));
  }

  /* ---------------------------------------------------------- ③ 正文 */
  {
    const cfg = { enabled: true };
    const c = () => ({ n: 0, parts: new Set() });
    const fields = lists(cfg).fields;
    const json = JSON.stringify({
      data: { access_token: 't1', accessToken: 't2', 'access-token': 't3', items: [{ password: 'p' }, { ok: 1 }] },
      code: 0,
    });
    const a = JSON.parse(redactBodyText(json, 'application/json', fields, c()));
    ok('JSON 下划线风格', a.data.access_token === PLACEHOLDER);
    ok('JSON 驼峰风格', a.data.accessToken === PLACEHOLDER);
    ok('JSON 连字符风格', a.data['access-token'] === PLACEHOLDER);
    ok('JSON 数组里的对象', a.data.items[0].password === PLACEHOLDER && a.data.items[1].ok === 1);
    ok('JSON 普通字段不动', a.code === 0);

    const form = redactBodyText('user=jojo&password=p%40ss&x=1', 'application/x-www-form-urlencoded', fields, c());
    ok('表单正文', form === `user=jojo&password=${encodeURIComponent(PLACEHOLDER)}&x=1`, form);

    const text = redactBodyText('login ok token=abc123&x=1 password: hunter2', 'text/plain', fields, c());
    ok('纯文本按键值兜底', text.includes('token=' + PLACEHOLDER) && text.includes('password: ' + PLACEHOLDER), text);

    const bin = '/9j/4AAQSkZJRgABAQ==';
    ok('二进制正文不动', redactBodyText(bin, 'image/png', fields, c()) === bin);

    const cnt = c();
    redactBodyText(json, 'application/json', fields, cnt);
    ok('正文计数', cnt.n === 4, cnt.n);
  }

  /* ---------------------------------------------------------- ④ 开关 */
  {
    const f = { url: 'https://a.com?token=1', reqHeaders: { authorization: 'Bearer x' } };
    ok('关掉时不产生副本', redactFlow(f, { enabled: false }) === f);
    const out = redactFlows([f], { enabled: false });
    ok('关掉时计数为 0', out.count === 0 && out.flows[0] === f);
  }

  /* ---------------------------------------------------------- ⑤ 派生列 */
  {
    const f = { derived: { c1: 'secret-token', c2: 'v1.2.3' } };
    const cols = [
      { id: 'c1', name: 'Token', path: 'data.access_token' },
      { id: 'c2', name: 'Ver', path: 'h:x-version' },
    ];
    const out = redactFlow(f, { enabled: true }, cols);
    ok('派生列按 path 判定', out.derived.c1 === PLACEHOLDER && out.derived.c2 === 'v1.2.3', JSON.stringify(out.derived));
  }

  /* ---------------------------------------------------------- ⑥ 额外名单 */
  {
    ok('额外头：数组', lists(normalize({ extraHeaders: ['x-company'] })).headers.has('x-company'));
    ok('额外头：逗号字符串', lists(normalize({ extraHeaders: 'x-a, x-b' })).headers.has('x-b'));
    ok('额外字段：连字符归一', lists(normalize({ extraFields: 'device-id' })).fields.has('deviceid'));
    const n = redactFlow(
      { url: 'https://a.com?openid=o1', reqHeaders: { 'x-company-token': 'secret' } },
      { enabled: true, extraHeaders: 'x-company-token', extraFields: 'openid' }
    );
    ok('额外名单真生效', n.reqHeaders['x-company-token'] === PLACEHOLDER && n.url.includes(encodeURIComponent(PLACEHOLDER)));
  }

  /* ---------------------------------------------------------- ⑦ 接口 */
  const orig = (await jsonApi('/api/redact')).body;
  ok('默认开启', orig && orig.enabled === true);
  ok('默认名单给出', Array.isArray(orig.effective.headers) && orig.effective.headers.includes('authorization'));
  ok('默认不打码 PII', orig.pii === false && orig.effective.fields.includes('token') && !orig.effective.fields.includes('phone'));
  ok('默认头名单与模块一致', DEFAULT_HEADERS.every((h) => orig.effective.headers.includes(h)));

  /* ---------------- 造一条「到处都是凭据」的流量 ---------------- */
  const srv = http.createServer((req, res) => {
    let reqBody = '';
    req.on('data', (c) => (reqBody += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=res-cookie' });
      res.end(JSON.stringify({ code: 0, data: { access_token: 'resp-token', user: { name: 'jojo' } }, echo: reqBody.length }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const sentBody = JSON.stringify({ user: 'jojo', password: 'p@ssw0rd' });
  const r = await viaProxy(port, '/login?token=query-token&id=7', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer req-token',
      cookie: 'sid=req-cookie',
      'x-trace-id': 'trace-keep',
    },
    body: sentBody,
  });
  ok('上游正常响应', r.status === 200, r.status);
  await wait(200);

  const list = (await jsonApi('/api/flows?limit=10')).body;
  const flow = (list || []).find((f) => String(f.path || '').startsWith('/login'));
  ok('抓到这条流量', !!flow, flow && flow.id);

  /* ---------------------------------------------------------- ⑩ 流量接口 */
  if (flow) {
    const raw = await jsonApi('/api/flows/' + flow.id);
    const rawText = JSON.stringify(raw.body);
    ok('默认接口给原值', rawText.includes('req-cookie') && rawText.includes('p@ssw0rd'));
    ok('原值里能看到真 token', rawText.includes('req-token') && rawText.includes('query-token'));
    const safe = await jsonApi('/api/flows/' + flow.id + '?redact=1');
    const safeText = JSON.stringify(safe.body);
    ok('redact=1 时凭据消失', !safeText.includes('req-token') && !safeText.includes('query-token') && !safeText.includes('p@ssw0rd'), safeText.slice(0, 80));
    ok('redact=1 时占位符出现', safeText.includes(PLACEHOLDER));
    const safeList = await jsonApi('/api/flows?limit=10&redact=1');
    // URL 里的占位符会被编码成 %5BREDACTED%5D，按片段判更稳
    ok('列表也认 redact=1', /REDACTED/.test(JSON.stringify(safeList.body)) && !JSON.stringify(safeList.body).includes('query-token'));

    const dlRaw = await fetch(UI + '/api/flows/' + flow.id + '/body?side=req');
    const dlRawText = await dlRaw.text();
    ok('正文下载默认原值', dlRawText.includes('p@ssw0rd'));
    const dlSafe = await fetch(UI + '/api/flows/' + flow.id + '/body?side=req&redact=1');
    const dlSafeText = await dlSafe.text();
    ok('正文下载 redact=1 打码', !dlSafeText.includes('p@ssw0rd') && dlSafeText.includes(PLACEHOLDER), dlSafeText.slice(0, 60));
  }

  /* ---------------------------------------------------------- ⑧ 实时导出 */
  const harOn = await fetch(UI + '/api/export/har?limit=20');
  const harOnText = await harOn.text();
  const harOnJson = JSON.parse(harOnText);
  ok('导出带上打码计数', Number(harOn.headers.get('x-ireq-redacted') || 0) > 0, harOn.headers.get('x-ireq-redacted'));
  ok('HAR 里没有真 token', !harOnText.includes('req-token') && !harOnText.includes('resp-token') && !harOnText.includes('query-token'));
  ok('HAR comment 说明已脱敏', /已脱敏 \d+ 处/.test(String(harOnJson.log.comment || '')), harOnJson.log.comment);
  const entry = harOnJson.log.entries.find((e) => String(e.request.url).includes('/login'));
  ok('HAR 里 URL 打码', entry && !String(entry.request.url).includes('query-token') && String(entry.request.url).includes(encodeURIComponent(PLACEHOLDER)));
  ok('HAR 里请求头打码', entry && entry.request.headers.some((h) => h.name.toLowerCase() === 'authorization' && h.value === 'Bearer ' + PLACEHOLDER));
  ok('HAR 里请求体打码', entry && String(entry.request.postData.text).includes(PLACEHOLDER) && !String(entry.request.postData.text).includes('p@ssw0rd'));
  ok('HAR 里响应体打码', entry && String(entry.response.content.text).includes(PLACEHOLDER) && !String(entry.response.content.text).includes('resp-token'));

  /* 关掉开关：同一份导出应该是原值 */
  await jsonApi('/api/redact', { method: 'PUT', body: { enabled: false } });
  const harOff = await fetch(UI + '/api/export/har?limit=20');
  const harOffText = await harOff.text();
  ok('关掉后导出原值', harOffText.includes('req-token') && harOffText.includes('resp-token'));
  ok('关掉后不再写 comment', !JSON.parse(harOffText).log.comment);
  ok('关掉后计数为 0', harOff.headers.get('x-ireq-redacted') === '0');
  await jsonApi('/api/redact', { method: 'PUT', body: { enabled: true } });

  /* ---------------------------------------------------------- ⑦ 预览 */
  if (flow) {
    const pv = await jsonApi('/api/redact/preview?id=' + flow.id);
    ok('预览给出处数', pv.body && pv.body.count > 0, pv.body && pv.body.count);
    ok('预览前含原值、后不含', String(pv.body.before.url).includes('query-token') && !String(pv.body.after.url).includes('query-token'));
    const draft = await jsonApi('/api/redact/preview?draft=1&id=' + flow.id + '&enabled=1&headers=1');
    ok('草稿预览按参数算（只勾头）', draft.body && draft.body.before.url === draft.body.after.url && draft.body.count > 0, draft.body && draft.body.count);
    const offDraft = await jsonApi('/api/redact/preview?draft=1&id=' + flow.id + '&enabled=0');
    ok('草稿关掉时处数为 0', offDraft.body.count === 0);
  }

  /* ---------------------------------------------------------- ⑪ MCP */
  {
    const before = (await jsonApi('/api/mcp')).body;
    await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: true } });
    const tk = await jsonApi('/api/mcp/tokens', { method: 'POST', body: { name: 'check-redact', scopes: ['read'], expiresInDays: 1 } });
    const token = tk.body && tk.body.token;
    ok('拿到只读令牌', !!token);
    if (token && flow) {
      const call = await fetch(UI + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_flow', arguments: { id: flow.id } } }),
      });
      const out = await call.json();
      const text = JSON.stringify(out.result || {});
      ok('MCP 输出已打码', !text.includes('req-token') && !text.includes('resp-token') && !text.includes('p@ssw0rd'), text.slice(0, 80));
      ok('MCP 写明打了几处', /已按脱敏规则打码 \d+ 处/.test(text));
      const listCall = await fetch(UI + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_flows', arguments: { limit: 5 } } }),
      });
      const listOut = JSON.stringify((await listCall.json()).result || {});
      ok('MCP 列表里的 URL 也打码', !listOut.includes('query-token'));
      // 撤销令牌
      const tokId = tk.body.id || (tk.body.tokenId || '');
      if (tokId) await jsonApi('/api/mcp/tokens/' + tokId, { method: 'DELETE' });
      if (!before.enabled) await jsonApi('/api/mcp', { method: 'PUT', body: { enabled: false } });
    }
  }

  /* ---------------------------------------------------------- ⑫ 界面 */
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

    // 先选中那条带 token 的流量，预览才有内容
    const row = await page.$('.row:has-text("/login")');
    if (row) await row.click();
    await page.waitForTimeout(200);

    await page.click('#btnMore');
    await page.click('#btnRedact');
    await page.waitForSelector('#modalRedact:not([hidden])');
    await page.waitForTimeout(600);

    const badge = await page.$eval('#redactState', (el) => !el.hidden);
    ok('菜单上的「开」徽标可见', badge);
    ok('四个子开关在', (await page.$$('#modalRedact .rd-check')).length === 4);

    const count = await page.textContent('#rdCount');
    ok('预览给出处数', /\d+ 处会打码/.test(count), count);
    const marks = await page.$$eval('#rdPreview mark', (els) => els.length);
    ok('预览里有高亮占位符', marks > 0, marks);
    const panes = await page.$$eval('#rdPreview .rd-pane', (els) => els.length);
    ok('预览是两栏对照', panes === 2);

    // 取消勾选「URL 查询参数」→ 预览里 URL 不再被打码
    await page.uncheck('#rdQuery');
    await page.waitForTimeout(500);
    const afterUrl = await page.$eval('#rdPreview .rd-pane:nth-child(2) .rd-row', (el) => el.innerText);
    ok('子开关即时重算预览', !afterUrl.includes('REDACTED'), afterUrl.slice(0, 60));
    await page.check('#rdQuery');
    await page.waitForTimeout(400);

    // 关掉总开关保存 → 徽标消失（总开关是自定义 switch，input 本身不可见，点 label 才符合用户操作）
    await page.click('#modalRedact .switch');
    await page.waitForTimeout(200);
    const masterOff = await page.$eval('#rdEnabled', (el) => !el.checked);
    ok('点开关能关掉总开关', masterOff);
    await page.click('#rdSave');
    await page.waitForTimeout(600);
    const cfg1 = (await jsonApi('/api/redact')).body;
    ok('保存后总开关落库', cfg1.enabled === false);
    const hidden = await page.$eval('#redactState', (el) => el.hidden);
    ok('关掉后徽标隐藏', hidden);

    // 再打开
    await page.click('#btnMore');
    await page.click('#btnRedact');
    await page.waitForSelector('#modalRedact:not([hidden])');
    await page.waitForTimeout(300);
    await page.click('#modalRedact .switch');
    await page.waitForTimeout(200);
    await page.click('#rdSave');
    await page.waitForTimeout(600);
    ok('重新开启生效', (await jsonApi('/api/redact')).body.enabled === true);

    // 英文模式零残留
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await page.waitForTimeout(700);
    await page.click('#btnMore');
    await page.click('#btnRedact');
    await page.waitForSelector('#modalRedact:not([hidden])');
    await page.waitForTimeout(500);
    const en = await page.$eval('#modalRedact', (el) => el.innerText.replace(/\s+/g, ' '));
    ok('英文面板没有残留中文', !/[\u4e00-\u9fff]/.test(en), (en.match(/[\u4e00-\u9fff]/g) || []).join(''));
    await page.screenshot({ path: '/tmp/redact-en.png' });
    await page.keyboard.press('Escape');
    await page.click('#btnMore');
    await page.click('#btnLang');
    await browser.close();
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
  }

  /* ---------------------------------------------------------- ⑨ 历史导出 */
  {
    // 清空会把当前流量归档成一条历史，正好用来验历史导出这条独立链路
    await jsonApi('/api/flows', { method: 'DELETE' });
    await wait(400);
    const hist = (await jsonApi('/api/history')).body;
    const item = (hist.items || hist || [])[0];
    ok('清空后有历史记录', !!item, item && item.name);
    if (item) {
      const res = await fetch(UI + `/api/history/${item.id}/export?format=har`);
      const text = await res.text();
      ok('历史导出默认打码', !text.includes('req-token') && !text.includes('resp-token'));
      ok('历史导出写了 comment', /已脱敏 \d+ 处/.test(String(JSON.parse(text).log.comment || '')));
      ok('历史导出计数头', Number(res.headers.get('x-ireq-redacted') || 0) > 0);
      await jsonApi('/api/history/' + item.id, { method: 'DELETE' });
    }
  }

  /* ---------------------------------------------------------- 清理 */
  srv.close();
  await jsonApi('/api/redact', { method: 'PUT', body: { enabled: true, headers: true, query: true, body: true, pii: false } });
  console.log(`\n${pass}/${total} 项通过`);
  if (pass !== total) process.exit(1);
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
