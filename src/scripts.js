'use strict';

/**
 * 脚本规则：用一小段 JS 在请求发出前 / 响应回给客户端前改东西。
 *
 * 这是「工具变平台」的那一步，所以边界从一开始就划死：
 *  - 只有两个同步钩子 `onRequest(req)` / `onResponse(res)`，没有异步、没有网络、没有文件；
 *  - 沙箱里没有 require / process / Buffer，代码生成（eval / new Function）也关掉；
 *  - 每次调用都有超时（默认 50ms），死循环不会把代理卡住；
 *  - `console.log` 收进环形缓冲，给面板显示，不往宿主 stdout 打。
 *
 * 请求阶段能改 method / url / headers；响应阶段能改 status / headers / body。
 * 请求体不在这一版的可改范围（要改就得先把 body 缓冲下来，大上传会被撑爆）。
 */

const vm = require('vm');

const MAX_RULES = 20;
const MAX_CODE = 20000;
const DEFAULT_TIMEOUT = 50;
const MAX_LOGS = 50;

function fmtArg(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

function normalizeScripts(input) {
  const src = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(src.rules) ? src.rules : [];
  const out = [];
  for (const r of list) {
    if (!r) continue;
    const name = String(r.name || '').trim().slice(0, 40);
    const code = String(r.code || '');
    if (!name || !code.trim()) continue;
    out.push({
      id: String(r.id || `sc${out.length + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `sc${out.length + 1}`,
      name,
      enabled: r.enabled !== false,
      // request / response / both
      phase: r.phase === 'request' || r.phase === 'response' ? r.phase : 'both',
      host: String(r.host || '').trim().slice(0, 120),
      url: String(r.url || '').trim().slice(0, 200),
      method: String(r.method || '').trim().toUpperCase().slice(0, 10),
      code: code.slice(0, MAX_CODE),
      timeoutMs: Math.min(500, Math.max(5, Number(r.timeoutMs) || DEFAULT_TIMEOUT)),
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

/** 一条规则是否作用于这次请求（阶段 + 方法 + 域名 + URL 包含） */
function ruleMatches(rule, phase, req) {
  if (!rule || !rule.enabled) return false;
  if (rule.phase !== 'both' && rule.phase !== phase) return false;
  if (!hostMatches(rule, req.host)) return false;
  if (rule.method && String(req.method || '').toUpperCase() !== rule.method) return false;
  if (rule.url && !String(req.url || '').toLowerCase().includes(rule.url.toLowerCase())) return false;
  return true;
}

/** 沙箱里能看到的只有这几个名字；没有任何宿主能力 */
function createSandbox(logs) {
  const sandbox = {
    __reg: { request: null, response: null },
    __arg: null,
    __logs: logs,
  };
  sandbox.onRequest = function (fn) {
    if (typeof fn === 'function') sandbox.__reg.request = fn;
  };
  sandbox.onResponse = function (fn) {
    if (typeof fn === 'function') sandbox.__reg.response = fn;
  };
  sandbox.console = {
    log: function (...args) {
      if (sandbox.__logs.length < MAX_LOGS) sandbox.__logs.push(args.map(fmtArg).join(' '));
    },
  };
  return sandbox;
}

class ScriptEngine {
  constructor(config) {
    this.config = config || {};
    this.cache = new Map();
  }

  settings() {
    return normalizeScripts(this.config.scripts);
  }

  set(body) {
    const next = normalizeScripts(body);
    this.config.scripts = next;
    this.cache.clear();
    return next;
  }

  /** 编译一段代码：返回 { ok, error, hooks, logs } */
  compile(code, timeoutMs = DEFAULT_TIMEOUT) {
    const logs = [];
    const sandbox = createSandbox(logs);
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    try {
      const script = new vm.Script(String(code), { filename: 'ireq-script.js' });
      script.runInContext(ctx, { timeout: Math.max(5, timeoutMs) });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), logs };
    }
    const reg = sandbox.__reg;
    const hooks = {
      request: typeof reg.request === 'function' ? 'request' : null,
      response: typeof reg.response === 'function' ? 'response' : null,
    };
    return { ok: true, hooks, logs, sandbox, ctx };
  }

  /** 编译结果按代码内容缓存：每次请求都 new Script 太浪费 */
  _compiled(rule) {
    const key = rule.id + ':' + rule.code.length + ':' + rule.timeoutMs;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = this.compile(rule.code, rule.timeoutMs);
    this.cache.set(key, out);
    return out;
  }

  match(phase, req) {
    const s = this.settings();
    if (!s.enabled) return [];
    return s.rules.filter((r) => ruleMatches(r, phase, req));
  }

  /**
   * 跑一条规则的某个钩子。arg 是普通对象，钩子里直接改它。
   * 返回 { ok, error?, logs, ms }。
   */
  run(rule, phase, arg) {
    const compiled = this._compiled(rule);
    if (!compiled.ok) return { ok: false, error: '编译失败：' + compiled.error, logs: compiled.logs, ms: 0 };
    if (!compiled.hooks[phase]) return { ok: true, skipped: true, logs: [], ms: 0 };
    const ctx = compiled.ctx;
    const sandbox = compiled.sandbox;
    sandbox.__arg = arg;
    const started = Date.now();
    try {
      vm.runInContext(`__reg.${phase} && __reg.${phase}(__arg)`, ctx, { timeout: rule.timeoutMs });
    } catch (err) {
      return {
        ok: false,
        error: String((err && err.message) || err),
        logs: sandbox.__logs.slice(-MAX_LOGS),
        ms: Date.now() - started,
      };
    } finally {
      sandbox.__arg = null;
    }
    return { ok: true, logs: sandbox.__logs.slice(-MAX_LOGS), ms: Date.now() - started };
  }
}

module.exports = { ScriptEngine, normalizeScripts, ruleMatches, MAX_RULES, DEFAULT_TIMEOUT };
