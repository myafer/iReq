'use strict';

/**
 * 自检：域名映射
 * ---------------------------------------------------------------------------
 * ① 解析：`127.0.0.1:8080` / `http://h:p/base` / `https://h` 三种写法
 * ② 匹配：`*` 通配、路径前缀、开关关闭时不命中、按顺序取第一条
 * ③ 转发：上游真的收到映射后的请求；Host 头仍是原域名（虚拟主机不懵）
 * ④ 路径：from / to 两侧前缀的四种组合都要拼对
 * ⑤ 记录：列表里 URL 还是原地址，另带「映射到 xx」的标记
 * ⑥ 关掉开关后请求回到直连（域名解析不到 → 失败），不留残留规则
 *
 * 只改内存里的映射配置，结束时清空规则并关开关；上游是自检自己起的临时服务。
 */
const http = require('http');
const { HostMap, splitFrom, parseTo } = require('../src/hostmap');
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

const put = (rules, enabled = true) => jsonApi('/api/hostmap', { method: 'PUT', body: { rules, enabled } });

// ---------------------------------------------------------------- 单元：解析
{
  const t = parseTo('127.0.0.1:8080');
  ok('解析 host:port', t && t.host === '127.0.0.1' && t.port === 8080, t && `${t.host}:${t.port}`);
  ok('只有 host:port 时不改协议', t && t.scheme === '');

  const u = parseTo('http://127.0.0.1:8080/api');
  ok('解析完整 URL', u && u.host === '127.0.0.1' && u.port === 8080 && u.scheme === 'http' && u.prefix === '/api',
    u && `${u.scheme}://${u.host}:${u.port}${u.prefix}`);

  const s = parseTo('https://staging.example.com');
  ok('没写端口时交给协议默认值', s && s.port === 0 && s.scheme === 'https', s && `port=${s.port}`);
  ok('没写端口的显示标签不带端口', s && s.label === 'staging.example.com', s && s.label);

  const tail = parseTo('https://staging.example.com/base/');
  ok('末位斜杠被吃掉', tail && tail.prefix === '/base', tail && tail.prefix);

  ok('非法目标被拒', parseTo('') === null && parseTo('http://') === null);

  const f = splitFrom('api.example.com/v1');
  ok('拆 from 的域名与路径前缀', f && f.host === 'api.example.com' && f.prefix === '/v1', f && `${f.host}${f.prefix}`);
  ok('from 大小写不敏感', splitFrom('API.Example.COM').host === 'api.example.com');
  ok('空 from 被拒', splitFrom('  ') === null);
}

// ---------------------------------------------------------------- 单元：匹配与路径
{
  const hm = new HostMap({ enabled: true, rules: [{ from: 'a.com', to: '127.0.0.1:8080' }] });
  const hit = hm.match(new URL('https://a.com/x/y?q=1'));
  ok('命中后给出上游地址', !!hit);
  const ap = hm.apply(new URL('https://a.com/x/y?q=1'), hit);
  ok('路径原样照搬（两边都没前缀）', ap.path === '/x/y?q=1', ap.path);
  ok('协议沿用原 URL', ap.scheme === 'https', ap.scheme);
  ok('端口用映射目标给的', ap.port === 8080, String(ap.port));

  ok('没命中的域名返回 null', hm.match(new URL('https://b.com/')) === null);

  hm.setState({ rules: [{ from: 'a.com', to: '127.0.0.1:8080' }], enabled: false });
  ok('关开关后不再命中', hm.match(new URL('https://a.com/')) === null);

  // 通配
  hm.setState({ enabled: true, rules: [{ from: '*.example.com', to: '127.0.0.1:9000' }] });
  ok('通配命中子域', !!hm.match(new URL('https://api.example.com/')));
  ok('通配不命中裸域', hm.match(new URL('https://example.com/')) === null);

  // 路径前缀
  hm.setState({ enabled: true, rules: [{ from: 'a.com/api', to: 'http://127.0.0.1:9000/v2' }] });
  ok('路径前缀匹配', !!hm.match(new URL('https://a.com/api/user')));
  ok('路径前缀不匹配别的前缀', hm.match(new URL('https://a.com/web/user')) === null);
  const ap2 = hm.apply(new URL('https://a.com/api/user/1?x=2'));
  ok('两侧都有前缀：替换', ap2.path === '/v2/user/1?x=2', ap2.path);

  hm.setState({ enabled: true, rules: [{ from: 'a.com/api', to: '127.0.0.1:9000' }] });
  const ap3 = hm.apply(new URL('https://a.com/api/user/1'));
  ok('只有 from 有前缀：去掉它', ap3.path === '/user/1', ap3.path);

  hm.setState({ enabled: true, rules: [{ from: 'a.com', to: 'http://127.0.0.1:9000/api' }] });
  const ap4 = hm.apply(new URL('https://a.com/user/1'));
  ok('只有 to 有前缀：拼上去', ap4.path === '/api/user/1', ap4.path);

  // 顺序 + 非法规则
  hm.setState({
    enabled: true,
    rules: [
      { from: 'a.com/vip', to: '127.0.0.1:1111' },
      { from: 'a.com', to: '127.0.0.1:2222' },
      { from: '', to: '127.0.0.1:3333' },
    ],
  });
  const first = hm.apply(new URL('https://a.com/vip/x'));
  ok('按顺序取第一条命中', first.port === 1111, String(first.port));
  const second = hm.apply(new URL('https://a.com/normal'));
  ok('前面不命中时落到后面的规则', second.port === 2222, String(second.port));
  ok('空 from 的规则被丢掉', hm.state().rules.length === 2, `${hm.state().rules.length} 条`);
}

