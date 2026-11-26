'use strict';

/**
 * 自检：握手失败 → 自动跳过解密（不再需要用户维护白名单）
 * ---------------------------------------------------------------------------
 * 设计口径（v1.5 起）：
 *  · 同一域名连续 2 次握手失败，且原因是「重试也没用」的四类之一
 *    （不认证书 / 只接受 h2 / 握手完没请求 / 端口不是 HTTP），代理自动改成原样透传；
 *  · 那一行**留在列表里**并标记「跳过解密」，带原因，用户自己决定要不要处理；
 *  · 详情里给「重新尝试解密」，处理完点一下就恢复；
 *  · 原来的「跳过解密管理列表」入口、弹框、设置页文本框全部去掉。
 *
 * 覆盖：纯函数 / HTTP 接口语义（MCP 与「重新尝试解密」都走它）/ 自动跳过行为 /
 *       列表标记 / 详情按钮 / 管理入口已删除。
 *
 * 只造本地 CONNECT + TLS 握手，不依赖外网；结束恢复 passthrough、诊断与 h2 开关。
 */
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const { ensureMitmAll, restoreScope } = require('./_scope');
const {
  passthroughMatches,
  normalizePassthroughRule,
  classifyTlsFailure,
  TLS_AUTO_SKIP_AFTER,
  TLS_IDLE_SKIP_AFTER,
  shouldSkipIdle,
  matchesMitmScope,
} = require('../src/proxy');

const HOST = 'gsa-gpk.apple.com'; /* 手动白名单用：验证接口语义 */
const AUTO_HOST = 'pin.auto-skip.test'; /* 自动跳过的目标 */
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
      try {
        s.destroy();
      } catch (_) {}
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

/** 只发 CONNECT 等 200：用来累计「因为白名单而透传」的命中数 */
function connectOnly(host) {
  return new Promise((resolve) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch (_) {}
      resolve(v);
    };
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    s.once('data', () => finish('ok'));
    s.on('error', () => finish('error'));
    s.on('close', () => finish('closed'));
    setTimeout(() => finish('timeout'), 2500);
  });
}

const passRule = async (host, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const list = await api('/api/passthrough');
    const rule = (list.rules || []).find((r) => r.rule === host);
    if (rule) return rule;
    await sleep(250);
  }
  return null;
};

const diagOf = async (host) => {
  const d = await api('/api/diagnostics');
  return (d.tlsFailures || []).find((f) => f.host === host) || null;
};

