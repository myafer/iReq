'use strict';

/**
 * 自检：控制坞（dock）—— 系统代理状态 / Mock 总开关 / 弱网开关 / 抓包暂停。
 *
 * 回归点：
 *  1. Mock 总开关必须是「整体旁路」：关掉后请求直接转发，绝不能再命中规则；
 *     开关状态在 /api/status 与 /api/config 双向可见。
 *  2. dock 的徽章口径：Mock = 已启用规则数；弱网 = 生效规则数（总开关关掉归零），
 *     与顶栏 netCount 一致。
 *  3. dock 的暂停按钮与顶栏「抓包」开关是同一个状态源（capture），两边必须联动。
 *  4. 英文界面 dock 不得残留中文（含动态的「已接管 ip:port」整句）。
 *
 * 不修改系统代理、不动真实 data/，可在服务运行时安全执行。
 */
const { UI, PROXY_PORT } = require('./_env');

const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

/** 走代理发一个 HTTP 请求，返回 { status, body, failed } */
function proxyGet(url) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, failed: false }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e.message), failed: true }));
    req.setTimeout(6000, () => { req.destroy(new Error('timeout')); });
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

  /* ---------------- A. API 层：mockEnabled 默认值与往返 ---------------- */
  let st = await api('/api/status');
  push('status 暴露 mockEnabled 且默认 true', st.mockEnabled === true);

  await api('/api/config', { method: 'PUT', body: JSON.stringify({ mockEnabled: false }), headers: { 'content-type': 'application/json' } });
  st = await api('/api/status');
  push('PUT mockEnabled=false 后 status 同步为 false', st.mockEnabled === false);
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ mockEnabled: true }), headers: { 'content-type': 'application/json' } });
  st = await api('/api/status');
  push('PUT mockEnabled=true 后恢复', st.mockEnabled === true);

  /* ---------------- B. 端到端：总开关真正旁路 Mock ---------------- */
  const rule = await api('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dock-check', host: 'dock-check.example', body: 'DOCK_MOCK_HIT' }),
  });
  push('测试规则已创建', Boolean(rule && rule.id));

  let hit = await proxyGet('http://dock-check.example/dock');
  push('总开关开启：代理请求命中 Mock', !hit.failed && hit.body.includes('DOCK_MOCK_HIT'));

  await api('/api/config', { method: 'PUT', body: JSON.stringify({ mockEnabled: false }), headers: { 'content-type': 'application/json' } });
  hit = await proxyGet('http://dock-check.example/dock');
  push('总开关关闭：请求被旁路（不再命中 Mock）', hit.failed || !hit.body.includes('DOCK_MOCK_HIT'));

  await api('/api/config', { method: 'PUT', body: JSON.stringify({ mockEnabled: true }), headers: { 'content-type': 'application/json' } });
  hit = await proxyGet('http://dock-check.example/dock');
  push('总开关重新开启：恢复命中 Mock', !hit.failed && hit.body.includes('DOCK_MOCK_HIT'));

  /* ---------------- C. 弱网徽章口径（会话级 config） ---------------- */
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ networkSim: { enabled: true, rules: [{ match: 'app:dock-app', mode: 'offline' }] } }),
  });
  st = await api('/api/status');
  push('网络模拟 1 条规则已下发', st.networkSim && st.networkSim.rules.length === 1);

  /* ---------------- D. UI：dock 渲染与联动 ---------------- */
  let chromium = null, EXEC;
  try { ({ chromium, EXEC } = require('./_pw')); } catch (_) { /* 环境无 Playwright 时跳过 */ }
  if (chromium) {
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    push('dock 渲染且可见', await page.evaluate(() => {
      const d = document.querySelector('#dock');
      return d && !d.hidden && d.offsetHeight > 0;
    }));
    push('初始代理文案 = 未接管本机代理', (await page.textContent('#dockProxyText')).trim() === '未接管本机代理');
    push('Mock 默认开（on 类）', await page.evaluate(() => document.querySelector('#dockMock').classList.contains('on')));
    // 徽章口径 = 已启用规则数（隔离目录可能有历史规则，按 /api/rules 实际值对账）
    const enabledRules = ((await api('/api/rules')) || []).filter((r) => r.enabled !== false).length;
    push(`Mock 徽章 = 已启用规则数 ${enabledRules}`, await page.evaluate((n) => {
      const b = document.querySelector('#dockMockCount');
      return n === 0 ? b.hidden : (!b.hidden && b.textContent === String(n));
    }, enabledRules));
    push('弱网徽章 = 1 且 on', await page.evaluate(() => {
      const b = document.querySelector('#dockNetCount');
      const t = document.querySelector('#dockNet');
      return !b.hidden && b.textContent === '1' && t.classList.contains('on');
    }));
    push('暂停按钮初始文案 = 暂停', (await page.textContent('#dockPauseText')).trim() === '暂停');

    // 暂停 ↔ 继续：与顶栏 #capture 联动
    await page.click('#dockPause');
    await page.waitForTimeout(400);
    const paused = await page.evaluate(() => ({
      text: document.querySelector('#dockPauseText').textContent.trim(),
      capture: document.querySelector('#capture').checked,
      cls: document.querySelector('#dockPause').classList.contains('paused'),
    }));
    push('点击后变「继续」且顶栏开关同步关闭', paused.text === '继续' && paused.capture === false && paused.cls);
    await page.click('#dockPause');
    await page.waitForTimeout(400);
    push('再点恢复「暂停」且顶栏开关同步打开', await page.evaluate(() =>
      document.querySelector('#dockPauseText').textContent.trim() === '暂停' && document.querySelector('#capture').checked
    ));

    // Mock 开关：UI 点击 → 服务端状态翻转
    await page.click('#dockMock');
    await page.waitForTimeout(400);
    push('UI 点击后 dock off 且 status=false', (await page.evaluate(() =>
      !document.querySelector('#dockMock').classList.contains('on')
    )) && (await api('/api/status')).mockEnabled === false);
    await page.click('#dockMock');
    await page.waitForTimeout(400);
    push('再次点击恢复 on 且 status=true', (await page.evaluate(() =>
      document.querySelector('#dockMock').classList.contains('on')
    )) && (await api('/api/status')).mockEnabled === true);

    // Mock 徽章：规则加载后显示已启用数（新建 1 条 → 实际值 +1）
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const enabledRules2 = ((await api('/api/rules')) || []).filter((r) => r.enabled !== false).length;
    push(`Mock 徽章 = ${enabledRules2}（含新建规则）`, await page.evaluate((n) => {
      const b = document.querySelector('#dockMockCount');
      return !b.hidden && b.textContent === String(n);
    }, enabledRules2));

    // 右键直达：Mock → 规则工作区；弱网 → 网络模拟弹窗
    await page.click('#dockMock', { button: 'right' });
    await page.waitForTimeout(500);
    push('右键 Mock 打开规则工作区', await page.evaluate(() => !document.querySelector('#modalRules').hidden));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.click('#dockNet', { button: 'right' });
    await page.waitForTimeout(500);
    push('右键弱网打开网络模拟弹窗', await page.evaluate(() => !document.querySelector('#modalNetwork').hidden));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 英文界面：无中文残留
    await page.evaluate(() => { if (window.ReqLiteI18N) window.ReqLiteI18N.setLang('en'); });
    await page.waitForTimeout(400);
    const enProxy = (await page.textContent('#dockProxyText')).trim();
    push('英文：代理文案已翻译', /^(Local proxy not taken over|Taking over .+)$/.test(enProxy));
    push('英文：暂停按钮已翻译', ['Pause', 'Resume'].includes((await page.textContent('#dockPauseText')).trim()));
    push('英文：弱网标签已翻译', (await page.textContent('#dockNet .dock-tlabel')).trim() === 'Slow');
    push('英文：dock 无中文残留', await page.evaluate(() => {
      const t = document.querySelector('#dock').textContent;
      return !/[\u4e00-\u9fff]/.test(t);
    }));
    push('页面无 JS 报错', errs.length === 0);

    await browser.close();
  } else {
    push('Playwright 可用（跳过 UI 检查）', true);
  }

  /* ---------------- 清理 ---------------- */
  await api('/api/rules/' + rule.id, { method: 'DELETE' }).catch(() => {});
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ networkSim: { enabled: true, rules: [] } }),
  }).catch(() => {});
  st = await api('/api/status');
  push('清理完成（规则删除 / 弱网清空 / mock 开）', st.mockEnabled === true && st.networkSim.rules.length === 0);

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
