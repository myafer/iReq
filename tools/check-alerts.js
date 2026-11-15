'use strict';

/**
 * 自检：条件告警
 * ---------------------------------------------------------------------------
 * ① 规则归一化：没名字的丢掉、条数封顶、冷却有默认值
 * ② 匹配：域名（含 * 通配）/ 方法 / URL 包含 / 状态码语义 / body 包含 / 耗时阈值
 * ③ 冷却：同一条规则连着命中只提醒一次
 * ④ 静音：全局静音期间一条都不发；关掉总开关也一样
 * ⑤ 限速：一分钟内最多 20 条
 * ⑥ 端到端：经代理打一条 500，SSE 能收到 alert；冷却期内第二条不发
 * ⑦ 接口：GET / PUT / mute 往返
 * ⑧ 界面：铃铛角标、规则列表、最近触发
 *
 * 会改告警配置并清空流量，结束时恢复原配置、删掉自己造的历史记录。
 */
const http = require('http');
const { normalizeAlerts, ruleMatches, Alerts, MAX_PER_MINUTE } = require('../src/alerts');
const { UI, PROXY_PORT } = require('./_env');

let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra !== undefined ? '  ' + extra : ''));
}

const jsonApi = async (p, opts = {}) => {
  const res = await fetch(UI + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ ①-⑤ 单元 */
{
  const cfg = normalizeAlerts({
    enabled: true,
    rules: [
      { name: '', status: '500' },
      { name: '五零', status: '5xx', cooldownMs: 10 },
      { name: '很慢', minDuration: '800' },
    ],
  });
  ok('没名字的规则被丢掉', cfg.rules.length === 2, cfg.rules.length);
  ok('冷却有下限（不会配成 10ms 刷屏）', cfg.rules[0].cooldownMs >= 1000, cfg.rules[0].cooldownMs);
  ok('耗时阈值转成数字', cfg.rules[1].minDuration === 800, cfg.rules[1].minDuration);

  const many = normalizeAlerts({ rules: Array.from({ length: 30 }, (_, i) => ({ name: 'r' + i })) });
  ok('规则条数封顶', many.rules.length === 20, many.rules.length);

  const flow = {
    host: 'api.example.com',
    method: 'GET',
    url: 'https://api.example.com/v1/login?x=1',
    status: 500,
    duration: 1200,
    resBody: '{"error":"boom"}',
    reqBody: '{"user":"a"}',
  };
  ok('域名精确匹配', ruleMatches({ host: 'api.example.com' }, flow));
  ok('域名不匹配', !ruleMatches({ host: 'other.com' }, flow));
  ok('* 通配子域', ruleMatches({ host: '*.example.com' }, flow));
  ok('方法匹配', ruleMatches({ method: 'GET' }, flow) && !ruleMatches({ method: 'POST' }, flow));
  ok('URL 包含', ruleMatches({ url: '/v1/login' }, flow) && !ruleMatches({ url: '/v2' }, flow));
  ok('5xx 语义', ruleMatches({ status: '5xx' }, flow) && !ruleMatches({ status: '4xx' }, flow));
  ok('精确状态码', ruleMatches({ status: '500' }, flow) && !ruleMatches({ status: '500' }, { ...flow, status: 501 }));
  ok('连不上也算 error', ruleMatches({ status: 'error' }, { ...flow, status: 0, error: 'x' }));
  ok('body 包含（响应体）', ruleMatches({ body: 'BOOM' }, flow));
  ok('body 包含（请求体）', ruleMatches({ body: 'user' }, flow));
  ok('耗时阈值', ruleMatches({ minDuration: 1000 }, flow) && !ruleMatches({ minDuration: 2000 }, flow));
  ok('多个条件是与关系', ruleMatches({ status: '5xx', url: '/v1/login' }, flow) && !ruleMatches({ status: '5xx', url: '/v2' }, flow));

  const engine = new Alerts({ alerts: { enabled: true, rules: [{ id: 'r1', name: '五零', status: '5xx', cooldownMs: 60000 }] } });
  const first = engine.evaluate(flow);
  const second = engine.evaluate(flow);
  ok('第一次命中', first.length === 1 && first[0].ruleId === 'r1', JSON.stringify(first));
  ok('冷却期内不重复提醒', second.length === 0);
  ok('告警里带 flow 摘要', first[0].flow && first[0].flow.status === 500 && first[0].flow.url === flow.url);

  engine.mute(5);
  ok('静音后不再命中', engine.evaluate({ ...flow, status: 503 }).length === 0);
  engine.mute(0);

  const off = new Alerts({ alerts: { enabled: false, rules: [{ id: 'r1', name: 'x', status: '5xx' }] } });
  ok('总开关关掉后不命中', off.evaluate(flow).length === 0);

  // 限速：不同规则各命中一次，超过每分钟上限就停
  const rules = Array.from({ length: 25 }, (_, i) => ({ id: 'r' + i, name: 'r' + i, enabled: true, cooldownMs: 1000 }));
  const limiter = new Alerts({ alerts: { enabled: true, rules } });
  let fired = 0;
  for (let i = 0; i < 3; i++) fired += limiter.evaluate({ ...flow, id: 'f' + i }).length;
  ok('一分钟内总数有上限', fired <= MAX_PER_MINUTE && fired > 0, fired);
}

/* ------------------------------------------------------------ ⑥⑦ 接口 */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url || '';
      if (u.startsWith('/boom')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"boom"}');
      }
      if (u.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('nope');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function viaProxy(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: `http://127.0.0.1:${port}${path}`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

/** 收 SSE 里的 alert 事件，收到 n 条或超时就返回 */
function collectAlerts(ms = 3000, want = 1) {
  return new Promise((resolve) => {
    const got = [];
    const req = http.get(UI + '/api/events', (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.type === 'alert') {
              got.push(msg.alert);
              if (got.length >= want) {
                req.destroy();
                resolve(got);
                return;
              }
            }
          } catch (_) {
            /* 忽略坏行 */
          }
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => {
      req.destroy();
      resolve(got);
    }, ms);
  });
}

async function historyIds() {
  const r = await jsonApi('/api/history');
  const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list)) || [];
  return new Set(list.map((x) => x.id));
}

