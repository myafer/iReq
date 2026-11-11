'use strict';

/**
 * 自检：应用图标（抓包工具侧栏带 App 图标）
 * ---------------------------------------------------------------------------
 * ① 单元：名称归一 / bundle 定位 / 真实 PNG 生成与缓存 / 防穿越 / hint 异步回填
 * ② API：批量查询、图标文件 MIME 与字节、坏路径、status 字段
 * ③ UI：侧栏应用 + 设备、请求列表、详情都带图标；真实图标 / 内置 SVG /
 *        默认首字母图标三层兜底；深色主题、无溢出、无报错
 *
 * 前置：服务在 9090/9091 运行。会造测试流量，结束时清空。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, EXEC } = require('./_pw');
const { seedFlows } = require('./_seed');
const { AppIconResolver, normalizeName, bundlePathOf, safeIconFile } = require('../src/app-icon');

const { UI: API } = require('./_env');
const checks = [];
const ok = (name, cond, extra = '') => {
  checks.push([name, !!cond]);
  if (!cond) console.log('   ↳', extra);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts) => {
  const r = await fetch(API + p, opts);
  return r.json();
};
const isPng = (buf) =>
  buf.length > 100 && buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

async function main() {
  /* ---------------------------------------------------------------- ① 单元 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-icon-check-'));
  const r = new AppIconResolver({ dataDir: dir });
  const isMac = process.platform === 'darwin';

  ok('非 macOS 也能安全降级', r.supported === isMac);
  ok('名称归一：Chrome 141 → chrome', normalizeName('Chrome 141') === 'chrome');
  ok('名称归一：Google Chrome.app → googlechrome', normalizeName('Google Chrome.app') === 'googlechrome');
  ok('名称归一：OkHttp 4 → okhttp', normalizeName('OkHttp 4') === 'okhttp');
  ok(
    '从可执行路径取 .app',
    bundlePathOf('/Applications/WeChat.app/Contents/MacOS/WeChat') === '/Applications/WeChat.app'
  );
  ok('bundle 自身路径也能识别', bundlePathOf('/Applications/WeChat.app') === '/Applications/WeChat.app');
  ok('普通路径返回 null', bundlePathOf('/usr/bin/curl') === null);
  ok('图标文件名白名单挡住穿越', safeIconFile('../etc/passwd') === null && safeIconFile('a.png') === null);
  ok('合法 hash 文件名通过', safeIconFile('a'.repeat(20) + '.png') !== null);

  const apps = r.scan().size;
  ok('扫描到本机应用目录', !isMac || apps > 30, `apps=${apps}`);

  if (isMac) {
    ok('按名字找到 Google Chrome.app', /Google Chrome\.app$/.test(String(r.findBundle('Google Chrome'))));
    ok('UA 名「Chrome 141」也能找到', /Google Chrome\.app$/.test(String(r.findBundle('Chrome 141'))));
    ok('通用网络库名不会误配成本机 App', r.findBundle('OkHttp 4') === null);

    const chrome = await r.resolve('Google Chrome');
    ok('Google Chrome 生成真实图标 URL', Boolean(chrome && /^\/app-icon\/[a-f0-9]{20}\.png$/.test(chrome.url)), JSON.stringify(chrome));
    const pngPath = chrome && path.join(r.dir, chrome.url.split('/').pop());
    const png = chrome && fs.readFileSync(pngPath);
    ok('图标是有效 PNG', Boolean(png && isPng(png)), chrome && pngPath);
    ok('图标统一缩到 128px', Boolean(png && png.readUInt32BE(16) === 128 && png.readUInt32BE(20) === 128), png && `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    const generated = r.stats.generated;
    const again = await r.resolve('Google Chrome');
    ok('重复解析命中缓存不再转换', again.url === chrome.url && r.stats.generated === generated);
    const alias = await r.resolve('Chrome 141');
    ok('别名复用同一张图标', alias.url === chrome.url);

    ok('完全不存在的应用返回 null', (await r.resolve('自检绝不存在AppXYZ')) === null);
    r.registerHint('自检绝不存在AppXYZ', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    const afterHint = await r.resolve('自检绝不存在AppXYZ');
    ok(
      '异步拿到 .app 路径后能补上图标（清除失败缓存）',
      Boolean(afterHint && afterHint.url === chrome.url),
      JSON.stringify(afterHint)
    );

    ok('微信能抽到图标', Boolean((await r.resolve('WeChat')).url));
    ok('Safari 能抽到图标', Boolean((await r.resolve('Safari')).url));
    ok('统计里有成功与失败计数', r.stats.resolved >= 4 && r.stats.failed >= 1, JSON.stringify(r.stats));
  } else {
    ok('非 macOS：解析全部返回 null', (await r.resolve('Google Chrome')) === null);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  /* ----------------------------------------------------------------- ② API */
  const names = 'Google Chrome,WeChat,Safari,Chrome 120,不存在XYZ';
  const j = await api('/api/app-icons?names=' + encodeURIComponent(names));
  ok('批量查询返回 5 个名字', Object.keys(j.icons || {}).length === 5, JSON.stringify(j.icons));
  ok('API 报告 supported', j.supported === isMac);
  if (isMac) {
    ok('Chrome / 微信 / Safari 都有图标 URL', ['Google Chrome', 'WeChat', 'Safari'].every((n) => j.icons[n] && j.icons[n].url));
    ok('UA 名 Chrome 120 归一到 Chrome 图标', j.icons['Chrome 120'] && j.icons['Chrome 120'].url === j.icons['Google Chrome'].url);
  }
  ok('找不到的应用返回 null（由前端兜底）', j.icons['不存在XYZ'] === null);

  for (const name of ['Google Chrome', 'WeChat', 'Safari']) {
    const url = j.icons[name] && j.icons[name].url;
    if (!url) {
      ok(`${name} 图标文件 200`, false, '无 URL');
      continue;
    }
    const res = await fetch(API + url);
    const buf = Buffer.from(await res.arrayBuffer());
    ok(`${name} 图标文件 200 / image/png / PNG 魔数`, res.status === 200 && /image\/png/.test(res.headers.get('content-type') || '') && isPng(buf), `${res.status} ${buf.length}B`);
  }
  const bad = await fetch(API + '/app-icon/..%2Fpackage.json');
  ok('路径穿越返回 404', bad.status === 404, String(bad.status));
  const bad2 = await fetch(API + '/app-icon/not-an-icon.png');
  ok('非法文件名返回 404', bad2.status === 404, String(bad2.status));
  const status = await api('/api/status');
  ok('/api/status 带 appIcons 统计', Boolean(status.appIcons && status.appIcons.apps > 0), JSON.stringify(status.appIcons));

  /* ------------------------------------------------------------------ ③ UI */
  await seedFlows();
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const fails = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
  page.on('response', (r) => {
    if (r.status() >= 400) fails.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(API + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  const base = await page.evaluate(() => ({
    hasModule: !!window.ReqLiteIcons,
    builtinChrome: window.ReqLiteIcons && window.ReqLiteIcons.builtin('Chrome 120'),
    builtinOkHttp: window.ReqLiteIcons && window.ReqLiteIcons.builtin('OkHttp 4'),
    builtinWechat: window.ReqLiteIcons && window.ReqLiteIcons.builtin('微信'),
    builtinUnknown: window.ReqLiteIcons && window.ReqLiteIcons.builtin('reader 3.2.1'),
    sideAppItems: document.querySelectorAll('.sgroup[data-group="apps"] .sitem').length,
    sideAppIcons: document.querySelectorAll('.sgroup[data-group="apps"] .sitem .app-icon').length,
    deviceIcons: document.querySelectorAll('.sgroup[data-group="devices"] .app-icon.device').length,
    rows: document.querySelectorAll('.row').length,
    rowIcons: document.querySelectorAll('.row .app-icon').length,
    totalIcons: document.querySelectorAll('.app-icon').length,
    realIcons: document.querySelectorAll('.app-icon.has-real img.ic-real').length,
    builtinIcons: document.querySelectorAll('.app-icon.builtin:not(.has-real)').length,
    defaultIcons: document.querySelectorAll('.app-icon.default:not(.has-real) .ic-initial').length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  ok('前端图标模块已加载', base.hasModule);
  ok('内置图标命中 Chrome / OkHttp / 微信', base.builtinChrome && base.builtinOkHttp && base.builtinWechat, JSON.stringify(base));
  ok('陌生应用不误配内置图标', base.builtinUnknown === false);
  ok('侧栏「应用」每项都有图标', base.sideAppItems > 0 && base.sideAppIcons === base.sideAppItems, `${base.sideAppIcons}/${base.sideAppItems}`);
  ok('侧栏「设备」有设备图标', base.deviceIcons > 0, String(base.deviceIcons));
  ok('请求列表每行都有应用图标', base.rows > 0 && base.rowIcons === base.rows, `${base.rowIcons}/${base.rows}`);
  ok('界面上同时有真实图标与内置图标', base.realIcons > 0 && base.builtinIcons > 0, JSON.stringify(base));
  ok('图标不撑破布局（无横向溢出）', base.overflow <= 2, String(base.overflow));

  // 手动插入两个节点，稳定验证「真实图标注入」和「默认图标兜底」
  const injected = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="iconProbe">' + window.ReqLiteIcons.iconHtml('Google Chrome', 'lg') + window.ReqLiteIcons.iconHtml('绝不存在的AppXYZ', 'lg') + '</div>');
    window.ReqLiteIcons.hydrate();
    await new Promise((r) => setTimeout(r, 1200));
    const real = document.querySelector('#iconProbe .app-icon.has-real');
    const def = document.querySelector('#iconProbe .app-icon.default');
    const img = real && real.querySelector('img.ic-real');
    return {
      realState: real && real.dataset.iconState,
      realTitle: real && real.title,
      imgSrc: img && img.getAttribute('src'),
      imgW: img && img.naturalWidth,
      imgVisible: img && getComputedStyle(img).visibility !== 'hidden',
      defState: def && def.dataset.iconState,
      defTitle: def && def.title,
      defInitial: def && def.querySelector('.ic-initial').textContent,
      defBg: def && getComputedStyle(def).backgroundColor,
    };
  });
  ok('真实图标注入 <img> 且加载成功', injected.realState === 'real' && injected.imgW === 128 && injected.imgVisible, JSON.stringify(injected));
  ok('真实图标 URL 指向 /app-icon/', /^\/app-icon\//.test(injected.imgSrc || ''), String(injected.imgSrc));
  ok('真实图标 title 标明来源', /本机应用图标/.test(injected.realTitle || ''), String(injected.realTitle));
  ok('取不到图标时用默认图标', injected.defState === 'none' && injected.defInitial === '绝', JSON.stringify(injected));
  ok('默认图标有稳定配色', /rgb\(/.test(injected.defBg || ''), String(injected.defBg));
  ok('默认图标 title 标明是默认', /默认图标/.test(injected.defTitle || ''), String(injected.defTitle));
  const retryFn = await page.evaluate(() => typeof window.ReqLiteIcons.retry);
  ok('异步回填失败可自动重试', retryFn === 'function', String(retryFn));

  // 详情：设备 + 应用两行都要带图标，且文字还在
  // 页面内同步 click，避免 SSE 重绘导致 ElementHandle detached
  const clicked = await page.evaluate(() => {
    const r = document.querySelector('.row');
    if (!r) return false;
    r.click();
    return true;
  });
  if (clicked) {
    await page.waitForTimeout(900);
    const d = await page.evaluate(() => {
      const dts = [...document.querySelectorAll('#detail .kv dt')];
      const dds = [...document.querySelectorAll('#detail .kv dd')];
      const pick = (label) => dds[dts.findIndex((x) => x.textContent.trim() === label)];
      const dev = pick('设备');
      const app = pick('应用');
      return {
        icons: document.querySelectorAll('#detail .app-icon').length,
        devIcon: !!dev && !!dev.querySelector('.app-icon.device'),
        appIcon: !!app && !!app.querySelector('.app-icon'),
        devText: dev && dev.textContent.trim(),
        appText: app && app.textContent.trim(),
      };
    });
    ok('详情「设备 / 应用」各带一个图标', d.icons >= 2 && d.devIcon && d.appIcon, JSON.stringify(d));
    ok('详情加图标后文字没丢', Boolean(d.devText && d.appText), JSON.stringify(d));
  } else {
    ok('详情「设备 / 应用」各带一个图标', false, '没有可点请求');
    ok('详情加图标后文字没丢', false, '没有可点请求');
  }

  // 深色主题：图标仍然可见，真实图标不被重绘弄丢
  await page.click('#btnTheme');
  await page.waitForTimeout(500);
  const dark = await page.evaluate(() => {
    const el = document.querySelector('.app-icon');
    return {
      theme: document.documentElement.dataset.theme,
      visible: el && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0,
      real: document.querySelectorAll('.app-icon.has-real img.ic-real').length,
    };
  });
  ok('深色主题下图标仍可见', dark.theme === 'dark' && dark.visible, JSON.stringify(dark));
  ok('切主题不丢真实图标', dark.real > 0, String(dark.real));
  await page.click('#btnTheme');

  // 闪动回归：所有名字都已缓存后，点侧栏应用触发重渲染，
  // 已知真实图标必须「渲染即内联 <img>」，不允许出现 pending → 事后替换
  const flicker = await page.evaluate(() => {
    const before = document.querySelectorAll('.app-icon.has-real img.ic-real').length;
    const item = document.querySelector('.sgroup[data-group="apps"] .sitem');
    if (item) item.click();
    const pend = document.querySelectorAll('.app-icon[data-icon-state="pending"]').length;
    const after = document.querySelectorAll('.app-icon.has-real img.ic-real').length;
    const stateOk = !document.querySelector('.app-icon[data-icon-state="pending"]');
    return { before, after, pend, stateOk };
  });
  ok(
    '选中应用时图标不闪动（重渲染即时内联，无 pending 替换）',
    flicker.stateOk && flicker.after > 0,
    JSON.stringify(flicker)
  );

  ok('无 JS 报错', errs.length === 0, errs.join(' | '));
  ok('无 4xx/5xx 资源', fails.length === 0, fails.slice(0, 5).join(' | '));
  await browser.close();

  // 清理测试流量（归档保留，不动规则）
  await fetch(API + '/api/flows', { method: 'DELETE' });

  console.log('\n--- 结果 ---');
  for (const [name, pass] of checks) console.log(`${pass ? '✅' : '❌'} ${name}`);
  console.log(`共 ${checks.length} 项，通过 ${checks.filter((c) => c[1]).length} 项`);
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
}

main().catch((e) => {
  console.error('自检异常:', e);
  process.exitCode = 1;
});
