'use strict';

/**
 * CA 目录解析：让 Electron 打包版、CLI 单文件版、源码 dev 版共用同一张根证书。
 *
 * 优先级：createApp({caDir}) > 环境变量 REQLITE_CA_DIR（自检隔离用）> ~/.ireq/ca。
 * candidates 是历史版本可能放过 CA 的目录，启动时若主档案缺失就从这里迁移。
 */

const os = require('os');
const path = require('path');

function resolveCaDir(opts = {}) {
  if (opts.caDir) return path.resolve(opts.caDir);
  if (process.env.REQLITE_CA_DIR) return path.resolve(process.env.REQLITE_CA_DIR);
  return path.join(os.homedir(), '.ireq', 'ca');
}

function caCandidates(opts = {}) {
  const home = opts.home || os.homedir();
  const out = [];
  if (opts.dataDir) out.push(path.join(opts.dataDir, 'ca'));
  if (process.platform === 'darwin') {
    // Electron 默认 userData 按 app name 走，历史上 ireq / iReq 两种拼写都出现过
    out.push(path.join(home, 'Library', 'Application Support', 'ireq', 'data', 'ca'));
    out.push(path.join(home, 'Library', 'Application Support', 'iReq', 'data', 'ca'));
    out.push(path.join(home, 'Library', 'Application Support', 'iReq', 'data', 'ca'));
  } else if (process.platform === 'win32') {
    out.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ireq', 'data', 'ca'));
    out.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'iReq', 'data', 'ca'));
  } else {
    out.push(path.join(home, '.config', 'ireq', 'data', 'ca'));
    out.push(path.join(home, '.config', 'iReq', 'data', 'ca'));
  }
  if (opts.repoDir) out.push(path.join(opts.repoDir, 'data', 'ca'));
  // pkg 单文件版旧逻辑：data 跟着可执行文件走
  if (process.pkg || __dirname.startsWith('/snapshot')) {
    out.push(path.join(path.dirname(process.execPath), 'data', 'ca'));
  }
  return [...new Set(out.map((p) => path.resolve(p)))];
}

module.exports = { resolveCaDir, caCandidates };
