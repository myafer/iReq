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
      phase: ['request', 'response', 'ws'].includes(r.phase) ? r.phase : 'both',
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
    __reg: { request: null, response: null, ws: null },
    __arg: null,
    __logs: logs,
  };
  sandbox.onRequest = function (fn) {
    if (typeof fn === 'function') sandbox.__reg.request = fn;
  };
  sandbox.onResponse = function (fn) {
    if (typeof fn === 'function') sandbox.__reg.response = fn;
  };
  // WebSocket：一帧一次回调。frame 上只有只读字段与三个动作（回一条 / 发一条 / 丢掉）
  sandbox.onWebsocket = function (fn) {
    if (typeof fn === 'function') sandbox.__reg.ws = fn;
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
      ws: typeof reg.ws === 'function' ? 'ws' : null,
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

/** 现成模板：blank page 最难写，给 8 个能直接改的起点 */
const TEMPLATES = [
  {
    id: 'add-header',
    name: '给请求加一个头',
    nameEn: 'Add a request header',
    phase: 'request',
    desc: '调试标记、灰度开关都常用',
    code: "onRequest((req) => {\n  req.headers['x-debug'] = '1';\n});\n",
  },
  {
    id: 'drop-header',
    name: '去掉请求里的头',
    nameEn: 'Remove a request header',
    phase: 'request',
    desc: '验证服务端是否依赖某个头',
    code: "onRequest((req) => {\n  delete req.headers['x-client-version'];\n});\n",
  },
  {
    id: 'set-status',
    name: '改响应状态码',
    nameEn: 'Change the status code',
    phase: 'response',
    desc: '把 500 改成 200，验证前端兜底',
    code: 'onResponse((res) => {\n  res.status = 200;\n});\n',
  },
  {
    id: 'mock-json',
    name: '把响应换成一段 JSON',
    nameEn: 'Replace the body with JSON',
    phase: 'response',
    desc: '不建 Mock 规则也能临时改数据',
    code: "onResponse((res) => {\n  res.headers['content-type'] = 'application/json';\n  res.body = JSON.stringify({ code: 0, data: { mocked: true } });\n});\n",
  },
  {
    id: 'cors',
    name: '给响应加 CORS 头',
    nameEn: 'Add CORS headers',
    phase: 'response',
    desc: '本地联调浏览器跨域',
    code: "onResponse((res) => {\n  res.headers['access-control-allow-origin'] = '*';;\n});\n",
  },
  {
    id: 'simulate-500',
    name: '模拟服务端 500',
    nameEn: 'Simulate a 500',
    phase: 'response',
    desc: '配 URL 包含使用，只影响命中的接口',
    code: 'onResponse((res) => {\n  res.status = 500;\n  res.body = \'{"error":"simulated"}\';\n});\n',
  },
  {
    id: 'ws-log',
    name: 'WebSocket：打印每一条消息',
    nameEn: 'WebSocket: log every message',
    phase: 'ws',
    desc: '接上之后帧会同时出现在控制台日志里',
    code: "onWebsocket((frame) => {\n  console.log(frame.dir, frame.op, frame.bytes, frame.text);\n});\n",
  },
  {
    id: 'ws-drop-ping',
    name: 'WebSocket：丢掉心跳',
    nameEn: 'WebSocket: drop heartbeats',
    phase: 'ws',
    desc: '验证客户端在没心跳时会不会自己重连',
    code: "onWebsocket((frame) => {\n  if (frame.text === 'ping' || frame.text === 'heartbeat') frame.drop();\n});\n",
  },
  {
    id: 'ws-echo',
    name: 'WebSocket：收到关键词就回一条',
    nameEn: 'WebSocket: reply to a keyword',
    phase: 'ws',
    desc: '不用等服务端，客户端立刻拿到响应',
    code: "onWebsocket((frame) => {\n  if (frame.dir === 'up' && frame.text && frame.text.indexOf('hello') >= 0) {\n    frame.sendToClient('mock-ok');\n  }\n});\n",
  },
];

module.exports = { ScriptEngine, normalizeScripts, ruleMatches, TEMPLATES, MAX_RULES, DEFAULT_TIMEOUT };