(async () => {
  const before = await historyIds();
  const orig = await jsonApi('/api/alerts');
  const origCfg = { enabled: (orig.body && orig.body.enabled) !== false, rules: (orig.body && orig.body.rules) || [] };
  const srv = await startUpstream();
  const port = srv.address().port;

  const saved = await jsonApi('/api/alerts', {
    method: 'PUT',
    body: {
      enabled: true,
      rules: [{ name: '服务端 5xx', status: '5xx', cooldownMs: 60000, enabled: true }],
    },
  });
  ok('PUT 保存规则', saved.status === 200 && saved.body.rules.length === 1, saved.body && saved.body.rules.length);
  const got = await jsonApi('/api/alerts');
  ok('GET 拿回规则', got.body.rules.length === 1 && got.body.rules[0].name === '服务端 5xx');

  // 先挂上 SSE 再打流量，避免事件在订阅前就发完
  const waiting = collectAlerts(4000, 1);
  await wait(120);
  await viaProxy(port, '/boom');
  const alerts = await waiting;
  ok('命中 5xx 后收到 alert', alerts.length === 1, alerts.length);
  ok('alert 带规则名与请求信息', alerts[0] && alerts[0].name === '服务端 5xx' && alerts[0].flow.status === 500,
    alerts[0] && `${alerts[0].name} ${alerts[0].flow.status}`);

  // 冷却期内再来一条，不该再提醒
  const waiting2 = collectAlerts(1200, 1);
  await viaProxy(port, '/boom?again=1');
  const second = await waiting2;
  ok('冷却期内不重复提醒', second.length === 0, second.length);

  // 静音
  const muted = await jsonApi('/api/alerts/mute', { method: 'POST', body: { minutes: 5 } });
  ok('静音接口返回恢复时间', muted.body && muted.body.mutedUntil > Date.now(), muted.body && muted.body.mutedUntil);
  const waiting3 = collectAlerts(1200, 1);
  await viaProxy(port, '/boom?muted=1');
  const third = await waiting3;
  ok('静音期间不提醒', third.length === 0, third.length);
  await jsonApi('/api/alerts/mute', { method: 'POST', body: { minutes: 0 } });

  /* ---------------- ⑧ 界面 ---------------- */
  {
    // 换一条不会进冷却的规则给界面用（404）
    await jsonApi('/api/alerts', {
      method: 'PUT',
      body: {
        enabled: true,
        rules: [
          { name: '服务端 5xx', status: '5xx', cooldownMs: 60000, enabled: true },
          { name: '页面 404', url: '/missing', status: '404', cooldownMs: 60000, enabled: true },
        ],
      },
    });
    const waitingUi = collectAlerts(3000, 1);
    await viaProxy(port, '/missing');
    const uiAlert = await waitingUi;
    ok('404 规则也能命中', uiAlert.length === 1, uiAlert.length);

    const { chromium, EXEC } = require('./_pw');
    const browser = await chromium.launch({ executablePath: EXEC });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row');
    await page.keyboard.press('Escape');
    await page.click('#btnAlerts');
    await page.waitForSelector('#modalAlerts:not([hidden])');
    const rules = await page.$$eval('#alRules .al-rule', (els) => els.length);
    ok('面板列出两条规则', rules === 2, rules);
    const enabled = await page.$eval('#alEnabled', (el) => el.checked);
    ok('总开关是开着的', enabled === true);
    // 触发一条：角标 + 最近触发
    await page.click('#modalAlerts [data-close]');
    await page.waitForTimeout(150);
    // 重新 PUT 同一份规则会把冷却记录清掉，否则刚才那条 404 还在冷却里
    await jsonApi('/api/alerts', {
      method: 'PUT',
      body: {
        enabled: true,
        rules: [
          { name: '服务端 5xx', status: '5xx', cooldownMs: 60000, enabled: true },
          { name: '页面 404', url: '/missing', status: '404', cooldownMs: 60000, enabled: true },
        ],
      },
    });
    await viaProxy(port, '/missing?ui=1');
    await page.waitForTimeout(700);
    const badge = await page.$eval('#alertCount', (el) => ({ hidden: el.hidden, text: el.textContent }));
    ok('铃铛角标出现', badge.hidden === false && Number(badge.text) >= 1, JSON.stringify(badge));
    await page.click('#btnAlerts');
    await page.waitForSelector('#modalAlerts:not([hidden])');
    const rows = await page.$$eval('#alList .al-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok('最近触发里有记录', rows.some((r) => r.includes('页面 404')), rows.join(' | '));
    ok('界面无脚本报错', errs.length === 0, errs.join(' | '));
    await browser.close();
  }

  /* ---------------- 清理 ---------------- */
  await jsonApi('/api/alerts', { method: 'PUT', body: origCfg });
  await jsonApi('/api/alerts/mute', { method: 'POST', body: { minutes: 0 } });
  srv.close();
  await jsonApi('/api/flows', { method: 'DELETE' });
  const after = await historyIds();
  for (const id of after) {
    if (!before.has(id)) await fetch(UI + '/api/history/' + id, { method: 'DELETE' }).catch(() => {});
  }

  console.log(`\n${pass}/${total} 项通过`);
  process.exitCode = pass === total ? 0 : 1;
})().catch((err) => {
  console.error('自检异常:', err && err.message);
  process.exitCode = 1;
});
