'use strict';

/**
 * 断点：把命中的请求 / 响应挂起，等控制台改完再放行。
 *
 * 和 Mock 的区别：Mock 是事先写死「这个 URL 永远返回这个」，断点是
 * 「这次让我看一眼、改一手再走」。所以它必须真的把连接停下来等，
 * 而停下来就一定有兜底 —— 没人操作（或页面关了）必须自己放行，
 * 否则 App 那边会一直转圈。
 *
 * 只做逻辑与队列，不碰 socket：代理层拿到 hold() 返回的 Promise，
 * 等服务端通过 resolve() 放行。这样自检可以直接测，不用起真连接。
 */

const { EventEmitter } = require('events');

/** 请求/响应阶段，两者规则分开配 */
const PHASES = ['request', 'response'];
/** body 超过这个大小就不让编辑了（放行但不给改），免得把内存撑爆 */
const BODY_EDIT_MAX = 2 * 1024 * 1024;
/** 没人管时的自动放行时间。够慢的调试也不会断，但不会把 App 挂死 */
const DEFAULT_TIMEOUT = 60 * 1000;

function normRule(r, i) {
  const phase = PHASES.includes(r && r.phase) ? r.phase : 'both';
  return {
    id: String((r && r.id) || `bp${i + 1}`).slice(0, 40),
    // 匹配串：URL 包含即可，* 当通配符；留空表示全部（= 全局断点，慎用）
    match: String((r && r.match) || '').trim().slice(0, 200),
    phase,
    // 只看某个方法，留空表示不限
    method: String((r && r.method) || '').trim().toUpperCase().slice(0, 10),
  };
}

/**
 * 匹配串语法（和 Mock 规则保持一致的直觉，但更简单）：
 *   空串 / *   → 全部命中
 *   含 *       → 通配（* 匹配任意字符）
 *   其它       → URL 包含这段文字（忽略大小写）
 */
function matchOne(pattern, url) {
  const p = String(pattern || '').trim();
  if (!p || p === '*') return true;
  const u = String(url || '').toLowerCase();
  if (p.includes('*')) {
    const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(url);
  }
  return u.includes(p.toLowerCase());
}

let seq = 0;

class Breakpoints {
  constructor({ timeoutMs = DEFAULT_TIMEOUT } = {}) {
    this.events = new EventEmitter();
    this.timeoutMs = timeoutMs;
    this.rules = [];
    this.enabled = false;
    /** id → { record, resolve, timer } */
    this.pending = new Map();
  }

  /** 规则整体替换（控制台保存时一次给全） */
  setRules(rules, enabled) {
    this.rules = (Array.isArray(rules) ? rules : []).map(normRule).filter((r) => r.match || r.match === '');
    if (enabled !== undefined) this.enabled = !!enabled;
    // 关掉断点时，正在挂的一律放行，不能留一批悬挂连接
    if (!this.enabled) this.releaseAll('off');
    return this.state();
  }

  /** 自动放行时间（秒级到 10 分钟）。调小了只影响之后挂起的那些，已挂起的等原定时器 */
  setTimeoutMs(ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 1000 && n <= 600000) this.timeoutMs = Math.round(n);
    return this.timeoutMs;
  }

  state() {
    return {
      enabled: this.enabled,
      timeoutMs: this.timeoutMs,
      rules: this.rules.map((r) => ({ ...r })),
      pending: this.list(),
    };
  }

  /** 命中哪条规则（返回规则本身，没命中返回 null） */
  match(phase, { method = '', url = '' } = {}) {
    if (!this.enabled || !this.rules.length) return null;
    const m = String(method || '').toUpperCase();
    for (const r of this.rules) {
      if (r.phase !== 'both' && r.phase !== phase) continue;
      if (r.method && r.method !== m) continue;
      if (matchOne(r.match, url)) return r;
    }
    return null;
  }

  /**
   * 挂起一条，返回 Promise<resolution>。
   * resolution：{ type:'resume', method?, url?, headers?, body? } 继续走（带改动）
   *             { type:'abort', status, statusText, headers, body } 直接给客户端一个响应
   * 超时 → { type:'resume', timedOut:true }，绝不无限等。
   */
  hold(record) {
    const id = record.id || `b${(seq += 1)}`;
    const bodySize = Buffer.byteLength(String(record.body || ''), 'utf8');
    const rec = {
      ...record,
      id,
      at: Date.now(),
      editable: bodySize <= BODY_EDIT_MAX,
      bodySize,
      // 下发给界面，好在弹窗上写明「多少秒不处理就自动放行」
      timeoutMs: this.timeoutMs,
      // 超限的 body 不下发全文（几 MB 塞进 SSE 没意义），只告诉界面「太大了，只能放行」
      body: bodySize <= BODY_EDIT_MAX ? record.body : '',
    };

    return new Promise((resolve) => {
      const done = (resolution) => {
        const cur = this.pending.get(id);
        if (!cur) return;
        clearTimeout(cur.timer);
        this.pending.delete(id);
        this.events.emit('release', { id, phase: rec.phase, resolution });
        resolve(resolution);
      };
      const timer = setTimeout(() => done({ type: 'resume', timedOut: true }), this.timeoutMs);
      // 定时器不应拖住进程退出（CLI 前台跑时 Ctrl+C 要能立刻走）
      if (timer.unref) timer.unref();
      this.pending.set(id, { record: rec, resolve: done, timer });
      this.events.emit('hold', rec);
    });
  }

  /** 控制台放行 / 直接返回 */
  resolve(id, action) {
    const cur = this.pending.get(String(id));
    if (!cur) return null;
    const a = action && typeof action === 'object' ? action : {};
    if (a.type === 'abort') {
      cur.resolve({
        type: 'abort',
        status: Number(a.status) || 502,
        statusText: String(a.statusText || ''),
        headers: a.headers && typeof a.headers === 'object' ? a.headers : { 'content-type': 'text/plain; charset=utf-8' },
        body: String(a.body == null ? 'iReq: 断点已拦截' : a.body),
      });
    } else {
      const out = { type: 'resume' };
      // 只接受明确给出的字段，没改的交给代理层沿用原值
      if (typeof a.method === 'string' && a.method.trim()) out.method = a.method.trim().toUpperCase();
      if (typeof a.url === 'string' && a.url.trim()) out.url = a.url.trim();
      if (a.headers && typeof a.headers === 'object') out.headers = a.headers;
      if (typeof a.body === 'string') out.body = a.body;
      if (a.status != null) out.status = Number(a.status) || 0;
      cur.resolve(out);
    }
    return true;
  }

  releaseAll(reason = 'all') {
    const list = [...this.pending.keys()];
    for (const id of list) {
      const cur = this.pending.get(id);
      if (cur) cur.resolve({ type: 'resume', autoReleased: reason });
    }
    return list.length;
  }

  list() {
    return [...this.pending.values()].map((p) => {
      const { body, ...rest } = p.record;
      return { ...rest, bodyPreview: String(body || '').slice(0, 4000) };
    });
  }

  /** 取一条完整记录（界面点开某条待处理项时用，含 body 全文） */
  get(id) {
    const p = this.pending.get(String(id));
    return p ? { ...p.record } : null;
  }
}

module.exports = { Breakpoints, matchOne, BODY_EDIT_MAX, DEFAULT_TIMEOUT };
