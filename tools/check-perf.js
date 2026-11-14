'use strict';

/**
 * 自检：性能视图聚合
 * ---------------------------------------------------------------------------
 * ① 百分位：nearest-rank，样本少时给真实存在的值，不插值
 * ② 分组：按接口 / 按域名两种口径，进行中的请求不计入统计
 * ③ 错误率：连不上 + 5xx 才算错误；4xx 单独计数，不能和服务端挂了混为一谈
 * ④ 排序：P95 降序、同 P95 按请求数降序（「慢且高频」先暴露）
 * ⑤ 边界：缺 duration 的样本不进百分位、limit 截断要报出省略了多少
 * ⑥ 最慢请求：降序、条数受控
 * ⑦ 接口：/api/perf 的 by / 筛选条件都要真的影响结果
 *
 * 会造流量，结束时清空流量并删掉自己生成的历史记录。
 */
const http = require('http');
const { aggregate, percentile } = require('../src/perf');
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

/* ---------------------------------------------------------------- ① 百分位 */
{
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
  ok('P50 = 50', percentile(oneToHundred, 50) === 50, percentile(oneToHundred, 50));
  ok('P95 = 95', percentile(oneToHundred, 95) === 95, percentile(oneToHundred, 95));
  ok('单样本时 P95 = 该样本', percentile([7], 95) === 7);
  ok('10 个样本时 P95 取第 10 个', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10,
    percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95));
  ok('空样本返回 null', percentile([], 50) === null);
  ok('P95 不低于 P50', percentile(oneToHundred, 95) >= percentile(oneToHundred, 50));
}

/* ---------------------------------------------------------------- ②-⑥ 聚合 */
function flow(over) {
  return {
    id: over.id,
    ts: over.ts || 1000,
    method: 'GET',
    route: 'GET /a',
    host: 'api.example.com',
    status: 200,
    duration: 10,
    resSize: 10,
    path: '/a',
    ...over,
  };
}

const sample = [
  flow({ id: 'a1', duration: 10 }),
  flow({ id: 'a2', duration: 20 }),
  flow({ id: 'a3', duration: 30 }),
  flow({ id: 'a4', duration: 40 }),
  flow({ id: 'a5', duration: 50 }),
  flow({ id: 'b1', route: 'GET /b', host: 'slow.example.com', duration: 100 }),
  flow({ id: 'b2', route: 'GET /b', host: 'slow.example.com', duration: 200, status: 500 }),
  flow({ id: 'c1', route: 'GET /c', host: 'api.example.com', duration: 5, status: 404 }),
  // 进行中的请求没有 duration：不该进统计，只计 pending
  flow({ id: 'p1', route: 'GET /p', duration: 999, pending: true }),
];
{
  const r = aggregate(sample, { by: 'route' });
  const a = r.groups.find((g) => g.key === 'GET /a');
  const b = r.groups.find((g) => g.key === 'GET /b');
  const c = r.groups.find((g) => g.key === 'GET /c');
  ok('接口分组数正确（进行中的不建组）', r.groups.length === 3, r.groups.length);
  ok('A 的请求数 / P50 / P95 / 平均 / 最大',
    a.count === 5 && a.p50 === 30 && a.p95 === 50 && a.avg === 30 && a.max === 50,
    JSON.stringify([a.count, a.p50, a.p95, a.avg, a.max]));
  ok('A 没有错误', a.errorRate === 0);
  ok('A 传输量累加', a.bytes === 50, a.bytes);
  ok('B 的 500 计入错误率 50%', b.errorRate === 50, b.errorRate);
  ok('B 的 serverErrors = 1', b.serverErrors === 1);
  ok('4xx 不算错误，但单独计数', c.errorRate === 0 && c.clientErrors === 1,
    `${c.errorRate} / ${c.clientErrors}`);
  ok('排序：P95 最高的排最前', r.groups[0].key === 'GET /b', r.groups[0].key);
  ok('总计只算已完成的 8 条', r.totals.count === 8, r.totals.count);
  ok('总计报出进行中的条数', r.totals.pending === 1, r.totals.pending);
  ok('总计错误率 = 1/8（只有那个 500）', r.totals.errorRate === 12.5, r.totals.errorRate);

  const byHost = aggregate(sample, { by: 'host' });
  ok('按域名分组取 host 作 key', byHost.groups.every((g) => g.key.includes('example.com')), byHost.groups.map((g) => g.key).join(','));
  ok('按域名分组后条数仍是 8', byHost.totals.count === 8);
  ok('域名口径下 api.example.com 有 6 条',
    byHost.groups.find((g) => g.key === 'api.example.com').count === 6);

  ok('最慢请求降序', r.slowest[0].id === 'b2' && r.slowest[0].duration === 200, r.slowest[0].id);
  ok('最慢请求默认给 8 条以内', r.slowest.length <= 8, r.slowest.length);

  const cut = aggregate(sample, { limit: 2 });
  ok('limit 生效', cut.groups.length === 2, cut.groups.length);
  ok('截断数量报出来', cut.truncated === 1, cut.truncated);

  // 缺 duration 的样本：参与计数与错误率，但不进百分位
  const noDur = aggregate([
    flow({ id: 'x1', duration: undefined }),
    flow({ id: 'x2', duration: 40 }),
  ]);
  const g = noDur.groups[0];
  ok('缺 duration 的样本仍计入请求数', g.count === 2, g.count);
  ok('缺 duration 的样本不进 P95', g.p95 === 40, g.p95);

  const empty = aggregate([]);
  ok('空输入不炸', empty.groups.length === 0 && empty.totals.count === 0);
  ok('空输入没有最慢请求', empty.slowest.length === 0);
}

