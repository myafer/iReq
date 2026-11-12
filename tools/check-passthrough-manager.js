'use strict';

/**
 * 自检：跳过解密白名单的管理列表 + TLS 失败原因分类。
 *
 * 回归点（用户反馈：加进「跳过解密」的域名要能集中管理，且想知道
 * gsa-gpk.apple.com 这类系统域名为什么一直 TLS 失败）：
 *  1. 纯函数：规则归一化 / 失败原因分类 / 子域匹配。
 *  2. /api/passthrough：批量添加归一化去重、来源与时间、持久化、单条删除 / 清空、
 *     PUT /api/config 兼容、规则变更切断存量 MITM 连接、透传命中计数、SSE 广播。
 *  3. 诊断：底层报错分成 alpn / no-request 等，加入白名单后对应记录立即清除。
 *  4. UI：顶栏与设置页入口、列表、添加、搜索、编辑、删除、清空、诊断详情原因区、
 *     一键加入后自动打开管理列表、英文模式零中文残留。
 *
 * 只造本地 CONNECT / TLS 握手，不依赖外网；结束前恢复 passthrough 与诊断数据。
 * 会改配置并清诊断，所以在 check-all 里排在末尾段。
 */
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const {
  passthroughMatches,
  normalizePassthroughRule,
  classifyTlsFailure,
} = require('../src/proxy');

const HOST = 'gsa-gpk.apple.com';
const DIAG_A = 'pin.diag.test';
const DIAG_B = 'h2only.diag.test';
const KEEP_HOST = 'keep.mitm-probe.test';
let dataDir = '';

const checks = [];
const push = (name, ok, extra) => checks.push([name, Boolean(ok), extra || '']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(UI + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

async function waitUi() {
  for (let i = 0; i < 40; i++) {
    try {
      await api('/api/status');
      return true;
    } catch (_) {
      await sleep(400);
    }
  }
  return false;
}

/** 通过代理发 CONNECT，然后按指定 ALPN / 校验证书做一次握手（失败是预期结果） */
function handshake(host, { alpn = ['http/1.1'], verify = false } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(v);
    };
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    s.once('data', () => {
      s.removeAllListeners('data');
      const ts = tls.connect({ socket: s, servername: host, rejectUnauthorized: verify, ALPNProtocols: alpn });
      ts.on('error', () => finish('tls-error'));
      ts.on('secureConnect', () => finish('secure'));
      setTimeout(() => finish('timeout'), 2200);
    });
    s.on('error', () => finish('tcp-error'));
    s.on('close', () => finish('closed'));
    setTimeout(() => finish('timeout'), 2800);
  });
}

/** 握一次手并保持连接，用来验证「新加白名单会切断还在解密的存量连接」 */
function holdMitm(host) {
  return new Promise((resolve) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    s.once('data', () => {
      s.removeAllListeners('data');
      const ts = tls.connect({ socket: s, servername: host, rejectUnauthorized: false });
      ts.on('secureConnect', () => finish({ s, ts }));
      ts.on('error', () => finish(null));
    });
    s.on('error', () => finish(null));
    s.on('close', () => finish(null));
    setTimeout(() => finish(null), 3000);
  });
}

/** 只发 CONNECT 等 200：用来累计「因为白名单而透传」的命中数 */
function connectOnly(host) {
  return new Promise((resolve) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(v);
    };
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    s.once('data', () => finish('ok'));
    s.on('error', () => finish('error'));
    s.on('close', () => finish('closed'));
    setTimeout(() => finish('timeout'), 2500);
  });
}

