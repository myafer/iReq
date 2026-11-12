'use strict';

/**
 * 自检：握手失败的域名实时进主列表（连接层诊断行）。
 *
 * 只造「CONNECT 后立刻断开」的握手失败，不依赖外网；结束前恢复 passthrough 配置。
 * 会清空流量 / 诊断数据，所以在一键回归里排在最后。
 */
const net = require('net');
const { UI, PROXY_PORT } = require('./_env');
const { chromium, EXEC } = require('./_pw');

const HOST = 'pinned.example.test';
let pass = 0;
let total = 0;

function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
}

function abruptHandshake() {
  return new Promise((resolve) => {
    const sock = net.connect(PROXY_PORT, '127.0.0.1');
    sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
    sock.once('data', () => { sock.destroy(); resolve('reset'); });
    sock.on('error', () => resolve('error'));
    setTimeout(() => { sock.destroy(); resolve('timeout'); }, 3000);
  });
}

async function api(pathname, options = {}) {
  const res = await fetch(UI + pathname, options);
  return res.json();
}

(async () => {
  const before = await api('/api/config');
  const savedPassthrough = before.passthrough || [];
  await api('/api/diagnostics', { method: 'DELETE' });
  await api('/api/flows', { method: 'DELETE' });

  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  try {
    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof S !== 'undefined' && !!document.querySelector('#tlsCount'),
      null,
      { timeout: 12000 }
    );
    await page.waitForTimeout(600);

    ok('初始没有诊断行', (await page.locator('.row.tls').count()) === 0);
    ok('初始角标隐藏', await page.locator('#tlsCount').isHidden());

    await Promise.all([abruptHandshake(), abruptHandshake(), abruptHandshake()]);
    // 握手完成前的 EOF 会被 Node 静默吞掉，要等 handshakeTimeout(8s) 兜底报 tlsClientError 才有记录
    await page
      .waitForFunction(() => document.querySelectorAll('.row.tls').length > 0, null, { timeout: 12000 })
      .catch(() => {});

    const rows = await page.locator('.row.tls').count();
    ok('SSE 实时出现诊断行（无需刷新）', rows === 1, 'rows=' + rows);
    const text = rows ? await page.locator('.row.tls').first().innerText() : '';
    ok('诊断行按域名聚合并显示次数', /3 次握手失败/.test(text), JSON.stringify(text.replace(/\n/g, ' ')));
    const badge = Number((await page.locator('#tlsCount').innerText()).trim());
    ok('筛选按钮角标显示数量', badge >= 1, 'badge=' + badge);
    const countText = (await page.locator('#count').innerText()).trim();
    const domRows = await page.locator('#list .row').count();
    ok(
      '列表计数与实际行数一致',
      Number(countText.replace(/\D/g, '')) === domRows,
      countText + ' / ' + domRows
    );

    const diag = await api('/api/diagnostics');
    ok(
      '后端按域名聚合、重试不刷屏',
      (diag.tlsFailures || []).length === 1 && diag.tlsFailures[0].count >= 3,
      JSON.stringify(diag.tlsFailures)
    );

    await page.locator('.row.tls').first().click();
    await page.waitForTimeout(180);
    ok('详情显示失败原因', (await page.locator('#detail .tls-error').count()) === 1);
    ok('详情有一键透传按钮', (await page.locator('#detail [data-block-host]').count()) === 1);
    ok('诊断行有忽略按钮', (await page.locator('.row.tls [data-tls-dismiss]').count()) === 1);

    await page.evaluate(() => window.ReqLiteI18N.setLang('en'));
    await page.waitForTimeout(400);
    const enRow = await page.locator('.row.tls').first().innerText();
    ok('英文模式诊断行无中文残留', !/[\u4e00-\u9fff]/.test(enRow), JSON.stringify(enRow.replace(/\n/g, ' ')));
    const enBtn = await page.locator('#filters button[data-status="tls"]').innerText();
    ok('英文模式筛选按钮已翻译', /Handshake/i.test(enBtn));
    await page.evaluate(() => window.ReqLiteI18N.setLang('auto'));

    await page.click('#filters button[data-status="tls"]');
    await page.waitForTimeout(180);
    ok(
      '「握手失败」筛选只显示诊断行',
      (await page.locator('#list .row').count()) === 1 && (await page.locator('#list .row.tls').count()) === 1
    );

    // 加入跳过解密 = 这个失败已被处理，诊断行必须从列表顶部和后端一起消失
    await page.locator('#detail [data-block-host]').click();
    await page.waitForTimeout(350);
    const cfg = await api('/api/config');
    ok('一键加入跳过解密生效', (cfg.passthrough || []).includes(HOST), JSON.stringify(cfg.passthrough));
    ok('诊断行立即消失', (await page.locator('.row.tls').count()) === 0);
    ok('「握手失败」视图同步变空', (await page.locator('#list .row').count()) === 0);
    ok('角标归零并隐藏', await page.locator('#tlsCount').isHidden());
    const diagAfter = await api('/api/diagnostics');
    ok('后端诊断记录同步清除', (diagAfter.tlsFailures || []).length === 0, JSON.stringify(diagAfter.tlsFailures));

    ok('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    await browser.close();
    await api('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passthrough: savedPassthrough }),
    });
    await api('/api/diagnostics', { method: 'DELETE' });
  }

  console.log(`共 ${total} 项，通过 ${pass} 项`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
