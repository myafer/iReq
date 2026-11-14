'use strict';

/**
 * 耗时分解：把「这个请求慢 3 秒」拆成 DNS / TCP / TLS / 等待首字节 / 下载。
 *
 * 只做观测，不改转发行为：
 *  - 只有真正解析域名时才计 DNS。上游写 IP、或走域名映射到 IP 时，Node 不会调
 *    lookup，这里也不会留下 0ms 的假 DNS 段。
 *  - 连接复用（keep-alive / 连接池）时 DNS、TCP、TLS 三段都是 0，用 reused 标记，
 *    否则用户会以为「握手 0ms」是 bug。
 *  - 拿不到的阶段留 null，不写 0 —— 「不知道」和「很快」在排障时是两件事。
 */

const dns = require('dns');

const PHASES = ['dns', 'tcp', 'tls', 'wait', 'download'];

function now() {
  return process.hrtime.bigint();
}

function span(from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  const v = Number(to - from) / 1e6;
  // hrtime 单调递增，理论上不会为负；真出现就归零，别把脏数据带进百分比
  return v < 0 ? 0 : Math.round(v);
}

/**
 * @param {bigint} [startedAt] 请求进入代理的时刻（与 duration 同一个基准）
 * @param {{ secure?: boolean }} [opts] secure=false 时不计算 TLS 段
 */
function createCollector(startedAt, opts = {}) {
  const t0 = startedAt || now();
  const secure = opts.secure !== false;
  const c = {
    t0,
    reused: false,
    _dnsStart: null,
    _dnsEnd: null,
    _connectAt: null,
    _secureAt: null,
    _sentAt: null,
    _respAt: null,
  };

  /**
   * 交给 http(s).request 的 lookup：Node 在真正需要解析时才调用，
   * 已经是 IP 的地址不会走到这里。
   */
  c.lookup = function lookup(hostname, options, cb) {
    c._dnsStart = now();
    dns.lookup(hostname, options, function (...args) {
      c._dnsEnd = now();
      cb(...args);
    });
  };

  /** 挂到 ClientRequest 上，事件名与 Node 的连接生命周期一一对应 */
  c.attach = function attach(req) {
    req.on('socket', (socket) => {
      // 复用连接：socket 交过来时已经连好了，握手阶段真实耗时为 0
      if (!socket.connecting) {
        c.reused = true;
        return;
      }
      socket.once('connect', () => {
        c._connectAt = now();
      });
      socket.once('secureConnect', () => {
        c._secureAt = now();
      });
    });
    // finish = 请求头和请求体都交给内核了，之后才是「等上游处理」
    req.on('finish', () => {
      c._sentAt = now();
    });
    req.on('response', () => {
      c._respAt = now();
    });
    return c;
  };

  /** 收尾：endedAt 默认取当前时刻，与 flow.duration 同一口径 */
  c.finish = function finish(endedAt) {
    const end = endedAt || now();
    const total = span(t0, end);
    const reused = c.reused || false;

    let dnsMs = null;
    if (reused) dnsMs = 0;
    else if (c._dnsEnd !== null) dnsMs = span(c._dnsStart || t0, c._dnsEnd);

    let tcpMs = null;
    if (reused) tcpMs = 0;
    else if (c._connectAt !== null) tcpMs = span(c._dnsEnd || t0, c._connectAt);

    let tlsMs = null;
    if (reused) tlsMs = 0;
    else if (!secure) tlsMs = 0;
    else if (c._secureAt !== null) tlsMs = span(c._connectAt || c._dnsEnd || t0, c._secureAt);

    // 等待：从「请求已经发出去」到「首字节回来」。中间的握手、DNS 已单独计过，
    // 所以基准取这些阶段的最后一个落点，避免重复计入。
    const sentBase = c._sentAt || c._secureAt || c._connectAt || c._dnsEnd || t0;
    const waitMs = c._respAt !== null ? span(sentBase, c._respAt) : null;
    const downloadMs = c._respAt !== null ? span(c._respAt, end) : null;

    return {
      total,
      dns: dnsMs,
      tcp: tcpMs,
      tls: tlsMs,
      wait: waitMs,
      download: downloadMs,
      reused,
    };
  };

  return c;
}

module.exports = { createCollector, PHASES, span };
