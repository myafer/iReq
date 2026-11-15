'use strict';

/**
 * 条件告警：等「某个状态码 / 某个字段 / 某条慢请求」出现，命中就提醒。
 *
 * 这类功能最怕变成噪音源，所以从一开始就带三道闸：
 *  1. 每条规则自己的冷却时间（默认 15s）：同一个问题连着来不会刷屏；
 *  2. 全局每分钟上限 20 条：规则配错也不会把控制台顶爆；
 *  3. 全局静音：临时不想看时一键关掉，规则保留。
 *
 * 纯逻辑 + 一个很小的状态机，脱离网络就能单测。
 */

const MAX_RULES = 20;
const MAX_PER_MINUTE = 20;
const DEFAULT_COOLDOWN = 15000;

const { matchStatus } = require('./store');

/** 配置归一化：脏数据一律丢掉，别让一个坏规则把整个告警关掉 */
function normalizeAlerts(input) {
  const src = input && typeof input === 'object' ? input : {};
  const rules = Array.isArray(src.rules) ? src.rules : [];
  const out = [];
  for (const r of rules) {
    if (!r) continue;
    const name = String(r.name || '').trim().slice(0, 40);
    if (!name) continue;
    out.push({
      id: String(r.id || `al${out.length + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `al${out.length + 1}`,
      name,
      enabled: r.enabled !== false,
      host: String(r.host || '').trim().slice(0, 120),
      url: String(r.url || '').trim().slice(0, 200),
      method: String(r.method || '').trim().toUpperCase().slice(0, 10),
      // 状态码沿用筛选条那套语义：4xx / 5xx / 200 / error
      status: String(r.status || '').trim().slice(0, 5),
      body: String(r.body || '').trim().slice(0, 120),
      minDuration: Math.max(0, Number(r.minDuration) || 0),
      cooldownMs: Math.min(3600000, Math.max(1000, Number(r.cooldownMs) || DEFAULT_COOLDOWN)),
    });
    if (out.length >= MAX_RULES) break;
  }
  return { enabled: src.enabled !== false, rules: out };
}

function hostMatches(rule, host) {
  if (!rule.host) return true;
  const h = String(host || '').toLowerCase();
  const want = rule.host.toLowerCase();
  if (want.startsWith('*.')) return h === want.slice(2) || h.endsWith(want.slice(1));
  return h === want;
}

/** 一条规则是否命中：留空的字段表示「不限」 */
function ruleMatches(rule, flow) {
  if (!rule || !flow) return false;
  if (!hostMatches(rule, flow.host)) return false;
  if (rule.method && String(flow.method || '').toUpperCase() !== rule.method) return false;
  if (rule.url && !String(flow.url || '').toLowerCase().includes(rule.url.toLowerCase())) return false;
  if (rule.status && !matchStatus(flow, rule.status)) return false;
  if (rule.minDuration && Number(flow.duration) < rule.minDuration) return false;
  if (rule.body) {
    const needle = rule.body.toLowerCase();
    const hay = `${flow.resBody || ''}\n${flow.reqBody || ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

class Alerts {
  constructor(config) {
    this.config = config || {};
    this.lastFired = new Map();
    this.recent = [];
    this.mutedUntil = 0;
  }

  settings() {
    return normalizeAlerts(this.config.alerts);
  }

  set(body) {
    const next = normalizeAlerts(body);
    this.config.alerts = next;
    // 规则换了就清掉冷却记录：新规则不该被旧规则的冷却拖住
    this.lastFired.clear();
    return next;
  }

  mute(minutes) {
    const m = Math.min(24 * 60, Math.max(0, Number(minutes) || 0));
    this.mutedUntil = m ? Date.now() + m * 60000 : 0;
    return this.mutedUntil;
  }

  status() {
    const s = this.settings();
    return {
      enabled: s.enabled,
      rules: s.rules,
      mutedUntil: this.mutedUntil || 0,
      muted: !!(this.mutedUntil && Date.now() < this.mutedUntil),
      maxPerMinute: MAX_PER_MINUTE,
    };
  }

  /**
   * 评估一条已完成的 flow，返回要提醒的项。
   * 调用方负责把结果推给界面；这里只保证「不重复轰炸」。
   */
  evaluate(flow) {
    const s = this.settings();
    if (!s.enabled || !flow || flow.pending) return [];
    if (this.mutedUntil && Date.now() < this.mutedUntil) return [];

    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60000);
    if (this.recent.length >= MAX_PER_MINUTE) return [];

    const hits = [];
    for (const rule of s.rules) {
      if (!rule.enabled) continue;
      if (!ruleMatches(rule, flow)) continue;
      const last = this.lastFired.get(rule.id) || 0;
      if (now - last < rule.cooldownMs) continue;
      this.lastFired.set(rule.id, now);
      this.recent.push(now);
      hits.push({
        ruleId: rule.id,
        name: rule.name,
        at: now,
        flow: {
          id: flow.id,
          method: flow.method,
          url: flow.url,
          host: flow.host,
          path: flow.path,
          status: flow.status,
          duration: flow.duration,
          app: flow.app,
        },
      });
      if (hits.length >= 5 || this.recent.length >= MAX_PER_MINUTE) break;
    }
    return hits;
  }
}

module.exports = { Alerts, normalizeAlerts, ruleMatches, hostMatches, MAX_RULES, MAX_PER_MINUTE };
