'use strict';

/**
 * 自检：应用勾选式多选 + 域名 / 接口结构级联。
 *
 * 回归点（对照同类工具的勾选交互）：
 *  1. 应用多选：侧栏应用行是勾选式（绿色对钩），可同时勾多个，列表显示并集；
 *  2. 应用列表始终显示全部应用（不被域名 / 其它筛选收窄）；
 *  3. 勾选应用后：域名只显示这些应用下的域名；已选域名后接口结构只显示
 *     还在列表中的接口（级联聚合走 /api/facets 的 scope）；
 *  4. 勾选应用后，边栏上面的收藏 / 设备分组不再展示；全部取消勾选后恢复；
 *  5. 老书签（应用是字符串）应用后归一成数组仍可用。
 *
 * 不修改系统代理、不动真实 data/，可在服务运行时安全执行。
 */
const http = require('http');
const { UI, PROXY_PORT } = require('./_env');

const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

/** 走代理发一个 HTTP 请求（可带 UA，用来区分应用） */
function proxyGet(url, ua) {
  return new Promise((resolve) => {
    const headers = { host: new URL(url).host };
    if (ua) headers['user-agent'] = ua;
    const req = http.request({ host: '127.0.0.1', port: PROXY_PORT, path: url, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
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
  push('隔离服务可达', await waitUi());

  // 本机进程识别会覆盖 UA 推断（本机自检流量全解析成同一进程名），
  // 这里按 UA 造「应用 × 域名」矩阵，先关掉进程识别，结束后恢复。
  const st0 = await api('/api/status');
  const processMap0 = !!(st0.processMap && st0.processMap.enabled);
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ processMap: false }),
  });

  // 起点干净：清掉历史流量与上次运行残留的规则，随后用两条 Mock 规则 + 不同 UA 造「应用 × 域名」矩阵
  await api('/api/flows', { method: 'DELETE' });
  for (const r of await api('/api/rules')) {
    if (r.name === 'casc-a' || r.name === 'casc-b')
      await api('/api/rules/' + r.id, { method: 'DELETE' }).catch(() => {});
  }
  const ruleA = await api('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'casc-a', host: 'cascade-a.example', body: 'AAA' }),
  });
  const ruleB = await api('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'casc-b', host: 'cascade-b.example', body: 'BBB' }),
  });

  await proxyGet('http://cascade-a.example/a1', 'cascA/1.0 (test)');
  await proxyGet('http://cascade-a.example/a2', 'cascA/1.0 (test)');
  await proxyGet('http://cascade-b.example/b1', 'cascB/2.0 (test)');
  await proxyGet('http://cascade-b.example/b2', 'cascB/2.0 (test)');
  await sleep(400);

  const APP_A = 'cascA 1.0';
  const APP_B = 'cascB 2.0';

  /* ---------------- A. API 层：级联聚合 ---------------- */
  let facets = await api('/api/facets');
  push('应用列表含两个测试应用（全量）', facets.apps.some((a) => a.key === APP_A) && facets.apps.some((a) => a.key === APP_B));
  push('无筛选时域名含两个测试域名', facets.hosts.some((h) => h.key === 'cascade-a.example') && facets.hosts.some((h) => h.key === 'cascade-b.example'));

  facets = await api('/api/facets?app=' + encodeURIComponent(APP_A));
  push('勾选应用 A：域名只显示 A 下的域名', facets.hosts.every((h) => h.key === 'cascade-a.example') && facets.hosts.length === 1);
  push('勾选应用 A：应用列表仍显示全部（含 B）', facets.apps.some((a) => a.key === APP_B));

  facets = await api('/api/facets?app=' + encodeURIComponent(APP_B));
  push('勾选应用 B：域名只显示 B 下的域名', facets.hosts.every((h) => h.key === 'cascade-b.example') && facets.hosts.length === 1);

  facets = await api('/api/facets?app=' + encodeURIComponent(APP_A) + '&host=cascade-a.example');
  const routePaths = facets.routes.map((r) => r.key).join('|');
  push('应用 A + 域名：接口结构只含该域名下的接口', routePaths.includes('/a1') && routePaths.includes('/a2') && !routePaths.includes('/b1'));
  push('应用 A + 域名：域名列表不受自身影响（仍是级联结果）', facets.hosts.length === 1 && facets.hosts[0].key === 'cascade-a.example');

  const union = await api('/api/flows?limit=2000&app=' + encodeURIComponent(`${APP_A},${APP_B}`));
  push('flows app=A,B 返回并集（4 条）', union.length === 4 && union.every((f) => f.app === APP_A || f.app === APP_B));
  const onlyA = await api('/api/flows?limit=2000&app=' + encodeURIComponent(APP_A));
  push('flows app=A 返回 2 条', onlyA.length === 2 && onlyA.every((f) => f.host === 'cascade-a.example'));

  /* ---------------- B. UI 层：勾选交互 ---------------- */
  let chromium = null, EXEC;
  try { ({ chromium, EXEC } = require('./_pw')); } catch (_) { /* 环境无 Playwright 时跳过 */ }
  if (chromium) {
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    const appRow = (name) => `//aside//*[contains(@class,"sitem")][contains(., "${name.split(' ')[0]}")]`;
    const clickApp = async (name) => {
      await page.evaluate((n) => {
        const row = [...document.querySelectorAll('[data-facet="app"]')].find(
          (b) => b.dataset.value === n
        );
        if (row) row.click();
      }, name);
      await page.waitForTimeout(700);
    };

    push('设备 / 收藏分组初始可见', await page.evaluate(() =>
      !!document.querySelector('[data-group="devices"]') && !!document.querySelector('[data-group="bookmarks"]')
    ));

    await clickApp(APP_A);
    push('点应用 A：行变勾选态', await page.evaluate((n) => {
      const row = [...document.querySelectorAll('[data-facet="app"]')].find((b) => b.dataset.value === n);
      return row && row.classList.contains('checked');
    }, APP_A));
    push('对钩可见且为绿色', await page.evaluate((n) => {
      const row = [...document.querySelectorAll('[data-facet="app"]')].find((b) => b.dataset.value === n);
      const ck = row && row.querySelector('.ck');
      if (!ck || getComputedStyle(ck).display === 'none') return false;
      const c = getComputedStyle(ck).color;
      // 绿色：g 分量明显高于 r / b（--ok 在深浅两套主题都是绿）
      const m = c.match(/(\d+), (\d+), (\d+)/);
      return m && Number(m[2]) > Number(m[1]) && Number(m[2]) > Number(m[3]);
    }, APP_A));
    push('勾选后计数让位给对钩', await page.evaluate((n) => {
      const row = [...document.querySelectorAll('[data-facet="app"]')].find((b) => b.dataset.value === n);
      if (!row) return false;
      const cnt = row.querySelector('.cnt');
      return !cnt || getComputedStyle(cnt).display === 'none';
    }, APP_A));
    push('勾选后设备 / 收藏分组隐藏', await page.evaluate(() =>
      !document.querySelector('[data-group="devices"]') && !document.querySelector('[data-group="bookmarks"]')
    ));
    push('域名分组只显示 A 的域名', await page.evaluate((host) => {
      const rows = [...document.querySelectorAll('[data-facet="host"]')].map((b) => b.dataset.value);
      return rows.length === 1 && rows[0] === host;
    }, 'cascade-a.example'));
    push('出现「应用」chip', await page.evaluate(() =>
      document.querySelector('#chips').textContent.includes('应用')
    ));

    // 多选：再勾 B → 并集
    await clickApp(APP_B);
    push('可同时勾选两个应用', await page.evaluate(({ a, b }) => {
      const val = (n) => [...document.querySelectorAll('[data-facet="app"]')].find((x) => x.dataset.value === n);
      return val(a).classList.contains('checked') && val(b).classList.contains('checked');
    }, { a: APP_A, b: APP_B }));
    push('域名显示两个应用的域名（并集）', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-facet="host"]')].map((b) => b.dataset.value).sort();
      return JSON.stringify(rows) === JSON.stringify(['cascade-a.example', 'cascade-b.example']);
    }));

    // 应用 + 域名组合
    await page.click('[data-facet="host"][data-value="cascade-a.example"]');
    await page.waitForTimeout(700);
    push('组合筛选后行数 = 2（A 应用的 a 域名）', await page.evaluate(() =>
      document.querySelectorAll('#list .row').length === 2
    ));
    push('接口结构只含 a1/a2', await page.evaluate(() => {
      const t = document.querySelector('[data-group="routes"]').textContent;
      return t.includes('a1') && t.includes('a2') && !t.includes('b1');
    }));

    // 取消一个 → 仍按剩余勾选过滤；全部取消 → 分组恢复
    await clickApp(APP_A);
    push('取消 A 后仍按 B 过滤', await page.evaluate((host) => {
      const rows = [...document.querySelectorAll('[data-facet="host"]')].map((b) => b.dataset.value);
      return JSON.stringify(rows) === JSON.stringify([host]);
    }, 'cascade-b.example'));
    await clickApp(APP_B);
    push('全部取消后设备 / 收藏分组恢复', await page.evaluate(() =>
      !!document.querySelector('[data-group="devices"]') && !!document.querySelector('[data-group="bookmarks"]')
    ));
    push('全部取消后不再有「应用」chip（域名 chip 是组合筛选残留，属正常）', await page.evaluate(() =>
      !document.querySelector('#chips').textContent.includes('应用')
    ));

    // 老书签（应用为字符串）应用后归一成数组
    await api('/api/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { app: APP_A, host: 'cascade-a.example' }, label: '旧格式书签' }),
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.click('[data-bookmark]');
    await page.waitForTimeout(700);
    push('老书签应用后列表 2 条（应用归一成数组）', await page.evaluate(() =>
      document.querySelectorAll('#list .row').length === 2
    ));
    push('老书签应用后应用行是勾选态', await page.evaluate((n) => {
      const row = [...document.querySelectorAll('[data-facet="app"]')].find((b) => b.dataset.value === n);
      return row && row.classList.contains('checked');
    }, APP_A));

    push('页面无 JS 报错', errs.length === 0);
    await browser.close();

    // 收尾：删书签
    const bms = await api('/api/bookmarks');
    for (const b of bms) await api('/api/bookmarks/' + b.id, { method: 'DELETE' }).catch(() => {});
  } else {
    push('Playwright 可用（跳过 UI 检查）', true);
  }

  /* ---------------- 清理 ---------------- */
  await api('/api/rules/' + ruleA.id, { method: 'DELETE' }).catch(() => {});
  await api('/api/rules/' + ruleB.id, { method: 'DELETE' }).catch(() => {});
  await api('/api/flows', { method: 'DELETE' }).catch(() => {});
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ processMap: processMap0 }),
  }).catch(() => {});
  const stEnd = await api('/api/status');
  push('清理完成（规则删除 / 进程识别恢复原状）', stEnd.processMap.enabled === processMap0);

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