(async () => {
  // 默认解密范围是「只解密指定」，这些套件验证的是解密链路本身：先切全解，结束还原
  const scopeBefore = await ensureMitmAll();
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
  push('自动跳过阈值是 2 次', TLS_AUTO_SKIP_AFTER === 2, String(TLS_AUTO_SKIP_AFTER));
  // 解密范围：默认只解密命中的域名 / 应用
  {
    const scope = { mode: 'list', domains: ['demo.com'], apps: ['wechat'] };
    push('解密范围：all 模式全解', matchesMitmScope('any.test', '', { mode: 'all' }));
    push('解密范围：域名命中（含子域）', matchesMitmScope('a.demo.com', '', scope));
    push('解密范围：域名不命中就不解密', matchesMitmScope('apple.com', '', scope) === false);
    push('解密范围：应用名命中', matchesMitmScope('apple.com', 'WeChat Helper', scope));
    push('解密范围：默认配置只解密显式配置的', matchesMitmScope('apple.com', 'Music', { mode: 'list', domains: [], apps: [] }) === false);
  }
  // 空闲连接超时（Apple 系统 App 的预连接）：3 次起跳，但域名解密成功过就永不跳
  push('原因分类：握手超时 → idle', classifyTlsFailure(new Error('TLS handshake timeout')) === 'idle');
  push('空闲超时阈值是 3 次', TLS_IDLE_SKIP_AFTER === 3, String(TLS_IDLE_SKIP_AFTER));
  push(
    '空闲超时：2 次不跳 / 3 次无成功记录才跳 / 有成功记录不跳',
    shouldSkipIdle({ reason: 'idle', count: 2 }, false) === false &&
      shouldSkipIdle({ reason: 'idle', count: 3 }, false) === true &&
      shouldSkipIdle({ reason: 'idle', count: 9 }, true) === false
  );

  push('隔离服务可达', await waitUi());
  dataDir = (await api('/api/status')).dataDir || '';
  let browser;
  try {
    await api('/api/passthrough', { method: 'DELETE' });
    await api('/api/diagnostics', { method: 'DELETE' });
    // alpn 用例要走 http/1.1 回退路径（h2 开着时 createSecureServer 会接受 h2 握手）
    await api('/api/config', { method: 'PUT', body: { h2Enabled: false } });

    /* -------------------------------------- HTTP 接口语义（MCP 也走这套） */
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

    await connectOnly(HOST);
    const hits = await api('/api/passthrough');
    const apple = hits.rules.find((r) => r.rule === HOST);
    push('透传命中计数按规则聚合', !!apple && apple.hits >= 1 && apple.hosts.includes(HOST), JSON.stringify(apple));

    const one = await api('/api/passthrough?rule=' + encodeURIComponent('foo.test'), { method: 'DELETE' });
    push('DELETE 单条只删指定规则', !one.passthrough.includes('foo.test') && one.passthrough.includes(HOST), JSON.stringify(one.passthrough));
    await api('/api/config', { method: 'PUT', body: { passthrough: ['compat.test'] } });
    push('PUT /api/config 与列表同源', (await api('/api/passthrough')).rules.some((r) => r.rule === 'compat.test'));
    await api('/api/passthrough', { method: 'DELETE' });
    push('DELETE 无参数清空全部', (await api('/api/passthrough')).rules.length === 0);

    /* -------------------------------------------------- 自动跳过解密 */
    await api('/api/diagnostics', { method: 'DELETE' });
    await handshake(AUTO_HOST);
    await sleep(300);
    const first = await diagOf(AUTO_HOST);
    push('第 1 次失败：只记录、不跳过', !!first && !first.skipped && first.count === 1, JSON.stringify(first && { c: first.count, s: first.skipped, r: first.reason }));
    push('第 1 次失败：还没进白名单', !(await api('/api/passthrough')).rules.some((r) => r.rule === AUTO_HOST));

    await handshake(AUTO_HOST);
    const auto = await passRule(AUTO_HOST);
    push('第 2 次失败：自动进白名单', !!auto, JSON.stringify(auto));
    push('自动加入的规则带 auto 标记与原因', !!auto && auto.auto === true && auto.source === 'auto' && !!auto.reason, JSON.stringify(auto && { s: auto.source, r: auto.reason }));
    const rec2 = await diagOf(AUTO_HOST);
    push('诊断行保留并标记 skipped', !!rec2 && rec2.skipped === true, JSON.stringify(rec2 && { c: rec2.count, s: rec2.skipped }));
    if (dataDir) {
      const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      push('自动跳过落盘（含 auto 原因）', !!(disk.passthroughMeta && disk.passthroughMeta[AUTO_HOST] && disk.passthroughMeta[AUTO_HOST].auto === true));
    } else {
      push('自动跳过落盘（服务未暴露 dataDir，跳过）', true, 'skipped');
    }

    // 再握一次：这次不再解密，失败次数不该继续涨
    await handshake(AUTO_HOST);
    await sleep(500);
    const rec3 = await diagOf(AUTO_HOST);
    push('跳过之后不再累计失败次数', !!rec3 && rec3.count === (rec2 ? rec2.count : 2), JSON.stringify(rec3 && rec3.count));

    // 行内手动「立即跳过」仍然可用（接口没变）
    const manual = await api('/api/passthrough', { method: 'POST', body: { rules: ['manual.skip.test'], source: 'diagnostic' } });
    push('手动加白名单仍可用（MCP / 快捷方式）', manual.passthrough.includes('manual.skip.test'));
    await api('/api/passthrough?rule=manual.skip.test', { method: 'DELETE' });

    /* ------------------------------------------------------------ UI */
    browser = await chromium.launch({ headless: true, executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    await page.goto(UI, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    const rowInfo = await page.evaluate((host) => {
      const row = [...document.querySelectorAll('.row.tls')].find((r) => r.textContent.includes(host));
      if (!row) return null;
      return {
        skippedCls: row.classList.contains('skipped'),
        text: row.textContent.replace(/\s+/g, ' ').trim(),
        st: (row.querySelector('.st') || {}).textContent || '',
        tag: (row.querySelector('.tag.skip') || {}).textContent || '',
      };
    }, AUTO_HOST);
    push('列表里保留了这一行', !!rowInfo, JSON.stringify(rowInfo && rowInfo.text.slice(0, 60)));
    push('行带「跳过解密」标记 + SKIP 状态', !!rowInfo && rowInfo.skippedCls && rowInfo.tag.includes('跳过解密') && rowInfo.st === 'SKIP', JSON.stringify(rowInfo && { tag: rowInfo.tag, st: rowInfo.st }));
    push('行上写明失败次数与原因', !!rowInfo && /\d+ 次失败后自动透传/.test(rowInfo.text));

    await page.evaluate((host) => {
      const row = [...document.querySelectorAll('.row.tls')].find((r) => r.textContent.includes(host));
      if (row) row.click();
    }, AUTO_HOST);
    await page.waitForTimeout(600);
    const detail = await page.evaluate(() => {
      const pane = document.querySelector('#detail');
      const retry = pane.querySelector('[data-pt-retry]');
      return {
        text: pane.innerText.replace(/\s+/g, ' ').slice(0, 160),
        hasRetry: !!retry,
        hasSkip: !!pane.querySelector('[data-pt-skip]'),
      };
    });
    push('详情标明已跳过并给「重新尝试解密」', detail.hasRetry && !detail.hasSkip && detail.text.includes('已跳过解密'), JSON.stringify(detail.text.slice(0, 80)));

    // 管理入口应该全没了
    const gone = await page.evaluate(() => ({
      menu: document.querySelectorAll('#btnPassthrough').length,
      modal: document.querySelectorAll('#modalPassthrough').length,
      field: document.querySelectorAll('#stPassthrough').length,
      list: document.querySelectorAll('#ptList').length,
    }));
    push('管理入口 / 弹框 / 设置文本框都已移除', gone.menu === 0 && gone.modal === 0 && gone.field === 0 && gone.list === 0, JSON.stringify(gone));

    // 点「重新尝试解密」：规则删掉、诊断行撤掉
    await page.click('[data-pt-retry]');
    await page.waitForTimeout(900);
    const afterRetry = await api('/api/passthrough');
    push('重新尝试解密：规则被移除', !afterRetry.rules.some((r) => r.rule === AUTO_HOST));
    const rowsLeft = await page.evaluate((host) => [...document.querySelectorAll('.row.tls')].filter((r) => r.textContent.includes(host)).length, AUTO_HOST);
    push('重新尝试解密：列表那一行撤掉', rowsLeft === 0, String(rowsLeft));

    // 恢复后再握一次手：又能正常记录失败（说明解密确实回来了）
    await handshake(AUTO_HOST);
    await sleep(400);
    const rec4 = await diagOf(AUTO_HOST);
    push('恢复解密后再次记录失败', !!rec4 && !rec4.skipped && rec4.count >= 1, JSON.stringify(rec4 && { c: rec4.count, s: rec4.skipped }));

    push('页面无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    await restoreScope(scopeBefore);

    await api('/api/passthrough', { method: 'DELETE' }).catch(() => {});
    await api('/api/diagnostics', { method: 'DELETE' }).catch(() => {});
    await api('/api/config', { method: 'PUT', body: { h2Enabled: true } }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  let fail = 0;
  for (const [name, ok, extra] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} 项通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('自检异常:', e);
  process.exitCode = 1;
});
