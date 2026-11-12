'use strict';

/** 用户偏好持久化（data/config.json）：更新开关 + 跳过解密白名单（含来源、加入时间） */

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
  try {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(out, null, 2) + '\n');
  } catch {
    /* 磁盘只读也不影响主功能 */
  }
}

module.exports = { loadPersistedConfig, savePersistedConfig };
