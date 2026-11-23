'use strict';

/** 用户偏好持久化（data/config.json）：更新开关 + 跳过解密白名单（含来源、加入时间）+ 首启引导标记 */

const fs = require('fs');
const path = require('path');

function loadPersistedConfig(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function savePersistedConfig(dataDir, cfg) {
  const out = { autoUpdate: cfg.autoUpdate !== false };
  // 白名单以前只在内存里，重启就没了；加过一次「跳过解密」的域名必须留下来。
  if (Array.isArray(cfg.passthrough)) out.passthrough = cfg.passthrough;
  if (cfg.passthroughMeta && typeof cfg.passthroughMeta === 'object') {
    out.passthroughMeta = cfg.passthroughMeta;
  }
  // 首启引导只值得看一次：存服务端而不是 localStorage，
  // 否则换个浏览器 / 清一次缓存就又弹一遍。
  if (cfg.onboarded === true) out.onboarded = true;
  // MCP 接入：开关 + 令牌哈希（明文永不落盘）+ scope。属于授权凭据，必须持久化。
  if (cfg.mcp && typeof cfg.mcp === 'object') {
    out.mcp = {
      enabled: cfg.mcp.enabled === true,
      tokens: Array.isArray(cfg.mcp.tokens)
        ? cfg.mcp.tokens.map((t) => ({
            id: String(t.id || ''),
            name: String(t.name || ''),
            prefix: String(t.prefix || ''),
            salt: String(t.salt || ''),
            hash: String(t.hash || ''),
            scopes: Array.isArray(t.scopes) ? t.scopes.filter((s) => s === 'read' || s === 'write') : ['read'],
            createdAt: Number(t.createdAt) || 0,
            lastUsedAt: Number(t.lastUsedAt) || 0,
            calls: Number(t.calls) || 0,
            expiresAt: Number(t.expiresAt) || 0,
          }))
        : [],
    };
  }
  // 接管系统代理时要跳过的域名 / IP（VPN 网关、内网面板…）：
  // 不绕过的话 VPN 客户端自己连网关的请求会被解密拦下来，直接连不上。
  if (Array.isArray(cfg.proxyBypass) && cfg.proxyBypass.length) {
    out.proxyBypass = cfg.proxyBypass.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 60);
  }
  // 反向代理：端口与上游是环境配置，落盘
  if (cfg.reverseProxy && typeof cfg.reverseProxy === 'object') {
    out.reverseProxy = {
      enabled: cfg.reverseProxy.enabled === true,
      port: Number(cfg.reverseProxy.port) || 0,
      target: String(cfg.reverseProxy.target || '').slice(0, 500),
    };
  }
  // 脱敏：默认开，但只有用户动过才写进文件 —— 这样以后改默认值能跟着走
  if (cfg.redact && typeof cfg.redact === 'object') {
    out.redact = {
      enabled: cfg.redact.enabled !== false,
      headers: cfg.redact.headers !== false,
      query: cfg.redact.query !== false,
      body: cfg.redact.body !== false,
      pii: cfg.redact.pii === true,
      extraHeaders: Array.isArray(cfg.redact.extraHeaders) ? cfg.redact.extraHeaders.slice(0, 100) : [],
      extraFields: Array.isArray(cfg.redact.extraFields) ? cfg.redact.extraFields.slice(0, 100) : [],
    };
  }
  // 脚本规则：用户写的钩子，属于配置，必须落盘
  if (cfg.scripts && typeof cfg.scripts === 'object') {
    out.scripts = {
      enabled: cfg.scripts.enabled !== false,
      rules: Array.isArray(cfg.scripts.rules) ? cfg.scripts.rules : [],
    };
  }
  // 条件告警：规则是工作习惯（等某个 5xx / 某个字段），落盘
  if (cfg.alerts && typeof cfg.alerts === 'object') {
    out.alerts = {
      enabled: cfg.alerts.enabled !== false,
      rules: Array.isArray(cfg.alerts.rules) ? cfg.alerts.rules : [],
    };
  }
  // 派生列：用户配的「把这个字段提成一列」属于工作习惯，必须留下来
  if (Array.isArray(cfg.derivedColumns)) out.derivedColumns = cfg.derivedColumns;
  // 域名映射是配置而不是会话状态：「把线上域名指到测试机」配一次该一直有效。
  if (cfg.hostMap && typeof cfg.hostMap === 'object') {
    out.hostMap = {
      enabled: cfg.hostMap.enabled === true,
      rules: Array.isArray(cfg.hostMap.rules)
        ? cfg.hostMap.rules
            .filter((r) => r && r.from && r.to)
            .slice(0, 60)
            .map((r, i) => ({
              id: String(r.id || `hm${i + 1}`),
              from: String(r.from).slice(0, 200),
              to: String(r.to).slice(0, 200),
              enabled: r.enabled !== false,
            }))
        : [],
    };
  }
  try {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(out, null, 2) + '\n');
  } catch {
    /* 磁盘只读也不影响主功能 */
  }
}

module.exports = { loadPersistedConfig, savePersistedConfig };
