'use strict';

/**
 * 网页 ↔ 主进程的极小桥接：
 *  1. 语言选择同步给原生菜单
 *  2. macOS 隐藏原生标题栏后，把顶栏颜色/高度同步给窗口（原生底色 + 红黄绿按钮位置）
 * 只在 Electron 里加载；CLI/浏览器模式访问同一页面时完全不受影响。
 */
const { contextBridge, ipcRenderer } = require('electron');

let isMac = false;
try {
  isMac = process.platform === 'darwin';
} catch (_) {
  /* 沙箱里 process 被裁剪时，主进程 did-finish-load 会补打标记 */
}

function markTitlebar() {
  if (isMac && document.documentElement) {
    document.documentElement.dataset.electronTitlebar = 'hidden';
  }
}

function syncWindowChrome() {
  if (!isMac || !document.documentElement) return;
  const panel = (getComputedStyle(document.documentElement).getPropertyValue('--panel') || '').trim() || '#ffffff';
  const topbar = document.querySelector('.topbar');
  const height = topbar ? topbar.getBoundingClientRect().height : 48;
  ipcRenderer.send('reqlite-window-chrome', {
    background: panel,
    // 交通灯按钮约 12px 高，按顶栏实际高度垂直居中（字号缩放后依然对齐）
    trafficY: (height - 12) / 2,
  });
}

markTitlebar();

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncWindowChrome, 30);
}

function setup() {
  markTitlebar();
  if (!isMac || !document.documentElement) return;
  // --ui-scale 写在 html 的 style 上、主题写在 data-theme 上，变化后都要重算按钮位置
  new MutationObserver(scheduleSync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-theme'],
  });
  window.addEventListener('resize', scheduleSync);
  scheduleSync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setup, { once: true });
} else {
  setup();
}

contextBridge.exposeInMainWorld('ReqLiteDesktop', {
  setLang(lang) {
    ipcRenderer.send('reqlite-lang', lang);
  },
  hiddenTitlebar: isMac,
  syncWindowChrome,
});
