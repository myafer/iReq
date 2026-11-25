'use strict';
const { UI_PORT, PROXY_PORT, UI } = require('./_env');
const { chromium, EXEC } = require('./_pw');
const { seedFlows } = require('./_seed');
const http = require('http');

/**
 * 详情页的两件事：
 *   1. URL 最多显示两行，超出给「展开」，展开后能「收起」；旁边有复制按钮
 *   2. 详情里能搜索（请求头 / 响应头 / 正文都是文本，靠 <mark> 高亮 + 命中数）
 *
 * 会造一条超长 URL 的流量（走代理端口，保证是真 flow），不改任何配置。
 */
const checks = [];
const ok = (name, pass, extra) => checks.push([name, !!pass, extra]);

function longUrlFlow() {
  const q = Array.from({ length: 16 }, (_, i) => `f${i}=value_${i}`).join('&');
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(process.env.REQLITE_PROXY_PORT) || 9090,
        path: `http://demo.example.test/api/v1/cards?tabCode=subject_9&${q}`,
        headers: { host: 'demo.example.test' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', resolve);
    req.end();
  });
}

(async () => {
  await seedFlows();
  await longUrlFlow();
  await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch({ executablePath: EXEC });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.click('.row:has-text("/api/v1/cards")');
    await page.waitForTimeout(600);

    /* ---------- URL：两行折叠 / 展开 / 复制 ---------- */
    const head = await page.evaluate(() => {
      const u = document.querySelector('#detailUrl');
      const more = document.querySelector('#detailUrlMore');
      const before = u ? Math.round(u.getBoundingClientRect().height) : 0;
      return {
        len: u ? u.textContent.length : 0,
        clamped: u ? u.classList.contains('clamp2') : false,
        h: before,
        moreVisible: more ? !more.hidden : false,
        copy: !!document.querySelector('#copyUrl'),
        search: !!document.querySelector('#detailSearch'),
      };
    });
    ok('长 URL 默认折成两行', head.len > 120 && head.clamped, `${head.len} 字符 / 高 ${head.h}px`);
    ok('出现「展开」按钮', head.moreVisible);
    ok('URL 旁边有复制按钮', head.copy);
    ok('页签行有搜索框', head.search);

    await page.click('#detailUrlMore');
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => ({
      clamped: document.querySelector('#detailUrl').classList.contains('clamp2'),
      text: document.querySelector('#detailUrlMore').textContent.trim(),
      h: Math.round(document.querySelector('#detailUrl').getBoundingClientRect().height),
    }));
    ok('点展开后不再截断', !opened.clamped && opened.h > head.h, `${head.h}px → ${opened.h}px`);
    ok('展开后按钮变「收起」', opened.text === '收起', opened.text);

    /* ---------- 详情内搜索 ---------- */
    await page.click('#tabs button[data-tab="request"]');
    await page.waitForTimeout(400);
    await page.fill('#detailSearch', 'host');
    await page.waitForTimeout(300);
    const hit = await page.evaluate(() => ({
      marks: document.querySelectorAll('mark.dhit').length,
      count: (document.querySelector('#detailSearchCount') || {}).textContent || '',
    }));
    ok('请求页能搜到 Host 并高亮', hit.marks >= 1, JSON.stringify(hit));
    ok('显示命中数量', /\d+\s*处/.test(hit.count), hit.count);

    await page.click('#tabs button[data-tab="overview"]');
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => ({
      val: (document.querySelector('#detailSearch') || {}).value,
      marks: document.querySelectorAll('mark.dhit').length,
      count: (document.querySelector('#detailSearchCount') || {}).textContent || '',
    }));
    ok('切页签保留搜索词', kept.val === 'host', JSON.stringify(kept));
    ok('没有命中的页签明确说「无匹配」', kept.count === '无匹配', kept.count);

    // 换一条流量：搜索清空，避免把上一条的关键词带到新请求里
    await page.click('.row:has-text("/api/v1/users/42")');
    await page.waitForTimeout(600);
    const cleared = await page.evaluate(() => ({
      val: (document.querySelector('#detailSearch') || {}).value,
      marks: document.querySelectorAll('mark.dhit').length,
    }));
    ok('换流量后搜索框清空', cleared.val === '' && cleared.marks === 0, JSON.stringify(cleared));
    ok('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    await browser.close();
  }

  console.log('\n--- 结果 ---');
  for (const [name, pass, extra] of checks) console.log(`${pass ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  const fails = checks.filter(([, p]) => !p).length;
  console.log(`\n共 ${checks.length} 项，通过 ${checks.length - fails} 项`);
  if (fails) process.exitCode = 1;
})();
