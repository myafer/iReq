'use strict';

/*
 * 自检脚本共用的 Playwright 定位器。
 * 优先级：环境变量 PLAYWRIGHT_CORE/CHROME_PATH > 项目内的 playwright-core/playwright
 * > 常见全局 CLI 安装目录。仓库里不写任何用户目录的绝对路径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function findCore() {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE;
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return require.resolve(name);
    } catch (_) {
      /* 试下一个 */
    }
  }
  const versions = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(versions).map((d) => path.join(versions, d));
  } catch (_) {
    /* 该环境没有全局 CLI */
  }
  for (const d of dirs) {
    for (const rel of [
      'lib/node_modules/@playwright/cli/node_modules/playwright-core',
      'lib/node_modules/playwright-core',
    ]) {
      const p = path.join(d, rel);
      if (fs.existsSync(path.join(p, 'package.json'))) return p;
    }
  }
  throw new Error('找不到 playwright-core：请执行 npm i -D playwright-core，或设置 PLAYWRIGHT_CORE 指向模块目录');
}

const { chromium } = require(findCore());

let EXEC = process.env.CHROME_PATH;
if (!EXEC) {
  try {
    const builtin = chromium.executablePath();
    EXEC = fs.existsSync(builtin) ? builtin : undefined;
  } catch (_) {
    EXEC = undefined;
  }
}
// EXEC 为 undefined 时，launch 会用 Playwright 自带的默认路径
module.exports = { chromium, EXEC };