/* ---------------------------------------------------------------- ⑦ HTTP 接口 */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const delay = /^\/slow/.test(req.url || '') ? 120 : 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, delay);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function viaProxy(upPort, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        method: 'GET',
        path: `http://127.0.0.1:${upPort}${path}`,
        headers: { host: `127.0.0.1:${upPort}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const before = await historyIds();
  const srv = await startUpstream();
  const upPort = srv.address().port;
  await viaProxy(upPort, '/slow');
  await viaProxy(upPort, '/fast');
  await viaProxy(upPort, '/fast2');
  await new Promise((r) => setTimeout(r, 150));

  const all = await jsonApi('/api/perf');
  ok('接口返回 by=route', all.status === 200 && all.body.by === 'route', all.status);
  ok('返回分组与总计', Array.isArray(all.body.groups) && !!all.body.totals);
  const slowGroup = all.body.groups.find((g) => g.key === 'GET /slow');
  ok('慢接口出现在聚合里', !!slowGroup, all.body.groups.map((g) => g.key).join(','));
  ok('慢接口的 P95 ≥ 上游延迟', !!slowGroup && slowGroup.p95 >= 100, slowGroup && slowGroup.p95);
  ok('带上内存总条数', typeof all.body.inMemory === 'number' && all.body.inMemory > 0, all.body.inMemory);

  const hostMode = await jsonApi('/api/perf?by=host');
  ok('by=host 生效', hostMode.body.by === 'host');
  ok('按域名聚合出 127.0.0.1', (hostMode.body.groups || []).some((g) => g.key === '127.0.0.1'),
    (hostMode.body.groups || []).map((g) => g.key).join(','));

  const filtered = await jsonApi('/api/perf?route=' + encodeURIComponent('GET /slow'));
  ok('route 筛选后只剩一个接口', (filtered.body.groups || []).length === 1,
    (filtered.body.groups || []).map((g) => g.key).join(','));
  ok('筛选后的接口就是它', (filtered.body.groups || [])[0]?.key === 'GET /slow');

  const noHit = await jsonApi('/api/perf?q=' + encodeURIComponent('绝对不存在的关键字zzz'));
  ok('筛不到时不报错，给空结果', noHit.status === 200 && noHit.body.groups.length === 0 && noHit.body.totals.count === 0);

  /* ---------------- 清理 ---------------- */
  await jsonApi('/api/flows', { method: 'DELETE' });
  const after = await historyIds();
  for (const id of after) {
    if (!before.has(id)) await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
  }
  srv.close();

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})();
