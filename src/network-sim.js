'use strict';

/**
 * 网络模拟：按「应用 / 域名 / 设备」给指定流量制造断网、弱网、超时。
 *
 * 纯逻辑模块，不碰 socket，方便自检直接覆盖所有分支。
 * 配置是会话级的（data/config.json 不落盘），重启自动恢复 —— 避免上次忘了关、
 * 下次打开 App 发现「怎么全都连不上」。
 */

const { Transform } = require('stream');

const MODES = ['offline', 'weak', 'timeout'];
const DEFAULT_PARAMS = { latencyMs: 800, kbps: 64, timeoutMs: 30000 };
const LIMITS = {
  latencyMs: [0, 60000],
  kbps: [1, 102400],
  timeoutMs: [100, 600000],
};

function bounded(value, key, fallback) {
  const [min, max] = LIMITS[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 任何来源（API / 持久化 / 默认值）都先过一遍，保证下游拿到的是干净结构 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rules = (Array.isArray(src.rules) ? src.rules : [])
    .map((r, i) => ({
      id: String((r && r.id) || `r${i + 1}`).slice(0, 40),
      match: String((r && r.match) || '').trim().slice(0, 160),
      mode: MODES.includes(r && r.mode) ? r.mode : 'offline',
    }))
    .filter((r) => r.match);
  return {
    enabled: src.enabled !== false,
    latencyMs: bounded(src.latencyMs, 'latencyMs', DEFAULT_PARAMS.latencyMs),
    kbps: bounded(src.kbps, 'kbps', DEFAULT_PARAMS.kbps),
    timeoutMs: bounded(src.timeoutMs, 'timeoutMs', DEFAULT_PARAMS.timeoutMs),
    rules,
  };
}

/**
 * 匹配串语法：
 *   *            全部流量
 *   app:名称      只按应用名（忽略大小写、包含匹配）
 *   host:域名     只按域名（支持子域）
 *   ip:地址       只按客户端 IP
 *   裸串          依次尝试应用名 / 域名 / 设备标签 / IP
 */
function matches(rule, fact) {
  const raw = String((rule && rule.match) || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === '*') return true;
  const app = String((fact && fact.app) || '').toLowerCase();
  const host = String((fact && fact.host) || '').toLowerCase();
  const ip = String((fact && fact.ip) || '').toLowerCase();
  const label = String((fact && fact.deviceLabel) || '').toLowerCase();
  if (raw.startsWith('app:')) return app.includes(raw.slice(4));
  if (raw.startsWith('host:')) {
    const v = raw.slice(5);
    return !!v && (host === v || host.endsWith('.' + v) || host.includes(v));
  }
  if (raw.startsWith('ip:')) return ip.includes(raw.slice(3));
  return (
    app.includes(raw) || host.includes(raw) || label.includes(raw) || ip.includes(raw)
  );
}

/** 第一条命中的规则生效；返回 null 表示这条请求正常放行 */
function resolve(sim, fact) {
  const cfg = normalize(sim);
  if (!cfg.enabled) return null;
  for (const rule of cfg.rules) {
    if (matches(rule, fact)) {
      return {
        mode: rule.mode,
        rule,
        latencyMs: cfg.latencyMs,
        kbps: cfg.kbps,
        timeoutMs: cfg.timeoutMs,
      };
    }
  }
  return null;
}

/** 侧栏快捷开关：只看「精确应用名」的规则，不受包含匹配误伤 */
function ruleForApp(sim, name) {
  const cfg = normalize(sim);
  const target = String(name || '').toLowerCase();
  return (
    cfg.rules.find((r) => {
      const m = r.match.toLowerCase();
      return m === target || m === 'app:' + target;
    }) || null
  );
}

function activeCount(sim) {
  const cfg = normalize(sim);
  return cfg.enabled ? cfg.rules.length : 0;
}

/**
 * 按目标带宽节流字节流。chunk 越大等待越久，平均速率即为 kbps；
 * 用 Transform 的 backpressure 天然限速，不需要整体缓冲响应体。
 */
function throttleTransform(kbps) {
  // 参数与界面一致，单位是 KB/s（不是千比特），64 表示约 64 KiB/s
  const bytesPerMs = Math.max(0.001, (Number(kbps) * 1024) / 1000);
  return new Transform({
    transform(chunk, _enc, cb) {
      if (this.destroyed) return cb();
      const ms = Math.min(2000, Math.max(1, Math.round(chunk.length / bytesPerMs)));
      setTimeout(() => {
        if (!this.destroyed) {
          try {
            this.push(chunk);
          } catch (_) {
            /* 下游已关闭 */
          }
        }
        cb();
      }, ms);
    },
  });
}

module.exports = {
  MODES,
  DEFAULT_PARAMS,
  normalize,
  matches,
  resolve,
  ruleForApp,
  activeCount,
  throttleTransform,
};
