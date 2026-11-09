'use strict';

/**
 * Electron 主进程：桌面窗口壳，复用 src/app.js 的代理 + 控制台内核。
 * - 启动代理与 UI 服务（127.0.0.1），BrowserWindow 加载本地页面
 * - 退出前恢复系统代理（复用 createApp().stop() 的安全顺序）
 * - 单实例锁：二次启动唤起已有窗口
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const net = require('net');

const pkg = require('../package.json');

let mainWindow = null;
let running = null; // createApp() 返回的内核句柄
let quitting = false;

/* 原生菜单文案：默认跟随系统语言（非中文系统一律英文），网页里切换语言时实时同步 */
const MENU_LABELS = {
  'zh-CN': {
    about: '关于 iReq', hide: '隐藏 iReq', hideOthers: '隐藏其他', unhide: '全部显示', quit: '退出 iReq',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '视图', reload: '重新加载', forceReload: '强制重新加载', devTools: '开发者工具',
    actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    window: '窗口', minimize: '最小化', close: '关闭', startFailed: 'iReq 启动失败', startFailedLog: '[iReq] 启动失败:',
  },
  en: {
    about: 'About iReq', hide: 'Hide iReq', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit iReq',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    view: 'View', reload: 'Reload', forceReload: 'Force Reload', devTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
    window: 'Window', minimize: 'Minimize', close: 'Close', startFailed: 'iReq failed to start', startFailedLog: '[iReq] Failed to start:',
  },
};
function systemMenuLang() {
  return (app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
let menuLang = systemMenuLang();
const L = (key) => (MENU_LABELS[menuLang] || MENU_LABELS.en)[key];
function syncMenuLang(lang) {
  // auto = 跟随系统；网页传来的也可能是实际生效语言（en / zh-CN）
  const next = !lang || lang === 'auto'
    ? systemMenuLang()
    : (lang === 'en' || lang === 'zh-CN' ? lang : null);
  if (!next || next === menuLang) return;
  menuLang = next;
  setupMenu();
}

/** 偏好端口可用则返回原值，被占用则退避为随机端口（0 = 系统分配）
 *  host 必须与实际服务绑定的地址一致：探测地址和绑定地址家族不同时，
 *  macOS 会漏判冲突（比如服务绑 127.0.0.1 而探测绑 0.0.0.0） */
function freePort(pref, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen({ port: pref, host: host || '0.0.0.0' }, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// 数据目录：Electron 标准用户数据目录（~/Library/Application Support/iReq 等）
function resolveDataDir() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(__dirname, '..', 'data'); // 开发模式沿用仓库内 data
}

function createWindow(uiPort) {
  const isMac = process.platform === 'darwin';
  /* macOS：隐藏原生标题栏，只把红黄绿三个按钮浮在网页顶栏里，视觉上与内容融为一体。
     Windows / Linux 仍保留系统标题栏——那里隐藏标题栏会连最小化/关闭按钮一起消失。 */
  const chrome = isMac
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 18 } }
    : {};
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'iReq',
    backgroundColor: '#f7f6f4',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    ...chrome,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  // 页面内 window.open / target=_blank 一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);
  // 首次启动按网页里保存的语言重建菜单（没有保存值时保持系统语言判断）
  // 顺带补打标题栏标记：即使 preload 阶段来不及写，也不会首屏闪一下旧布局
  mainWindow.webContents.on('did-finish-load', () => {
    const js = (isMac ? "document.documentElement.dataset.electronTitlebar='hidden'; " : '')
      + "localStorage.getItem('reqlite-lang')";
    mainWindow.webContents
      .executeJavaScript(js)
      .then((saved) => syncMenuLang(saved))
      .catch(() => {});
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 精简菜单：mac 保留编辑复制粘贴（否则快捷键失效），其余精简
function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: L('about') },
              { type: 'separator' },
              { role: 'hide', label: L('hide') },
              { role: 'hideOthers', label: L('hideOthers') },
              { role: 'unhide', label: L('unhide') },
              { type: 'separator' },
              { role: 'quit', label: L('quit') },
            ],
          },
        ]
      : []),
    {
      label: L('edit'),
      submenu: [
        { role: 'undo', label: L('undo') },
        { role: 'redo', label: L('redo') },
        { type: 'separator' },
        { role: 'cut', label: L('cut') },
        { role: 'copy', label: L('copy') },
        { role: 'paste', label: L('paste') },
        { role: 'selectAll', label: L('selectAll') },
      ],
    },
    {
      label: L('view'),
      submenu: [
        { role: 'reload', label: L('reload') },
        { role: 'forceReload', label: L('forceReload') },
        { role: 'toggleDevTools', label: L('devTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: L('actualSize') },
        { role: 'zoomIn', label: L('zoomIn') },
        { role: 'zoomOut', label: L('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: L('fullscreen') },
      ],
    },
    {
      label: L('window'),
      submenu: [{ role: 'minimize', label: L('minimize') }, { role: 'close', label: L('close') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupMenu();
    ipcMain.on('reqlite-lang', (_e, lang) => syncMenuLang(lang));
    /* 网页顶栏充当标题栏：让原生窗口底色跟随主题、红黄绿按钮随顶栏高度垂直居中。
       字号缩放 / 主题切换 / 窗口尺寸变化时由 preload 主动上报。 */
    ipcMain.on('reqlite-window-chrome', (_e, info) => {
      if (!mainWindow || mainWindow.isDestroyed() || !info) return;
      if (typeof info.background === 'string' && /^#[0-9a-f]{3,8}$/i.test(info.background)) {
        mainWindow.setBackgroundColor(info.background);
      }
      if (process.platform === 'darwin'
        && typeof mainWindow.setTrafficLightPosition === 'function'
        && Number.isFinite(info.trafficY)) {
        mainWindow.setTrafficLightPosition({ x: 16, y: Math.max(8, Math.round(info.trafficY)) });
      }
    });
    try {
      const { createApp } = require('../src/app');
      running = await createApp({
        dataDir: resolveDataDir(),
        // 端口被占（比如 CLI 版本还在跑）时退避到随机端口，别直接报错退出
        proxyPort: await freePort(9090),
        uiPort: await freePort(9091, '127.0.0.1'),
      });
      const info = await running.start({ withUi: true });
      createWindow(info.uiPort);
    } catch (err) {
      console.error(L('startFailedLog'), (err && err.stack) || err);
      dialog.showErrorBox(L('startFailed'), String((err && err.stack) || err));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    // 关窗即退出：必须走 stop() 把系统代理还原，避免「工具一退网就断」
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting || !running) return;
    quitting = true;
    e.preventDefault();
    Promise.resolve(running.stop())
      .catch(() => {})
      .finally(() => app.quit());
  });
}