(async () => {
  /* ------------------------------------------------------------ 纯函数 */
  push('规则归一化：协议 / 端口 / 路径 / 通配前缀', normalizePassthroughRule('https://*.GSa-GpK.Apple.com:443/foo') === HOST);
  push('规则归一化：空白与大小写', normalizePassthroughRule('  EXAMPLE.com ') === 'example.com');
  push('规则归一化：空值', normalizePassthroughRule('') === '' && normalizePassthroughRule(null) === '');
  push('原因分类：ALPN 只接受 h2', classifyTlsFailure(new Error('tls_handle_alpn:no application protocol')) === 'alpn');
  push('原因分类：证书不被信任', classifyTlsFailure(new Error('unable to verify the first certificate')) === 'untrusted');
  push('原因分类：握手没完成也没有请求', classifyTlsFailure(new Error('TLS 握手失败（客户端可能不信任证书，或不是 HTTP 协议）')) === 'no-request');
  push('原因分类：连接被重置', classifyTlsFailure(new Error('read ECONNRESET')) === 'reset');
  push('原因分类：非 HTTP 协议', classifyTlsFailure(new Error('wrong version number')) === 'non-http');
  push('子域匹配：自身 / 子域 / 不误伤', passthroughMatches('a.example.com', ['example.com']) && passthroughMatches('example.com', ['*.example.com']) && !passthroughMatches('notexample.com', ['example.com']));

  push('隔离服务可达', await waitUi());
  dataDir = (await api('/api/status')).dataDir || '';
  const saved = (await api('/api/config')).passthrough || [];
  let browser;
  try {
    await api('/api/passthrough', { method: 'DELETE' });
    await api('/api/diagnostics', { method: 'DELETE' });

    /* -------------------------------------------------------- API */
    const empty = await api('/api/passthrough');
    push('GET 初始为空', Array.isArray(empty.rules) && empty.rules.length === 0, JSON.stringify(empty.rules));

    const post = await api('/api/passthrough', {
      method: 'POST',
      body: { rules: ['*.Foo.Test:443/x', 'foo.test', '  ', HOST], source: 'diagnostic' },
    });
    const names = post.rules.map((r) => r.rule);
    push('POST 归一化并去重', names.length === 2 && names.includes('foo.test') && names.includes(HOST), JSON.stringify(names));
    push('POST 记录来源与加入时间', post.rules.every((r) => r.source === 'diagnostic' && r.addedAt > 0));
    push('POST 同步到 /api/config', (await api('/api/config')).passthrough.includes(HOST));
    if (dataDir) {
      const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      push('白名单落盘持久化', Array.isArray(disk.passthrough) && disk.passthrough.includes(HOST) && !!disk.passthroughMeta[HOST]);
    } else {
      push('白名单落盘持久化（服务未暴露 dataDir，跳过）', true, 'skipped');
    }

    await handshake(DIAG_A);
    await handshake(DIAG_B, { alpn: ['h2'] });
    await sleep(250);
    const diag = await api('/api/diagnostics');
    const a = diag.tlsFailures.find((f) => f.host === DIAG_A);
    const b = diag.tlsFailures.find((f) => f.host === DIAG_B);
    push('诊断记录带原因分类', !!a && a.reason === 'no-request' && !!b && b.reason === 'alpn', JSON.stringify(diag.tlsFailures.map((f) => [f.host, f.reason])));
    push('诊断记录带 SNI / ALPN 细节', !!a && a.detail && a.detail.sni === DIAG_A && a.detail.established === false);

    const cleared = await api('/api/passthrough', { method: 'POST', body: { rules: ['diag.test'], source: 'manager' } });
    push('加白名单返回切断数（本次无可切断连接）', typeof cleared.killed === 'number');
    push('加白名单立即清掉对应诊断', (await api('/api/diagnostics')).tlsFailures.length === 0);

    const keep = await holdMitm(KEEP_HOST);
    push('存量 MITM 握手成功', !!keep);
    if (keep) {
      const killed = await api('/api/passthrough', { method: 'POST', body: { rules: [KEEP_HOST], source: 'manager' } });
      push('规则变更切断存量解密连接', killed.killed >= 1, 'killed=' + killed.killed);
      keep.ts.destroy();
    } else {
      push('规则变更切断存量解密连接（无法建连，跳过）', true, 'skipped');
    }

    await connectOnly(HOST);
    const hits = await api('/api/passthrough');
    const apple = hits.rules.find((r) => r.rule === HOST);
    push('透传命中计数按规则聚合', !!apple && apple.hits >= 1 && apple.hosts.includes(HOST), JSON.stringify(apple));

    const one = await api('/api/passthrough?rule=' + encodeURIComponent('foo.test'), { method: 'DELETE' });
    push('DELETE 单条只删指定规则', !one.passthrough.includes('foo.test') && one.passthrough.includes(HOST), JSON.stringify(one.passthrough));
    await api('/api/config', { method: 'PUT', body: { passthrough: ['compat.test'] } });
    push('PUT /api/config 仍与管理列表同源', (await api('/api/passthrough')).rules.some((r) => r.rule === 'compat.test'));
    await api('/api/passthrough', { method: 'DELETE' });
    push('DELETE 无参数清空全部', (await api('/api/passthrough')).rules.length === 0);

    /* -------------------------------------------------------- UI */
    await api('/api/passthrough', { method: 'POST', body: { rules: ['ui-one.test', 'ui-two.test'], source: 'manager' } });
    await api('/api/diagnostics', { method: 'DELETE' });
    browser = await chromium.launch({ headless: true, executablePath: EXEC });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('dialog', (d) => d.accept());
    await page.goto(UI, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // #ptCount 在默认收起的「更多」菜单里，isHidden 会受父级影响，直接看 hidden 属性
    push('顶栏角标显示规则数', (await page.locator('#ptCount').textContent()) === '2' && (await page.locator('#ptCount').getAttribute('hidden')) === null);
    await page.evaluate(() => {
      window.__ptEvents = [];
      const es = new EventSource('/api/events');
      es.onmessage = (e) => { try { window.__ptEvents.push(JSON.parse(e.data).type); } catch (_) {} };
    });

    await page.click('#btnPassthrough');
    await page.waitForTimeout(250);
    push('顶栏入口打开管理列表', await page.locator('#modalPassthrough').isVisible());
    push('列表渲染全部规则', (await page.locator('#ptList .pt-row').count()) === 2);
    push('列表显示来源标签', (await page.locator('#ptList .pt-badge').first().textContent()).length > 0);
    push('常见系统服务建议可点', (await page.locator('#ptSuggest [data-pt-add]').count()) >= 3);

    await page.fill('#ptAddInput', 'ui-three.test, *.Batch.Test:443/x ui-three.test');
    await page.click('#ptAddBtn');
    await page.waitForTimeout(350);
    const afterAdd = await page.locator('#ptList .pt-domain').allTextContents();
    push('批量添加归一化去重', afterAdd.length === 4 && afterAdd.includes('ui-three.test') && afterAdd.includes('batch.test'), JSON.stringify(afterAdd));
    push('SSE 广播 passthrough 事件', (await page.evaluate(() => window.__ptEvents)).includes('passthrough'));
    push('列表状态条显示条数', /4/.test(await page.locator('#ptLiveText').textContent()));

    await page.fill('#ptSearch', 'three');
    await page.waitForTimeout(120);
    push('搜索只保留命中规则', (await page.locator('#ptList .pt-row').count()) === 1 && (await page.locator('#ptList .pt-domain').first().textContent()) === 'ui-three.test');
    await page.fill('#ptSearch', '');
    await page.waitForTimeout(120);

    await page.locator('#ptList .pt-row').filter({ hasText: 'ui-three.test' }).locator('[data-pt-edit]').click();
    await page.waitForTimeout(120);
    push('编辑态出现输入框', (await page.locator('#ptList [data-pt-value]').count()) === 1);
    await page.fill('#ptList [data-pt-value]', 'ui-three-renamed.test');
    await page.locator('#ptList [data-pt-save]').click();
    await page.waitForTimeout(350);
    push('编辑保存写入服务端', (await page.locator('#ptList .pt-domain').allTextContents()).includes('ui-three-renamed.test') && (await api('/api/passthrough')).rules.some((r) => r.rule === 'ui-three-renamed.test'));

    // 诊断详情：原因分类 + 管理列表入口 + 一键加入后自动打开列表
    // 先关掉管理面板，否则弹窗会挡住主列表里的诊断行
    await page.locator('#modalPassthrough [data-close]').first().click();
    await page.waitForTimeout(150);
    await handshake(DIAG_A);
    await page.waitForTimeout(500);
    push('握手失败行出现在主列表', (await page.locator('.row.tls').count()) >= 1);
    await page.locator('.row.tls').first().click();
    await page.waitForTimeout(180);
    push('详情显示原因判定', (await page.locator('#detail .tls-reason-title').count()) === 1);
    push('详情显示连接信息', /SNI/.test(await page.locator('#detail .tls-dbody').innerText()));
    push('详情有查看管理列表按钮', (await page.locator('#detail [data-pt-open]').count()) === 1);
    await page.locator('#detail [data-block-host]').click();
    await page.waitForTimeout(500);
    push('一键加入后自动打开管理列表', await page.locator('#modalPassthrough').isVisible());
    push('刚加入的规则被高亮', (await page.locator('#ptList .pt-row.hl').count()) === 1);
    push('一键加入写入配置并清诊断', (await api('/api/config')).passthrough.includes(DIAG_A) && (await api('/api/diagnostics')).tlsFailures.length === 0);

    await page.evaluate(() => window.ReqLiteI18N.setLang('en'));
    await page.waitForTimeout(450);
    const enText = await page.locator('#modalPassthrough').innerText();
    push('英文模式管理列表无中文残留', !/[\u4e00-\u9fff]/.test(enText), JSON.stringify(enText.slice(0, 90)));
    const enRow = await page.locator('.row.tls').count() ? await page.locator('.row.tls').first().innerText() : '';
    push('英文模式诊断行无中文残留', !/[\u4e00-\u9fff]/.test(enRow), JSON.stringify(enRow.slice(0, 90)));
    await page.evaluate(() => window.ReqLiteI18N.setLang('auto'));

    const beforeDel = (await api('/api/passthrough')).rules.length;
    const firstRule = (await api('/api/passthrough')).rules[0].rule;
    await page.locator('#ptList .pt-row').filter({ hasText: firstRule }).locator('[data-pt-del]').click();
    await page.waitForTimeout(300);
    push('列表删除单条生效', (await api('/api/passthrough')).rules.length === beforeDel - 1);

    await page.click('#ptClearAll');
    await page.waitForTimeout(350);
    push('清空全部生效且角标隐藏', (await api('/api/passthrough')).rules.length === 0 && (await page.locator('#ptCount').getAttribute('hidden')) !== null);
    push('清空后显示空状态', (await page.locator('#ptList .pt-empty').count()) === 1);
    push('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    if (browser) await browser.close();
    await api('/api/config', { method: 'PUT', body: { passthrough: saved } }).catch(() => {});
    await api('/api/diagnostics', { method: 'DELETE' }).catch(() => {});
    await api('/api/flows', { method: 'DELETE' }).catch(() => {});
  }

  let pass = 0;
  for (const [name, ok, extra] of checks) {
    if (ok) pass += 1;
    console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
  }
  console.log(`共 ${checks.length} 项，通过 ${pass} 项`);
  process.exitCode = pass === checks.length ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
