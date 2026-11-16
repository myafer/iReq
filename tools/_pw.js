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

const { chromium: rawChromium } = require(findCore());

let EXEC = process.env.CHROME_PATH;
if (!EXEC) {
  try {
    const builtin = rawChromium.executablePath();
    EXEC = fs.existsSync(builtin) ? builtin : undefined;
  } catch (_) {
    EXEC = undefined;
  }
}

/* 顶栏的低频按钮已收进「更多」/「更多筛选」菜单。自检脚本里大量使用 page.click('#btnCa')
 * 这类选择器，统一在测试侧补一步「先展开对应菜单」，避免每个脚本各改一遍。
 * 只对落在折叠菜单里的目标生效，其它选择器行为完全不变。 */
function decoratePage(page) {
  if (page.__reqliteDecorated) return page;
  const origClick = page.click.bind(page);
  page.click = async (selector, options) => {
    try {
      // 从外到内的展开链：筛选条（默认收起）→ 更多菜单 → 菜单里的二级分组 → 详情「⋯」
      const chain = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return [];
        const steps = [];
        const fbar = document.querySelector('#filters');
        if (el.closest('#filters') && fbar && fbar.hidden) steps.push(['#filters', '#btnFilters']);
        if (el.closest('#moreAdvanced')) steps.push(['#moreMenu', '#btnMore'], ['#moreAdvanced', '#btnMoreAdvanced']);
        else if (el.closest('#moreMenu')) steps.push(['#moreMenu', '#btnMore']);
        if (el.closest('#filterMoreMenu')) steps.push(['#filterMoreMenu', '#btnFilterMore']);
        if (el.closest('#flowMoreMenu')) steps.push(['#flowMoreMenu', '#btnFlowMore']);
        return steps;
      }, selector);
      for (const [boxId, triggerId] of chain) {
        const opened = await page.evaluate((id) => {
          const m = document.querySelector(id);
          return !!m && !m.hidden;
        }, boxId);
        if (!opened) await origClick(triggerId);
      }
    } catch (_) {
      /* 复杂选择器 / 页面尚未就绪时按原行为处理 */
    }
    return origClick(selector, options);
  };
  Object.defineProperty(page, '__reqliteDecorated', { value: true, configurable: true });
  return page;
}

/* 自检脚本的断言基于中文界面：默认让浏览器报中文 locale，i18n 引擎据此选中文。
 * 需要测英文时显式传 { locale: 'en-US' } 即可覆盖。 */
const chromium = {
  launch: async (opts) => {
    const browser = await rawChromium.launch(opts);
    const rawNewContext = browser.newContext.bind(browser);
    browser.newContext = async (o = {}) => {
      const ctx = await rawNewContext({ locale: process.env.REQLITE_PW_LOCALE || 'zh-CN', ...o });
      const rawNewPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => decoratePage(await rawNewPage());
      return ctx;
    };
    browser.newPage = async (o = {}) => {
      const ctx = await browser.newContext(o);
      return ctx.newPage();
    };
    return browser;
  },
};

// EXEC 为 undefined 时，launch 会用 Playwright 自带的默认路径
module.exports = { chromium, EXEC };
