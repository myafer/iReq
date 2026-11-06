'use strict';

/** 用户偏好持久化（data/config.json）——目前只有更新开关，后续可扩展 */

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
  try {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ autoUpdate: cfg.autoUpdate !== false }, null, 2) + '\n'
    );
  } catch {
    /* 磁盘只读也不影响主功能 */
  }
}

module.exports = { loadPersistedConfig, savePersistedConfig };
