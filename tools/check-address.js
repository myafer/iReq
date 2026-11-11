'use strict';
const { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST } = require('./_env');

/**
 * 自检：顶栏代理地址
 *   - 默认显示局域网 IP（不是 127.0.0.1）
 *   - IP / 端口 / 完整地址三种复制都能拿到正确文本
 *   - 多网卡切换、持久化、空状态 / 证书弹窗 / 设置面板同步
 *   - 窄屏不溢出、深色主题下菜单可读、无 JS 报错
 *
 * 只读取服务端状态；空状态通过临时清空页面内存里的 S.flows 触发，不改服务端数据。
 */
const { chromium, EXEC } = require('./_pw');
const BASE = UI;
const checks = [];
const ok = (name, pass, extra = '') => checks.push([name, !!pass, extra]);

async function getStatus() {
  return fetch(BASE + '/api/status').then((r) => r.json());
}

(async () => {
  const st = await getStatus();
  const lan = (st.lanInfo && st.lanInfo[0] && st.lanInfo[0].ip) || (st.lan || [])[0] || null;
  const port = st.proxyPort;
  const full = `${lan}:${port}`;
  console.log(`服务端: lanInfo=${JSON.stringify(st.lanInfo || st.lan)} port=${port}`);
  if (!lan) {
    console.log('❌ 服务端没有返回局域网 IP，无法验证');
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ executablePath: EXEC });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  // 记录每一次 writeText 调用；同时保留真实剪贴板写入
  await ctx.addInitScript(() => {
    window.__copies = [];
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function (t) {
          window.__copies.push(String(t));
          return orig(t);
        };
      }
    } catch (_) {
      /* noop */
    }
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  const text = (sel) => page.textContent(sel).then((s) => (s || '').trim());
  const copies = () => page.evaluate(() => window.__copies.slice());
  const clearCopies = () => page.evaluate(() => (window.__copies.length = 0));

  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    // ---------------------------------------------- 默认地址与分段显示
    const ipText = await text('#addrIp');
    const portText = await text('#addrPort');
    ok('顶栏默认显示局域网 IP', ipText === lan, `实际 ${ipText} / 期望 ${lan}`);
    ok('顶栏不再显示 127.0.0.1', ipText !== '127.0.0.1', `实际 ${ipText}`);
    ok('端口单独显示且正确', portText === String(port), `实际 ${portText}`);
    ok('胶囊里 IP 与端口是分开的按钮', (await page.$$('#addrIp, #addrPort')).length === 2);

    // ---------------------------------------------- 三种复制
    await clearCopies();
    await page.click('#addrIp');
    await page.waitForTimeout(180);
    ok('点 IP 复制出 IP 本身', (await copies()).join('|') === lan, JSON.stringify(await copies()));

    await clearCopies();
    await page.click('#addrPort');
    await page.waitForTimeout(180);
    ok('点端口复制出端口本身', (await copies()).join('|') === String(port), JSON.stringify(await copies()));

    await clearCopies();
    await page.click('#addrCopyAll');
    await page.waitForTimeout(180);
    ok('点 ⧉ 复制出 IP:端口', (await copies()).join('|') === full, JSON.stringify(await copies()));

    // 真实剪贴板（权限可用时）
    const real = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    ok('真实剪贴板内容也是完整地址', real === null || real === full, `readText=${real}`);

    // ---------------------------------------------- 切换菜单
    await page.click('#addrPick');
    await page.waitForTimeout(150);
    ok('▾ 能打开地址菜单', await page.isVisible('#addrMenu'));
    const opts = await page.$$eval('.addr-opt', (els) =>
      els.map((e) => ({ ip: e.dataset.addr, label: e.querySelector('.ao-label').textContent.trim() }))
    );
    ok('菜单列出局域网地址', opts.some((o) => o.ip === lan), JSON.stringify(opts));
    ok('菜单也提供本机回环 127.0.0.1', opts.some((o) => o.ip === '127.0.0.1'));
    ok('菜单显示网卡信息', opts.some((o) => /·/.test(o.label)), JSON.stringify(opts.map((o) => o.label)));
    ok('当前局域网项被标记为选中', (await page.$$('.addr-opt.on')).length === 1);

    // 菜单里还有一组文字明确的复制按钮，不靠猜图标
    await clearCopies();
    await page.click('#addrMenu [data-copy="ip"]');
    await page.waitForTimeout(180);
    ok('菜单里「复制 IP」按钮可用', (await copies()).join('|') === lan, JSON.stringify(await copies()));
    ok('复制后菜单自动收起', !(await page.isVisible('#addrMenu')));
    await page.click('#addrPick');
    await page.waitForTimeout(150);
    await clearCopies();
    await page.click('#addrMenu [data-copy="all"]');
    await page.waitForTimeout(180);
    ok('菜单里「复制完整地址」按钮可用', (await copies()).join('|') === full);
    await page.click('#addrPick');
    await page.waitForTimeout(150);

    // ---------------------------------------------- 切到 127 后各处同步
    await page.click('.addr-opt[data-addr="127.0.0.1"]');
    await page.waitForTimeout(250);
    ok('切换后顶栏 IP 变成 127.0.0.1', (await text('#addrIp')) === '127.0.0.1');
    ok('切换后菜单自动收起', !(await page.isVisible('#addrMenu')));

    // 用页面内存触发空状态，不动服务端真实流量
    await page.evaluate(() => {
      S.flows = [];
      renderList();
    });
    await page.waitForTimeout(150);
    ok('空状态提示跟随切换后的地址', (await text('#emptyProxy')) === `127.0.0.1:${port}`, await text('#emptyProxy'));
    await page.evaluate(() => loadFlows());

    await page.click('#btnCa');
    await page.waitForTimeout(300);
    ok('连接向导手机代理地址同步', (await text('#caMobileProxy')) === `127.0.0.1:${port}`, await text('#caMobileProxy'));
    ok('证书安装页 URL 同步', (await text('#caUrl')) === `http://127.0.0.1:${port}/`, await text('#caUrl'));
    await page.click('#modalSettings [data-close]');
    await page.waitForTimeout(200);

    await page.click('#btnSettings');
    await page.waitForTimeout(400);
    ok('设置面板显示完整地址', (await text('#stAddrFull')) === `127.0.0.1:${port}`, await text('#stAddrFull'));
    ok('设置面板标注为本机回环', /本机回环/.test(await text('#stAddrKind')), await text('#stAddrKind'));
    ok('设置信息里也有代理地址', /代理地址\s*:/.test(await text('#stInfo')));

    await clearCopies();
    await page.click('#stCopyIp');
    await page.waitForTimeout(180);
    ok('设置里的复制 IP 按钮可用', (await copies()).join('|') === '127.0.0.1', JSON.stringify(await copies()));
    await clearCopies();
    await page.click('#stCopyPort');
    await page.waitForTimeout(180);
    ok('设置里的复制端口按钮可用', (await copies()).join('|') === String(port));
    await clearCopies();
    await page.click('#stCopyAll');
    await page.waitForTimeout(180);
    ok('设置里的复制完整地址按钮可用', (await copies()).join('|') === `127.0.0.1:${port}`);
    await page.click('#modalSettings [data-close]');
    await page.waitForTimeout(200);

    // ---------------------------------------------- 持久化 + 切回局域网
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    ok('选择写入 localStorage，刷新后仍保留', (await text('#addrIp')) === '127.0.0.1', await text('#addrIp'));

    await page.click('#addrPick');
    await page.waitForTimeout(150);
    await page.click(`.addr-opt[data-addr="${lan}"]`);
    await page.waitForTimeout(250);
    ok('能切回局域网 IP', (await text('#addrIp')) === lan, await text('#addrIp'));
    await page.evaluate(() => {
      S.flows = [];
      renderList();
    });
    await page.waitForTimeout(150);
    ok('空状态恢复成局域网地址', (await text('#emptyProxy')) === full, await text('#emptyProxy'));
    await page.evaluate(() => loadFlows());

    // ---------------------------------------------- 深色主题 + 窄屏
    await page.click('#btnTheme');
    await page.waitForTimeout(200);
    await page.click('#addrPick');
    await page.waitForTimeout(150);
    const menuStyle = await page.evaluate(() => {
      const m = document.querySelector('#addrMenu');
      const cs = getComputedStyle(m);
      return { bg: cs.backgroundColor, color: cs.color, visible: !m.hidden };
    });
    ok('深色主题下菜单有实底背景', menuStyle.bg !== 'rgba(0, 0, 0, 0)' && menuStyle.visible, JSON.stringify(menuStyle));
    await page.click('#addrPick');
    await page.click('#btnTheme');
    await page.waitForTimeout(150);

    await page.setViewportSize({ width: 800, height: 720 });
    await page.waitForTimeout(250);
    const narrow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      addrHidden: getComputedStyle(document.querySelector('#addrWrap')).display === 'none',
    }));
    ok('窄屏不产生横向溢出', narrow.scrollWidth <= narrow.innerWidth + 1, JSON.stringify(narrow));
    ok('窄屏顶栏胶囊按设计隐藏', narrow.addrHidden);
    await page.click('#btnSettings');
    await page.waitForTimeout(350);
    ok('窄屏仍可在设置里复制地址', await page.isVisible('#stCopyAll'));
    await page.click('#modalSettings [data-close]');

    ok('全程无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

  console.log('\n===== 顶栏地址自检 =====');
  for (const [name, pass, extra] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${name}${pass || !extra ? '' : '  → ' + extra}`);
  }
  const failed = checks.filter((c) => !c[1]);
  console.log(`\n结果: ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => {
  console.error('❌ 自检异常:', e.stack || e.message);
  process.exitCode = 1;
});
