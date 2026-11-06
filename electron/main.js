'use strict';

/**
 * Electron 主进程：桌面窗口壳，复用 src/app.js 的代理 + 控制台内核。
 * - 启动代理与 UI 服务（127.0.0.1），BrowserWindow 加载本地页面
 * - 退出前恢复系统代理（复用 createApp().stop() 的安全顺序）
 * - 单实例锁：二次启动唤起已有窗口
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const net = require('net');

const pkg = require('../package.json');

let mainWindow = null;
let running = null; // createApp() 返回的内核句柄
let quitting = false;

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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'iReq',
    backgroundColor: '#f7f6f4',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // 页面内 window.open / target=_blank 一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);
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
              { role: 'about', label: '关于 iReq' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 iReq' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 iReq' },
            ],
          },
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
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
      console.error('[iReq] 启动失败:', (err && err.stack) || err);
      dialog.showErrorBox('iReq 启动失败', String((err && err.stack) || err));
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