// ---------------------------------------------------------------- 端到端
let UP = 0;
let seen = [];

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      seen.push({ path: req.url, host: req.headers.host });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
    });
    srv.listen(0, '127.0.0.1', () => {
      UP = srv.address().port;
      resolve(srv);
    });
  });
}

/** 经代理发一条请求；host 是客户端以为自己在访问的域名 */
function via(url, host) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method: 'GET', path: url, headers: { host }, timeout: 8000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const srv = await startUpstream();
  try {
    // 清掉历史规则，保证从干净状态开始
    await put([], false);

    // ① 基本映射：假域名 → 本地上游
    await put([{ from: 'mapped.ireqtest', to: `127.0.0.1:${UP}` }], true);
    seen = [];
    const r1 = await via('http://mapped.ireqtest/hello?a=1', 'mapped.ireqtest');
    ok('映射后请求真的到了上游', r1.status === 200, String(r1.status));
    ok('上游收到的路径正确', r1.status === 200 && JSON.parse(r1.body).path === '/hello?a=1', r1.body);
    ok('Host 头仍是原域名', r1.status === 200 && JSON.parse(r1.body).host === 'mapped.ireqtest',
      r1.status === 200 ? JSON.parse(r1.body).host : '');

    // ② 记录里能看出这是被映射过的
    const page = (await jsonApi('/api/flows/page?limit=20')).body;
    const flow = (page.flows || []).find((f) => String(f.url).includes('mapped.ireqtest/hello'));
    ok('列表里保留原 URL', !!flow, flow && flow.url);
    ok('记录上带映射目标', flow && flow.mapped === `127.0.0.1:${UP}`, flow && flow.mapped);

    // ③ 路径前缀替换
    await put([{ from: 'mapped.ireqtest/api', to: `http://127.0.0.1:${UP}/v2` }], true);
    const r2 = await via('http://mapped.ireqtest/api/user/1', 'mapped.ireqtest');
    ok('前缀替换后路径变成 /v2/user/1',
      r2.status === 200 && JSON.parse(r2.body).path === '/v2/user/1',
      r2.status === 200 ? JSON.parse(r2.body).path : String(r2.status));

    // ④ 关掉开关：不再映射，域名解析不到 → 请求失败
    await put([{ from: 'mapped.ireqtest', to: `127.0.0.1:${UP}` }], false);
    const r3 = await via('http://mapped.ireqtest/off', 'mapped.ireqtest');
    ok('关掉开关后不再走映射', r3.status !== 200, `${r3.status || ''} ${r3.error || ''}`);

    // ⑤ 配置能读回来
    await put([{ from: 'mapped.ireqtest', to: `127.0.0.1:${UP}` }], true);
    const st = (await jsonApi('/api/hostmap')).body;
    ok('GET 读回开关与规则', st.enabled === true && st.rules.length === 1, `${st.enabled} / ${st.rules.length}`);
    ok('读回来的规则字段完整', st.rules[0] && st.rules[0].from === 'mapped.ireqtest' && st.rules[0].to === `127.0.0.1:${UP}`,
      st.rules[0] && `${st.rules[0].from} → ${st.rules[0].to}`);
  } finally {
    await put([], false);
    srv.close();
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})();
