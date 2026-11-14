'use strict';

/**
 * 组装层：CA -> 存储 -> 规则 -> 代理 -> 控制台
 */

const os = require('os');
const path = require('path');
const { CertificateAuthority } = require('./ca');
const { FlowStore } = require('./store');
const { RuleEngine } = require('./rules');
const { BookmarkStore } = require('./bookmarks');
const { ProxyServer } = require('./proxy');
const { Breakpoints } = require('./breakpoint');
const { HostMap } = require('./hostmap');
const { ConsoleServer } = require('./server');
const { SystemProxy } = require('./system-proxy');
const { CaTrust } = require('./ca-trust');
const { resolveCaDir, caCandidates } = require('./ca-dirs');
const { AppIconResolver } = require('./app-icon');
const { UpdateChecker } = require('./update');
const { loadPersistedConfig } = require('./user-config');

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** pkg 打包成单文件后 __dirname 在只读快照里，数据目录要落到可执行文件同级 */
function defaultDataDir() {
  if (process.pkg || __dirname.startsWith('/snapshot')) {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return path.join(__dirname, '..', 'data');
}

async function createApp({
  proxyPort = 9090,
  uiPort = 9091,
  bindHost = '0.0.0.0',
  uiHost = '127.0.0.1',
  dataDir = defaultDataDir(),
  caDir = null,
  persist = true,
  maxFlows = 2000,
  config = {},
} = {}) {
  // CA 落在固定目录，与 dataDir 解耦：Electron 打包版 / CLI 单文件 / dev 版共用同一张根证书，
  // 覆盖安装或换形态都不会再触发「重新生成 CA → 重新信任」。
  const resolvedCaDir = resolveCaDir({ caDir });
  const ca = new CertificateAuthority(resolvedCaDir, {
    candidates: caCandidates({ dataDir, repoDir: path.join(__dirname, '..') }),
  });
  const store = new FlowStore({ dir: path.join(dataDir, 'flows'), persist, maxFlows });
  const rules = new RuleEngine(dataDir);
  const bookmarks = new BookmarkStore(dataDir);
  const systemProxy = new SystemProxy({ proxyPort, dataDir });
  const caTrust = new CaTrust(ca, { stateFile: path.join(resolvedCaDir, 'trust-state.json') });
  const appIcons = new AppIconResolver({ dataDir });
  // 启动时就检测一次：如果上次进程被强杀，系统代理可能还指向我们，
  // 而根证书又没装 —— 这种情况下必须立刻进入安全模式，别让本机 HTTPS 全挂。
  // 若上次已确认过同一张 CA 受信任，先沿用该结论，避免钥匙串偶发抖动导致启动瞬间误进安全模式。
  const priorTrust = caTrust.state();
  const trust = caTrust.refresh();
  const effectiveTrust = trust.trusted === null
    ? true
    : (trust.trusted === true || (priorTrust && priorTrust.trusted === true));
  const runtimeConfig = {
    capture: true,
    passthrough: [],
    uaAppMap: [],
    processMap: true,
    caTrusted: effectiveTrust, // 非 macOS 无法检测，不阻断
    localProxyOurs: Boolean(systemProxy.status().ours),
    ...loadPersistedConfig(dataDir),
    ...config,
  };
  // 版本与仓库信息来自 package.json（repository url 解析出 owner/repo）
  const pkg = require('../package.json');
  const repoMatch = String((pkg.repository && pkg.repository.url) || pkg.repository || '').match(
    /github\.com[/:]([^/]+)\/([^/.#]+)/
  );

  // 断点：会话级，不落盘。上次没放行的断点不该在下次启动时继续拦人。
  const breakpoints = new Breakpoints();
  // 域名映射：属于配置，要落盘 —— 「把线上域名指到测试机」不该每次启动重配一遍
  const hostmap = new HostMap(runtimeConfig.hostMap);

  const proxy = new ProxyServer({
    port: proxyPort,
    host: bindHost,
    ca,
    store,
    rules,
    breakpoints,
    hostmap,
    config: runtimeConfig,
  });
  const updater = new UpdateChecker({
    owner: repoMatch && repoMatch[1],
    repo: repoMatch && repoMatch[2],
    version: pkg.version,
    proxyPort,
    config: runtimeConfig,
  });
  const console_ = new ConsoleServer({
    port: uiPort,
    host: uiHost,
    store,
    rules,
    bookmarks,
    proxy,
    ca,
    config: runtimeConfig,
    systemProxy,
    caTrust,
    appIcons,
    updater,
    dataDir,
    breakpoints,
    hostmap,
    publicDir: path.join(__dirname, '..', 'public'),
  });

  return {
    ca,
    caDir: resolvedCaDir,
    store,
    rules,
    bookmarks,
    hostmap,
    proxy,
    systemProxy,
    caTrust,
    appIcons,
    updater,
    console: console_,
    config: runtimeConfig,
    async start({ withUi = true } = {}) {
      const pPort = await proxy.start();
      let uPort = null;
      if (withUi) uPort = await console_.start();
      updater.start();
      return {
        proxyPort: pPort,
        uiPort: uPort,
        lan: lanAddresses(),
        caPath: ca.caCertPath,
        restored: store.flows.length,
      };
    },
    async stop() {
      // 先把系统代理还原，再关监听端口：顺序反了的话，中间那段时间本机请求会打到一个
      // 已经不存在的代理上，表现为「工具一退，网就断了」。
      const restored = systemProxy.autoRestore();
      updater.stop();
      await console_.stop();
      await proxy.stop();
      return restored;
    },
  };
}

module.exports = { createApp, lanAddresses };
