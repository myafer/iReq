'use strict';

/**
 * 性能视图聚合（纯函数，可脱离网络单测）。
 *
 * 输入是 store.list() 的摘要，输出「按接口 / 按域名」的分组统计：
 * 请求数、P50、P95、平均值、最大值、错误率、传输量、最慢的一条。
 *
 * 几条口径，写死在代码里而不是 UI 里：
 *  - 进行中的请求不算进统计（它还没结束，计入会把 P95 拉成 0）；
 *  - 错误 = 没有响应（连不上 / 超时 / 被掐断）或 5xx；4xx 单独计数，
 *    它是「调用方写错了」，不该和「服务端挂了」混成一个错误率；
 *  - 百分位用 nearest-rank，样本少时也能给出真实存在的值，不插值。
 */

const DEFAULT_LIMIT = 200;
const DEFAULT_SLOWEST = 8;

/** 升序数组上的 nearest-rank 百分位 */
function percentile(sorted, p) {
  if (!sorted || !sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function isNoResponse(f) {
  return !!f.error || !f.status;
}

function isServerError(f) {
  return Number(f.status) >= 500;
}

function isClientError(f) {
  return Number(f.status) >= 400 && Number(f.status) < 500;
}

function groupKeyOf(f, by) {
  if (by === 'host') return f.host || '（未知主机）';
  return f.route || f.host || '（未知接口）';
}

/**
 * @param {Array} flows store.list() 的摘要数组
 * @param {{ by?: 'route'|'host', limit?: number, slowest?: number }} [opts]
 */
function aggregate(flows, opts = {}) {
  const by = opts.by === 'host' ? 'host' : 'route';
  const limit = Number(opts.limit) || DEFAULT_LIMIT;
  const slowestLimit = Number(opts.slowest) || DEFAULT_SLOWEST;

  const groups = new Map();
  const slow = [];
  const allDurations = [];
  let pending = 0;
  let total = 0;

  for (const f of flows || []) {
    if (!f) continue;
    if (f.pending) {
      pending += 1;
      continue;
    }
    const d = Number(f.duration);
    const duration = Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
    const key = groupKeyOf(f, by);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        host: f.host || '',
        methods: new Map(),
        count: 0,
        durations: [],
        noResponse: 0,
        serverErrors: 0,
        clientErrors: 0,
        bytes: 0,
        lastTs: 0,
        slowest: null,
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (f.method) g.methods.set(f.method, (g.methods.get(f.method) || 0) + 1);
    if (duration !== null) {
      g.durations.push(duration);
      allDurations.push(duration);
      if (!g.slowest || duration > g.slowest.duration) {
        g.slowest = { id: f.id, duration, status: f.status || 0, path: f.path || f.url || '' };
      }
      slow.push({
        id: f.id,
        method: f.method,
        url: f.url,
        path: f.path || f.url || '',
        host: f.host,
        route: f.route,
        status: f.status || 0,
        duration,
      });
    }
    if (isNoResponse(f)) g.noResponse += 1;
    else if (isServerError(f)) g.serverErrors += 1;
    else if (isClientError(f)) g.clientErrors += 1;
    g.bytes += Number(f.resSize) || 0;
    if (f.ts && f.ts > g.lastTs) g.lastTs = f.ts;
  }

  const out = [];
  for (const g of groups.values()) {
    const sorted = g.durations.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const errs = g.noResponse + g.serverErrors;
    const methods = [...g.methods.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m]) => m);
    out.push({
      key: g.key,
      host: g.host,
      methods,
      count: g.count,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      avg: sorted.length ? Math.round(sum / sorted.length) : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
      // 错误率 = （连不上 + 5xx）/ 总请求，保留一位小数
      errorRate: g.count ? Math.round((errs / g.count) * 1000) / 10 : 0,
      noResponse: g.noResponse,
      serverErrors: g.serverErrors,
      clientErrors: g.clientErrors,
      bytes: g.bytes,
      lastTs: g.lastTs || null,
      slowest: g.slowest,
    });
  }

  // 先按 P95，再按请求数：慢且高频的接口排最前，才是「在拖后腿」的
  out.sort((a, b) => (b.p95 || 0) - (a.p95 || 0) || b.count - a.count);
  const truncated = Math.max(0, out.length - limit);

  slow.sort((a, b) => b.duration - a.duration);
  const totalDur = allDurations.reduce((a, b) => a + b, 0);
  const totalSorted = allDurations.slice().sort((a, b) => a - b);
  const errTotal = out.reduce((a, g) => a + g.noResponse + g.serverErrors, 0);
  const count = allDurations.length;

  total = count;
  return {
    by,
    groups: out.slice(0, limit),
    groupCount: out.length,
    truncated,
    slowest: slow.slice(0, slowestLimit),
    totals: {
      count: total,
      pending,
      p50: percentile(totalSorted, 50),
      p95: percentile(totalSorted, 95),
      avg: count ? Math.round(totalDur / count) : null,
      errorRate: count ? Math.round((errTotal / count) * 1000) / 10 : 0,
    },
  };
}

module.exports = { aggregate, percentile, groupKeyOf, DEFAULT_LIMIT };
