'use strict';

/**
 * 会话总览：把当前这一屏流量压成一页能贴进工单的结论。
 *
 * 和性能视图的分工：性能视图回答「哪个接口慢」，总览回答「这次抓包整体是什么情况」，
 * 并且能直接导出成 Markdown —— 排障最后一步往往是「把结论发给别人」，
 * 而对着截图描述 P95 是一件很痛苦的事。
 *
 * 口径与 perf.js 保持一致（同一套 percentile / 错误定义），避免两个页面给出不同数字：
 *  - 进行中的请求不计入耗时统计
 *  - 错误 = 连不上 + 5xx；4xx 单独计数
 */

const { percentile } = require('./perf');
const { redactUrl, redactBodyText, normalize: normalizeRedact, lists: redactLists } = require('./redact');

const TOP_HOSTS = 6;
const TOP_ROUTES = 10;
const TOP_SLOW = 10;
const TOP_ERRORS = 15;
const TOP_LARGEST = 5;

function isNoResponse(f) {
  return !!f.error || !f.status;
}

function ms(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * @param {Array} flows store.list() 摘要数组（最新在前）
 * @param {{ redact?: object, columns?: Array }} [opts]
 */
function build(flows, opts = {}) {
  const list = (flows || []).filter(Boolean);
  const cfg = normalizeRedact(opts.redact);
  const counter = { n: 0, parts: new Set() };
  const redactedUrls = new Set();
  const scrubUrl = (u) => {
    const raw = String(u || '');
    if (!cfg.enabled || !cfg.query) return raw;
    const out = redactUrl(raw, redactLists(cfg), counter);
    // 同一个 URL 会出现在「失败 / 最慢 / 域名」几张表里，按条数计才有意义
    if (out !== raw) redactedUrls.add(raw);
    return out;
  };
  const scrubText = (t) => {
    if (!cfg.enabled || !cfg.body || !t) return t || '';
    return redactBodyText(String(t), 'text/plain', redactLists(cfg).fields, counter);
  };

  const durations = [];
  const status = new Map();
  const hosts = new Map();
  const routes = new Map();
  const types = new Map();
  const slowest = [];
  const largest = [];
  const errors = [];
  let pending = 0;
  let noResponse = 0;
  let server = 0;
  let client = 0;
  let mocked = 0;
  let ws = 0;
  let sse = 0;
  let tunneled = 0;
  let reqBytes = 0;
  let resBytes = 0;
  let minTs = 0;
  let maxTs = 0;

  for (const f of list) {
    const ts = Number(f.ts) || 0;
    if (ts) {
      if (!minTs || ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (f.mocked) mocked += 1;
    if (f.ws) ws += 1;
    if (f.sseCount) sse += 1;
    if (f.tunneled) tunneled += 1;
    reqBytes += Number(f.reqSize) || 0;
    resBytes += Number(f.resSize) || 0;

    const code = Number(f.status) || 0;
    const skey = f.error && !code ? 'ERR' : code ? String(code) : '…';
    status.set(skey, (status.get(skey) || 0) + 1);

    const host = f.host || '（未知主机）';
    const h = hosts.get(host) || { host, count: 0, bytes: 0, errors: 0 };
    h.count += 1;
    h.bytes += Number(f.resSize) || 0;
    if (isNoResponse(f) || code >= 500) h.errors += 1;
    hosts.set(host, h);

    const route = f.route || `${f.method || 'GET'} ${host}`;
    const r = routes.get(route) || { route: scrubUrl(route), count: 0, durations: [], errors: 0, bytes: 0 };
    r.count += 1;
    r.bytes += Number(f.resSize) || 0;

    const ct = String(f.resContentType || '').split(';')[0].trim().toLowerCase();
    if (ct) types.set(ct, (types.get(ct) || 0) + 1);

    // 首次见到这个接口就登记，做「按接口」的统计时不用再回头补
    if (!routes.has(route)) routes.set(route, r);

    if (f.pending) {
      pending += 1;
      continue;
    }
    const d = ms(f.duration);
    if (d !== null) {
      durations.push(d);
      r.durations.push(d);
      slowest.push({
        id: f.id,
        method: f.method,
        url: scrubUrl(f.url || f.path || ''),
        status: code || null,
        duration: d,
        ts,
        error: scrubText(f.error || ''),
      });
    }
    if (isNoResponse(f)) {
      noResponse += 1;
      r.errors += 1;
      errors.push({ ts, method: f.method, url: scrubUrl(f.url || f.path || ''), status: null, duration: d, error: scrubText(f.error || '连不上') });
    } else if (code >= 500) {
      server += 1;
      r.errors += 1;
      errors.push({ ts, method: f.method, url: scrubUrl(f.url || f.path || ''), status: code, duration: d, error: scrubText(f.statusText || '') });
    } else if (code >= 400) {
      client += 1;
      errors.push({ ts, method: f.method, url: scrubUrl(f.url || f.path || ''), status: code, duration: d, error: scrubText(f.statusText || '') });
    }

    largest.push({
      id: f.id,
      method: f.method,
      url: scrubUrl(f.url || f.path || ''),
      size: Number(f.resSize) || 0,
      status: code || null,
    });
    routes.set(route, r);
  }

  durations.sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);

  const routeRows = [...routes.values()]
    .map((r) => {
      const ds = r.durations.slice().sort((a, b) => a - b);
      return {
        route: r.route,
        count: r.count,
        p50: percentile(ds, 50),
        p95: percentile(ds, 95),
        max: ds.length ? ds[ds.length - 1] : null,
        errors: r.errors,
        errorRate: pct(r.errors, r.count),
        bytes: r.bytes,
      };
    })
    .sort((a, b) => (b.p95 || 0) - (a.p95 || 0) || b.count - a.count);

  const completed = list.length - pending;
  const errorTotal = noResponse + server;

  return {
    generatedAt: Date.now(),
    version: opts.version || '',
    counts: {
      total: list.length,
      completed,
      pending,
      errors: errorTotal,
      noResponse,
      server,
      client,
      mocked,
      ws,
      sse,
      tunneled,
      errorRate: pct(errorTotal, completed),
    },
    duration: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length ? durations[durations.length - 1] : null,
      avg: durations.length ? Math.round(sum / durations.length) : null,
    },
    bytes: { req: reqBytes, res: resBytes, total: reqBytes + resBytes },
    span: { from: minTs || null, to: maxTs || null, seconds: minTs && maxTs ? Math.round((maxTs - minTs) / 100) / 10 : null },
    status: [...status.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    hosts: [...hosts.values()].sort((a, b) => b.count - a.count).slice(0, TOP_HOSTS),
    routes: routeRows.slice(0, TOP_ROUTES),
    slowest: slowest.sort((a, b) => b.duration - a.duration).slice(0, TOP_SLOW),
    largest: largest.sort((a, b) => b.size - a.size).slice(0, TOP_LARGEST),
    errors: errors.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, TOP_ERRORS),
    contentTypes: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    redactions: redactedUrls.size,
    truncated: routes.size > TOP_ROUTES,
  };
}

/* ---------------- Markdown ---------------- */

function statusLabel(key) {
  if (key === 'ERR') return '连不上';
  if (key === '…') return '进行中';
  return String(key);
}

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${Math.round(v)} ms`;
}

function fmtBytes(v) {
  const n = Number(v) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cell(v) {
  // 表格里的竖线与换行会把 Markdown 撑破
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * 生成 Markdown。刻意不写「建议」类结论 —— 工具只陈述它看到的事实，
 * 判断留给看报告的人，否则报告会被当成「诊断结论」引用。
 */
function toMarkdown(ov, opts = {}) {
  const c = ov.counts;
  const d = ov.duration;
  const lines = [];
  const title = opts.title || 'iReq 抓包报告';
  lines.push(`# ${title} · ${fmtClock(ov.generatedAt)}`, '');

  const filters = (opts.filters || []).filter(Boolean);
  lines.push(filters.length ? `**筛选**：${filters.join(' · ')}` : '**筛选**：无（全部流量）');
  if (ov.span.seconds !== null) lines.push(`**时间范围**：${fmtClock(ov.span.from)} → ${fmtClock(ov.span.to)}（${ov.span.seconds}s）`);
  lines.push('');

  lines.push('## 概要', '', '| 指标 | 值 |', '| --- | --- |');
  lines.push(`| 请求数 | ${c.total}（已完成 ${c.completed}${c.pending ? ` / 进行中 ${c.pending}` : ''}） |`);
  lines.push(
    `| 错误 | ${c.errors}（${c.errorRate}%）：5xx ${c.server} · 连不上 ${c.noResponse} |`
  );
  lines.push(`| 4xx（调用方问题） | ${c.client} |`);
  lines.push(`| 耗时 | P50 ${fmtMs(d.p50)} · P95 ${fmtMs(d.p95)} · 最慢 ${fmtMs(d.max)} · 平均 ${fmtMs(d.avg)} |`);
  lines.push(`| 传输 | ${fmtBytes(ov.bytes.total)}（响应 ${fmtBytes(ov.bytes.res)} / 请求 ${fmtBytes(ov.bytes.req)}）|`);
  const extra = [];
  if (c.mocked) extra.push(`Mock ${c.mocked}`);
  if (c.ws) extra.push(`WebSocket ${c.ws}`);
  if (c.sse) extra.push(`SSE ${c.sse}`);
  if (c.tunneled) extra.push(`隧道 ${c.tunneled}`);
  if (extra.length) lines.push(`| 其他 | ${extra.join(' · ')} |`);
  lines.push('');

  if (ov.routes.length) {
    lines.push('## 接口（按 P95 从慢到快）', '', '| 接口 | 次数 | P50 | P95 | 最大 | 错误 | 传输 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of ov.routes) {
      lines.push(
        `| \`${cell(r.route)}\` | ${r.count} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.max)} | ${
          r.errors ? `${r.errors}（${r.errorRate}%）` : '—'
        } | ${fmtBytes(r.bytes)} |`
      );
    }
    if (ov.truncated) lines.push('', `_只列最慢的 ${ov.routes.length} 个接口。_`);
    lines.push('');
  }

  if (ov.errors.length) {
    lines.push('## 失败的请求', '', '| 时间 | 接口 | 状态 | 耗时 | 说明 |', '| --- | --- | --- | --- | --- |');
    for (const e of ov.errors) {
      lines.push(
        `| ${fmtClock(e.ts)} | \`${cell(e.url)}\` | ${e.status || 'ERR'} | ${fmtMs(e.duration)} | ${cell(e.error) || '—'} |`
      );
    }
    lines.push('');
  }

  if (ov.slowest.length) {
    lines.push('## 最慢的请求', '', '| 耗时 | 请求 | 状态 |', '| --- | --- | --- |');
    for (const s of ov.slowest) {
      lines.push(`| ${fmtMs(s.duration)} | \`${s.method || ''} ${cell(s.url)}\` | ${s.status || 'ERR'} |`);
    }
    lines.push('');
  }

  if (ov.hosts.length) {
    lines.push('## 域名', '', '| 域名 | 请求数 | 错误 | 响应量 |', '| --- | --- | --- | --- |');
    for (const h of ov.hosts) lines.push(`| \`${cell(h.host)}\` | ${h.count} | ${h.errors || '—'} | ${fmtBytes(h.bytes)} |`);
    lines.push('');
  }

  if (ov.status.length) {
    lines.push('## 状态分布', '');
    lines.push(ov.status.map((s) => `${statusLabel(s.key)} × ${s.count}`).join(' · '), '');
  }

  const tail = [`_由 iReq ${ov.version || ''} 生成_`.replace('  ', ' ')];
  if (ov.redactions) tail.push(`已按脱敏配置打码 ${ov.redactions} 处（凭据类头部 / 查询参数 / 正文字段）`);
  lines.push('---', '', tail.join('；'));
  return lines.join('\n') + '\n';
}

module.exports = { build, toMarkdown, fmtMs, fmtBytes, statusLabel };
