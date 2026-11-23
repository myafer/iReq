'use strict';
const { UI_PORT, PROXY_PORT, UI } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const { SystemProxy } = require('../src/system-proxy');
const path = require('path');

/**
 * 抓包范围（只抓指定域名）验收：
 *   1. /proxy.pac 只把列表里的域名指向代理端口，其余 DIRECT，localhost 永远 DIRECT
 *   2. 列表为空时 PAC 里没有任何 PROXY 规则（等价于全部直连 → 服务端会退回 all 模式）
 *   3. 「只抓」模式接管后：系统走 PAC、HTTP/HTTPS 代理关闭、状态识别为 ours
 *   4. 释放后：PAC 关闭、原有代理原样回来（跑完必须不残留）
 *
 * 前提：reqLite 服务已在 9093/9094 运行。会短暂改 macOS 系统代理，结束前还原。
 */
const checks = [];
const ok = (name, pass, extra) => {
  checks.push([name, !!pass, extra]);
};

const api = async (p, opts = {}) => {
  const r = await fetch(UI + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const sp = new SystemProxy({ proxyPort: PROXY_PORT, dataDir: path.join(__dirname, '..', 'data') });
const svc = sp.primaryService();
const original = sp.snapshot(svc);

(async () => {
  try {
    /* ---------------- PAC 内容 ---------------- */
    await api('/api/config', {
      method: 'PUT',
      body: { captureScope: { mode: 'list', domains: ['api.demo.example', '*.inner.test'] } },
    });
    const pac = await fetch(UI + '/proxy.pac').then((r) => r.text());
    ok('PAC 有 FindProxyForURL', /function FindProxyForURL\(url, host\)/.test(pac));
    ok('PAC 命中列表里的域名', /host === "api\.demo\.example"/.test(pac) && /\.inner\.test/.test(pac), pac.split('\n')[3] || '');
    ok('PAC 用本次代理端口', new RegExp(`PROXY 127\\.0\\.0\\.1:${PROXY_PORT}`).test(pac));
    ok('PAC 其余流量 DIRECT', /return "DIRECT";/.test(pac));
    ok('PAC 本机永远 DIRECT', /host === "localhost"[^\n]*DIRECT/.test(pac));

    await api('/api/config', { method: 'PUT', body: { captureScope: { mode: 'list', domains: [] } } });
    const empty = await fetch(UI + '/proxy.pac').then((r) => r.text());
    ok('列表为空时 PAC 不会指向我们', !/PROXY 127\.0\.0\.1/.test(empty));
    const st0 = await api('/api/system-proxy');
    ok('列表为空时状态退回 all', st0.body.captureScope && st0.body.captureScope.mode === 'all', JSON.stringify(st0.body.captureScope));

    /* ---------------- 只抓模式接管 ---------------- */
    await api('/api/config', {
      method: 'PUT',
      body: { captureScope: { mode: 'list', domains: ['api.demo.example'] } },
    });
    const on = await api('/api/system-proxy', { method: 'POST', body: { enabled: true } });
    const afterOn = sp.snapshot(svc);
    ok('接管成功', on.status === 200 && on.body.ok !== false, String(on.status));
    ok('系统改成走 PAC', afterOn.auto.enabled === true && afterOn.auto.url.endsWith('/proxy.pac'), JSON.stringify(afterOn.auto));
    ok('HTTP/HTTPS 代理被关掉（流量交给 PAC）', afterOn.web.enabled === false && afterOn.secure.enabled === false);
    ok('状态识别为「我们在接管」', on.body.ours === true && on.body.mode === 'list', JSON.stringify({ ours: on.body.ours, mode: on.body.mode }));

    /* ---------------- 释放 ---------------- */
    const off = await api('/api/system-proxy', { method: 'POST', body: { enabled: false } });
    const afterOff = sp.snapshot(svc);
    console.log('释放后:', JSON.stringify({ web: afterOff.web, auto: afterOff.auto }));
    ok('释放后 PAC 关闭', afterOff.auto.enabled === false);
    ok('释放后 HTTP 代理回到原值', afterOff.web.port === original.web.port && afterOff.web.enabled === original.web.enabled);
    ok('释放后状态不再是我们', off.body.ours === false);

    /* ---------------- 界面 ---------------- */
    const browser = await chromium.launch({ executablePath: EXEC });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelector('#btnSettings').click());
      await page.waitForTimeout(700);
      const ui = await page.evaluate(() => ({
        hasAll: !!document.querySelector('#stScopeAll'),
        hasList: !!document.querySelector('#stScopeList'),
        checked: document.querySelector('#stScopeList')?.checked === true,
        domains: (document.querySelector('#stScopeDomains') || {}).value || '',
      }));
      ok('设置里有「抓全部 / 只抓这些」两个选项', ui.hasAll && ui.hasList);
      ok('回填成当前模式（只抓）与域名', ui.checked && ui.domains.includes('api.demo.example'), JSON.stringify(ui));
      ok('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
    } finally {
      await browser.close();
    }
  } finally {
    // 收拾：抓包范围恢复默认，系统代理回到跑之前的样子
    await api('/api/config', { method: 'PUT', body: { captureScope: { mode: 'all', domains: [] } } }).catch(() => {});
    const now = sp.snapshot(svc);
    if (JSON.stringify(now) !== JSON.stringify(original)) sp.restore(original, svc);
    await new Promise((r) => setTimeout(r, 300));
    const final = sp.snapshot(svc);
    ok('★ 系统代理完整还原', JSON.stringify(final) === JSON.stringify(original) || final.auto.enabled === false);
  }

  console.log('\n--- 结果 ---');
  for (const [name, pass, extra] of checks) console.log(`${pass ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  const fails = checks.filter(([, p]) => !p).length;
  console.log(`\n共 ${checks.length} 项，通过 ${checks.length - fails} 项`);
  if (fails) process.exitCode = 1;
})();
