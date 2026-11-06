'use strict';

/**
 * Mock 规则引擎：命中即本地直返，不走上游。
 * 规则持久化在 data/rules.json，顺序即优先级（靠前的先匹配）。
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + '$', 'i');
}

class RuleEngine {
  constructor(dir) {
    this.file = path.join(dir || path.join(process.cwd(), 'data'), 'rules.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.rules = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) return raw.map((r) => normalizeRule(r));
    } catch (_) {
      /* 首次运行没有规则文件 */
    }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.rules, null, 2));
    } catch (_) {
      /* 忽略 */
    }
  }

  list() {
    return this.rules;
  }

  add(input) {
    const rule = normalizeRule({ ...input, id: randomUUID() });
    this.rules.push(rule);
    this._save();
    return rule;
  }

  update(id, patch) {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    this.rules[idx] = normalizeRule({ ...this.rules[idx], ...patch, id });
    this._save();
    return this.rules[idx];
  }

  remove(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length !== before) this._save();
    return this.rules.length !== before;
  }

  reorder(ids) {
    if (!Array.isArray(ids)) return this.rules;
    const map = new Map(this.rules.map((r) => [r.id, r]));
    const next = [];
    for (const id of ids) {
      const r = map.get(id);
      if (r) {
        next.push(r);
        map.delete(id);
      }
    }
    this.rules = next.concat([...map.values()]);
    this._save();
    return this.rules;
  }

  /** 返回命中的第一条规则，没有则 null */
  match({ method, url, host }) {
    const target = String(url || '');
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== String(method).toUpperCase()) {
        continue;
      }
      if (rule.host && String(host || '').toLowerCase() !== rule.host.toLowerCase()) continue;
      const pattern = rule.urlMatch || '';
      if (!pattern) {
        if (rule.host) return rule; // 只按 host 匹配
        continue;
      }
      let hit = false;
      if (rule.matchMode === 'regex') {
        try {
          hit = new RegExp(pattern, 'i').test(target);
        } catch (_) {
          hit = false;
        }
      } else if (rule.matchMode === 'wildcard') {
        hit = wildcardToRegExp(pattern).test(target);
      } else {
        hit = target.toLowerCase().includes(pattern.toLowerCase());
      }
      if (hit) return rule;
    }
    return null;
  }
}

function normalizeRule(r) {
  const out = {
    id: r.id || randomUUID(),
    name: r.name || '',
    enabled: r.enabled !== false,
    method: (r.method || '*').toUpperCase(),
    host: r.host || '',
    urlMatch: r.urlMatch || '',
    matchMode: r.matchMode === 'regex' || r.matchMode === 'wildcard' ? r.matchMode : 'contains',
    status: Number(r.status) || 200,
    delayMs: Number(r.delayMs) || 0,
    headers: normalizeHeaders(r.headers),
    body: typeof r.body === 'string' ? r.body : '',
    bodyBase64: !!r.bodyBase64,
    // 下面两个只服务于控制台编辑体验，不参与匹配
    note: typeof r.note === 'string' ? r.note : '',
    bodyType: ['auto', 'json', 'plaintext', 'html', 'xml', 'javascript'].includes(r.bodyType)
      ? r.bodyType
      : 'auto',
    createdAt: r.createdAt || Date.now(),
  };
  return out;
}

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const line of h) {
      const i = String(line).indexOf(':');
      if (i > 0) out[String(line).slice(0, i).trim().toLowerCase()] = String(line).slice(i + 1).trim();
    }
    return out;
  }
  if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (k) out[String(k).trim().toLowerCase()] = String(v);
    }
  }
  return out;
}

module.exports = { RuleEngine, normalizeRule };
