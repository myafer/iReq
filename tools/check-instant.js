'use strict';

/**
 * 自检：请求「发起即见」+ 清空「列表与侧栏同帧消失」。
 *
 * 回归点：
 *  1. 后端：请求一进代理就有 status=0 / pending=true 的占位记录，facets 立即聚合出
 *     设备 / 应用 / 域名 / 接口；响应回来后复用同一 id 就地补完，不新增行；
 *     导出跳过未完成的占位记录；清空后在途请求收尾不会把记录「复活」。
 *  2. UI：占位行在请求进行中可见（pending 呼吸态 + 状态列「…」），侧栏同步出现分组；
 *     完成后行就地变成真实状态码，选中的详情自动刷新。
 *  3. 清空：点击的同一个同步调用栈里，列表 / 设备 / 应用 / 域名 / 接口分组全部归零；
 *     在途的 facets 响应不能把旧分组回填回来；控制坞的清空按钮行为一致。
 *
 * 不修改系统代理、不动真实 data/，可在服务运行时安全执行。
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');

const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

/** 经代理发一个 HTTP 请求（不等待响应结束，便于观察进行中状态） */
function proxyGet(url) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: url, headers: { host: new URL(url).host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitUi() {
  for (let i = 0; i < 40; i++) {
    try {
      await api('/api/status');
      return true;
    } catch (_) {
      await sleep(500);
    }
  }
  return false;
}

/** 侧栏四组 + 列表行数的快照，清空测试要在同一个 evaluate 里同步取 */
const SNAPSHOT = () => ({
  rows: document.querySelectorAll('#list .row').length,
  apps: document.querySelectorAll('[data-group="apps"] .sitem').length,
  devices: document.querySelectorAll('[data-group="devices"] .sitem').length,
  hosts: document.querySelectorAll('[data-group="hosts"] .sitem').length,
  routes: document.querySelectorAll('[data-group="routes"] .sitem, [data-group="routes"] .rtree-item').length,
  count: (document.querySelector('#count') || {}).textContent || '',
});

(async () => {
  push('隔离服务可达', await waitUi());
  await api('/api/flows', { method: 'DELETE' });
  await api('/api/diagnostics', { method: 'DELETE' }).catch(() => {});

  // 上游：/slow 故意拖 1000ms，/fast 立即返回
  const up = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":1}');
    };
    if (req.url.startsWith('/slow')) setTimeout(reply, 1000);
    else reply();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const slowUrl = base + '/slow';
  const fastUrl = base + '/fast';

  let browser;
  try {
    /* ---------------- A. 后端：发起即入库 ---------------- */
    const p1 = proxyGet(slowUrl);
    await sleep(150);
    const during = await api('/api/flows?limit=10');
    push('请求发起后立刻有一条记录', during.length === 1);
    push('记录标记为进行中', during[0] && during[0].pending === true && during[0].status === 0);
    push(
      '进行中记录带完整可聚合字段',
      during[0] && !!during[0].url && !!during[0].host && !!during[0].method && !!during[0].app && !!during[0].route
    );
    const fac1 = await api('/api/facets');
    push('facets 立刻聚合出应用', fac1.apps.length > 0);
    push('facets 立刻聚合出设备', fac1.devices.length > 0);
    push('facets 立刻聚合出域名', fac1.hosts.length > 0);
    push('facets 立刻聚合出接口结构', fac1.routes.length > 0);

    const code1 = await p1;
    await sleep(150);
    const after = await api('/api/flows?limit=10');
    push('慢请求正常完成', code1 === 200);
    push('完成后状态 / pending 就地回填', after[0] && after[0].status === 200 && after[0].pending === false);
    push('完成不新增第二行且 id 不变', after.length === 1 && after[0].id === during[0].id);
    push('完成后耗时已记录', after[0] && after[0].duration > 500);

    /* ---------------- B. 导出不含占位记录 ---------------- */
    const p2 = proxyGet(slowUrl);
    await sleep(150);
    const exported = await (await fetch(UI + '/api/export/json')).json();
    push('导出跳过未完成的占位记录', Array.isArray(exported) && !exported.some((f) => f.pending));
    await p2;
    await sleep(120);

    /* ---------------- C. 清空后在途请求不复活 ---------------- */
    const p3 = proxyGet(slowUrl);
    await sleep(150);
    await api('/api/flows', { method: 'DELETE' });
    await p3;
    await sleep(200);
    push('清空后在途请求收尾不复活', (await api('/api/flows?limit=10')).length === 0);

    /* ---------------- D. UI：进行中可见 ---------------- */
    browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await api('/api/flows', { method: 'DELETE' });
    await page.waitForTimeout(250);

    const uiPending = proxyGet(slowUrl);
    await page.waitForTimeout(320); // SSE + facets 80ms 节流
    const live = await page.evaluate(() => ({
      rows: document.querySelectorAll('#list .row').length,
      apps: document.querySelectorAll('[data-group="apps"] .sitem').length,
      devices: document.querySelectorAll('[data-group="devices"] .sitem').length,
      hosts: document.querySelectorAll('[data-group="hosts"] .sitem').length,
      cls: (document.querySelector('#list .row') || {}).className || '',
      st: (document.querySelector('#list .row .st') || {}).textContent || '',
      path: (document.querySelector('#list .row .cellurl .p') || {}).textContent || '',
    }));
    push('UI 进行中行已出现', live.rows === 1);
    push('UI 行带 pending 态', live.cls.includes('pending'));
    push('UI 状态列显示 …', live.st.trim() === '…');
    push('UI 进行中路径正确', live.path.includes('/slow'));
    push('UI 侧栏应用同步出现', live.apps >= 1);
    push('UI 侧栏设备同步出现', live.devices >= 1);
    push('UI 侧栏域名同步出现', live.hosts >= 1);

    await page.click('#list .row'); // 进行中就看详情
    await uiPending;
    await page.waitForTimeout(400);
    const done = await page.evaluate(() => ({
      rows: document.querySelectorAll('#list .row').length,
      cls: (document.querySelector('#list .row') || {}).className || '',
      st: (document.querySelector('#list .row .st') || {}).textContent || '',
      detail: (document.querySelector('#detail') || {}).textContent || '',
    }));
    push('完成后 pending 态消失', done.rows === 1 && !done.cls.includes('pending'));
    push('完成后状态就地显示 200', done.st.trim() === '200');
    push('完成不新增行', done.rows === 1);
    push('详情随响应自动刷新', done.detail.includes('200'));

    /* ---------------- E. 清空：同帧同步消失 ---------------- */
    await proxyGet(fastUrl);
    await proxyGet(fastUrl);
    await page.waitForTimeout(300);
    const before = await page.evaluate(SNAPSHOT);
    push('清空前列表非空', before.rows >= 3);
    push('清空前侧栏有分组条目', before.apps >= 1 && before.devices >= 1);

    // 关键：click 与读数在同一个同步调用栈里，不给任何 await / rAF / 定时器机会
    const instant = await page.evaluate(() => {
      document.querySelector('#btnClear').click();
      return {
        rows: document.querySelectorAll('#list .row').length,
        apps: document.querySelectorAll('[data-group="apps"] .sitem').length,
        devices: document.querySelectorAll('[data-group="devices"] .sitem').length,
        hosts: document.querySelectorAll('[data-group="hosts"] .sitem').length,
        count: (document.querySelector('#count') || {}).textContent || '',
      };
    });
    push('清空同帧列表归零', instant.rows === 0);
    push('清空同帧应用分组归零', instant.apps === 0);
    push('清空同帧设备分组归零', instant.devices === 0);
    push('清空同帧域名分组归零', instant.hosts === 0);
    push('清空同帧计数归零', instant.count.trim() === '0 条');

    await page.waitForTimeout(600);
    const later = await page.evaluate(SNAPSHOT);
    push('在途 facets 响应不回填旧分组', later.apps === 0 && later.devices === 0 && later.hosts === 0);
    push('服务端流量已清空', (await api('/api/flows?limit=10')).length === 0);

    /* ---------------- F. 控制坞清空按钮 ---------------- */
    await proxyGet(fastUrl);
    await page.waitForTimeout(300);
    const dock = await page.evaluate(() => {
      document.querySelector('#dockClear').click();
      return {
        rows: document.querySelectorAll('#list .row').length,
        apps: document.querySelectorAll('[data-group="apps"] .sitem').length,
        devices: document.querySelectorAll('[data-group="devices"] .sitem').length,
      };
    });
    push('控制坞清空同样即时', dock.rows === 0 && dock.apps === 0 && dock.devices === 0);

    push('页面无 JS 报错', errs.length === 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
    up.close();
    await api('/api/flows', { method: 'DELETE' }).catch(() => {});
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
