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
  try {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(out, null, 2) + '\n');
  } catch {
    /* 磁盘只读也不影响主功能 */
  }
}

module.exports = { loadPersistedConfig, savePersistedConfig };
