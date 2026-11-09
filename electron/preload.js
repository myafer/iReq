'use strict';

/* 只暴露一个极小的通道：把网页里切换的语言同步给主进程重建原生菜单 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ReqLiteDesktop', {
  setLang(lang) {
    ipcRenderer.send('reqlite-lang', lang);
  },
});
