'use strict';

/**
 * Web 控制台 + REST API。纯 Node 实现，无第三方框架。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { replay } = require('./replay');
const { summary, prepareFilter } = require('./store');
const { FlowHistory, tailPage } = require('./history');
const { parseAppAliases } = require('./derive');
const { savePersistedConfig } = require('./user-config');
const { normalize: normalizeNetworkSim } = require('./network-sim');
const { passthroughMatches, normalizePassthroughRule } = require('./proxy');
const { McpAuth } = require('./mcp-auth');
const mcp = require('./mcp');

const VERSION = require('../package.json').version;

/**
 * 列出非回环 IPv4 地址及其网卡。控制台顶栏要展示「局域网 IP」并允许在多网卡间切换，
 * 只有 IP 数组时用户分不清哪个是 Wi-Fi、哪个是 VPN / 虚拟网卡。
 * 常见私有网段排前面，169.254（本地链路）排最后。
 */
function lanInterfaces() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ ip: net.address, iface });
    }
  }
  const rank = (ip) =>
    /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^169\.254\./.test(ip) ? 9 : 5;
  out.sort((a, b) => rank(a.ip) - rank(b.ip) || a.iface.localeCompare(b.iface) || a.ip.localeCompare(b.ip));
  return out;
}

function lanAddresses() {
  return lanInterfaces().map((x) => x.ip);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/* 导出 HAR 1.2：headers / body / 耗时按规范映射，抓包里的应用名、设备 IP 等放到 _iReq 扩展字段 */
function harHeaders(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value),
  }));
}

function harContent(flow, isRequest) {
  const text = isRequest ? flow.reqBody : flow.resBody;
  const b64 = isRequest ? flow.reqBodyBase64 : flow.resBodyBase64;
  const heads = isRequest ? flow.reqHeaders : flow.resHeaders;
  const contentType = (heads && (heads['content-type'] || heads['Content-Type'])) || '';
  const content = {
    size: Number(isRequest ? flow.reqSize : flow.resSize) || 0,
    mimeType: String(Array.isArray(contentType) ? contentType[0] : contentType),
  };
  if (b64) {
    content.text = String(b64);
    content.encoding = 'base64';
  } else {
    content.text = text == null ? '' : String(text);
  }
  return content;
}

/* 导出文件名用记录名（下载下来一看就知道是哪次抓的）；中文走 RFC 5987，老客户端用 ASCII 兜底 */
function exportDisposition(item, format) {
  const ext = format === 'json' ? 'json' : 'har';
  const stamp = new Date((item && item.createdAt) || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const name = String((item && item.name) || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const ascii = `ireq-${stamp}.${ext}`;
  if (!name) return `attachment; filename="${ascii}"`;
  /* 默认名本身就是「11-14 02-37」这种时间（冒号已在上面换成 -），再拼一遍 createdAt 就重复了 */
  const full = /^\d{2}-\d{2} \d{2}-\d{2}/.test(name) ? `${name}.${ext}` : `${name}-${stamp}.${ext}`;
  const encoded = encodeURIComponent(full).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toHar(flows, version) {
  const entries = flows
    .slice()
    .reverse() // 内部是最新在前，HAR 按时间正序更自然
    .map((f) => {
      let queryString = [];
      try {
        queryString = [...new URL(f.url).searchParams].map(([name, value]) => ({ name, value }));
      } catch (_) {
        /* URL 不完整时忽略 query */
      }
      const time = Math.max(0, Number(f.duration) || 0);
      return {
        startedDateTime: new Date(f.ts || Date.now()).toISOString(),
        time,
        request: {
          method: f.method || 'GET',
          url: f.url || '',
          httpVersion: 'HTTP/1.1',
          headers: harHeaders(f.reqHeaders),
          queryString,
          cookies: [],
          headersSize: -1,
          bodySize: Number(f.reqSize) || 0,
          postData: harContent(f, true),
        },
        response: {
          status: Number(f.status) || 0,
          statusText: String(f.statusText || ''),
          httpVersion: 'HTTP/1.1',
          headers: harHeaders(f.resHeaders),
          cookies: [],
          content: harContent(f, false),
          redirectURL: '',
          headersSize: -1,
          bodySize: Number(f.resSize) || 0,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        _iReq: {
          id: f.id,
          app: f.app || null,
          clientIp: f.clientIp || null,
          mocked: Boolean(f.mocked),
          error: f.error || null,
        },
      };
    });
  return {
    log: { version: '1.2', creator: { name: 'iReq', version: version || '' }, pages: [], entries },
  };
}

class ConsoleServer {
  constructor({ port = 9091, host = '127.0.0.1', store, rules, bookmarks, proxy, ca, config, systemProxy, caTrust, appIcons, updater, dataDir, publicDir }) {
    this.port = port;
    this.host = host;
    this.store = store;
    this.rules = rules;
    this.bookmarks = bookmarks;
    this.proxy = proxy;
    this.ca = ca;
    this.config = config;
    this.systemProxy = systemProxy;
    this.caTrust = caTrust;
    this.appIcons = appIcons || null;
    this.updater = updater || null;
    this.dataDir = dataDir || null;
    this.publicDir = publicDir || path.join(__dirname, '..', 'public');
    this.clients = new Set();
    this.server = null;
    /* MCP 授权：令牌只存哈希，界面里生成与撤销；默认关闭，开了也必须有令牌 */
    this.mcpAuth = new McpAuth({ config: this.config, dataDir: this.dataDir });
    /* 历史记录（每次清空一条）：列表来自 index，回看按字节游标从文件尾部倒序读 */
    this.history = this.dataDir
      ? new FlowHistory({
          dir: path.join(this.dataDir, 'flows'),
          indexFile: path.join(this.dataDir, 'history.json'),
        })
      : null;
    this._ensurePassthroughMeta();
  }

  /** 启动参数 / 老配置里的白名单没有来源元数据，补一个「原有配置」标签 */
  _ensurePassthroughMeta() {
    if (!this.config.passthroughMeta || typeof this.config.passthroughMeta !== 'object') {
      this.config.passthroughMeta = {};
    }
    for (const raw of this.config.passthrough || []) {
      const key = normalizePassthroughRule(raw);
      if (key && !this.config.passthroughMeta[key]) {
        this.config.passthroughMeta[key] = { source: 'startup', addedAt: 0 };
      }
    }
  }

  /**
   * 管理列表数据：规则 + 来源/加入时间 + 实际透传次数（能一眼看出规则有没有生效）。
   */
  _passthroughList() {
    const meta = this.config.passthroughMeta || {};
    const hits =
      this.proxy && typeof this.proxy.passthroughStats === 'function'
        ? this.proxy.passthroughStats()
        : [];
    const rules = (this.config.passthrough || []).map((raw) => {
      const rule = String(raw).trim();
      const key = normalizePassthroughRule(rule);
      const m = meta[key] || {};
      const own = hits.filter((h) => passthroughMatches(h.host, [rule]));
      return {
        rule,
        key,
        source: m.source || 'startup',
        addedAt: m.addedAt || 0,
        hits: own.reduce((a, h) => a + h.count, 0),
        lastHitAt: own.reduce((a, h) => Math.max(a, h.lastAt || 0), 0),
        hosts: own.map((h) => h.host).slice(0, 8),
      };
    });
    return {
      rules,
      totalHits: hits.reduce((a, h) => a + h.count, 0),
      hitHosts: hits.length,
    };
  }

  /**
   * 写白名单的唯一入口：诊断一键加入、管理面板、设置页手填、启动参数最后都走这里。
   * 归一化去重 → 记录来源 → 清掉已解决的诊断行 → 切断还在解密的存量连接 → 落盘 + SSE。
   */
  _setPassthrough(rules, source = 'settings') {
    const prev = (this.config.passthrough || []).slice();
    const meta = this.config.passthroughMeta || (this.config.passthroughMeta = {});
    const seen = new Set();
    const next = [];
    for (const raw of Array.isArray(rules) ? rules : []) {
      const key = normalizePassthroughRule(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      next.push(key);
      if (!meta[key]) meta[key] = { source, addedAt: Date.now() };
    }
    for (const key of Object.keys(meta)) if (!seen.has(key)) delete meta[key];
    this.config.passthrough = next;
    if (this.proxy && typeof this.proxy.clearTlsFailures === 'function') {
      for (const rule of next) this.proxy.clearTlsFailures(rule);
    }
    const killed =
      this.proxy && typeof this.proxy.applyPassthrough === 'function'
        ? this.proxy.applyPassthrough(prev, next)
        : 0;
    if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
    this._broadcast({ type: 'passthrough', passthrough: next, killed });
    return { passthrough: next, killed };
  }

  /**
   * 弱网改动的唯一入口（设置页 / 控制坞 / MCP 工具都走这里）：
   * 归一化 → 切断受影响的存量连接 → 广播给所有窗口。
   * 规则只在新连接进来时判定，不切存量的话「中途打开断网」会看起来没生效。
   */
  setNetworkSim(raw) {
    const prev = this.config.networkSim;
    const next = normalizeNetworkSim(raw);
    this.config.networkSim = next;
    const killed =
      this.proxy && typeof this.proxy.applyNetworkSim === 'function'
        ? this.proxy.applyNetworkSim(prev, next)
        : 0;
    this._broadcast({ type: 'network-sim', sim: next, killed });
    return { sim: next, killed };
  }

  /** 刷新信任状态并同步给代理（决定本机 HTTPS 是否进入安全透传模式） */
  _syncTrust(force = false) {
    if (!this.caTrust) return null;
    const st = this.caTrust.status(force);
    this.config.caTrusted = st.trusted !== false;
    return st;
  }

  _safeMode() {
    return this.config.caTrusted === false && this.config.localProxyOurs === true;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._route(req, res).catch((err) => {
          this._json(res, 500, { error: String((err && err.message) || err) });
        });
      });
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this._bindEvents();
        resolve(this.port);
      });
    });
  }

  _bindEvents() {
    this.store.on('flow', (flow) => this._broadcast({ type: 'flow', flow }));
    this.store.on('flow-update', (flow) =>
      this._broadcast({ type: 'flow-update', flow: summary(flow) })
    );
    this.store.on('clear', () => this._broadcast({ type: 'clear' }));
    // 清空会在磁盘上留下一份归档 —— 它就是界面上新出现的那条历史记录
    this.store.on('archived', (info) => {
      if (!this.history) return;
      const item = this.history.add(info);
      this._broadcast({ type: 'history-changed', item });
    });
    // 握手失败是「连接层」事件，不是 HTTP flow，单独推给控制台的列表诊断行
    if (this.proxy && typeof this.proxy.on === 'function') {
      this.proxy.on('tls-failure', (failure) =>
        this._broadcast({ type: 'tls-failure', failure })
      );
      // 加入跳过解密 / 握手恢复 / 手动忽略后，把「已经解决的域名」从所有窗口的诊断行里撤掉
      this.proxy.on('tls-remove', ({ hosts }) =>
        this._broadcast({ type: 'tls-remove', hosts })
      );
    }
  }

  _broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(data);
      } catch (_) {
        this.clients.delete(res);
      }
    }
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/events') return this._sse(req, res);
    /* MCP 端点：JSON-RPC over HTTP，唯一带令牌认证的入口（其余 /api 供本机控制台用） */
    if (pathname === '/mcp') return mcp.handleHttp(req, res, { server: this, auth: this.mcpAuth });
    if (pathname.startsWith('/api/')) return this._api(req, res, pathname, url);
    if (pathname === '/ca.pem' || pathname === '/ireq-ca.pem') return this._caFile(res, 'pem');
    if (pathname === '/ca.cer' || pathname === '/ca.crt') return this._caFile(res, 'der');
    if (pathname.startsWith('/app-icon/')) {
      if (!this.appIcons) {
        res.writeHead(404);
        return res.end('not found');
      }
      return this.appIcons.serve(pathname.slice('/app-icon/'.length), res);
    }
    return this._static(pathname, res);
  }

  _sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    this.clients.add(res);
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        /* noop */
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(timer);
      this.clients.delete(res);
    });
  }

  async _api(req, res, pathname, url) {
    const method = req.method.toUpperCase();
    const parts = pathname.split('/').filter(Boolean); // ['api', ...]

    if (parts[1] === 'status' && method === 'GET') {
      return this._json(res, 200, {
        proxyPort: this.proxy ? this.proxy.port : null,
        uiPort: this.port,
        stats: this.proxy ? this.proxy.stats : {},
        store: this.store.stats(),
        capture: this.config.capture,
        mockEnabled: this.config.mockEnabled !== false,
        h2Enabled: this.config.h2Enabled !== false,
        // 首启引导：没看过才弹（存服务端，换浏览器不重复打扰）
        onboarded: this.config.onboarded === true,
        passthrough: this.config.passthrough,
        mitmPorts: this.config.mitmPorts,
        rules: this.rules.list().length,
        caPath: this.ca ? this.ca.caCertPath : null,
        caCreated: this.ca ? this.ca.created : false,
        caInfo: this.ca ? this.ca.info : null,
        dataDir: this.dataDir || null,
        /* 界面按平台换文案：访达 / 资源管理器 / 文件管理器 */
        platform: process.platform,
        caTrust: this.caTrust ? this._syncTrust() : null,
        safeMode: this._safeMode(),
        lan: lanAddresses(),
        lanInfo: lanInterfaces(),
        processMap: this.proxy
          ? {
              supported: this.proxy.processMap.supported,
              enabled: this.proxy.processMap.supported && this.config.processMap !== false,
              stats: this.proxy.processMap.stats,
            }
          : { supported: false, enabled: false, stats: {} },
        uaAppMap: this.config.uaAppMap || [],
        networkSim: normalizeNetworkSim(this.config.networkSim),
        appIcons: this.appIcons ? this.appIcons.status() : { supported: false },
        version: VERSION,
        update: this.updater ? this.updater.status() : null,
      });
    }

    /* ---------------- MCP 接入：开关 / 令牌 / 审计（本机控制台专用） ---------------- */
    if (parts[1] === 'mcp') return this._apiMcp(req, res, parts, method, url);

    /* ---------------- 历史记录：每次「清空」一条，可改名 / 回看 / 删除 ---------------- */
    if (parts[1] === 'history') return this._apiHistory(req, res, parts, method, url);

    /** 前端批量问图标：本机 .app 直接给 URL，取不到的由前端用内置 / 默认图标 */
    if (parts[1] === 'app-icons' && method === 'GET') {
      const names = (url.searchParams.get('names') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 80);
      if (!this.appIcons) return this._json(res, 200, { supported: false, icons: {} });
      this.appIcons.collectHints(this.store.list({ limit: 2000 }));
      const icons = await this.appIcons.resolveMany(names);
      return this._json(res, 200, {
        supported: this.appIcons.supported,
        icons,
        stats: this.appIcons.status(),
      });
    }

    /* 导出 HAR / 原始 JSON：复用列表的筛选条件，返回带附件名的下载 */
    if (parts[1] === 'export' && method === 'GET') {
      const format = parts[2] === 'json' ? 'json' : 'har';
      const sp = url.searchParams;
      const flows = this.store.listFull({
        query: sp.get('q') || '',
        status: sp.get('status') || '',
        onlyMocked: sp.get('mocked') === '1',
        host: sp.get('host') || '',
        ip: sp.get('ip') || '',
        app: sp.get('app') || '',
        route: sp.get('route') || '',
        limit: Math.min(Number(sp.get('limit')) || 2000, 2000),
      });
      const payload = format === 'json' ? flows.slice().reverse() : toHar(flows, VERSION);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const data = Buffer.from(JSON.stringify(payload, null, format === 'har' ? 2 : 0));
      res.writeHead(200, {
        'content-type': format === 'har' ? 'application/har+json; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="ireq-${stamp}.${format === 'json' ? 'json' : 'har'}"`,
        'content-length': data.length,
        'x-flow-count': String(flows.length),
        'cache-control': 'no-store',
      });
      return res.end(data);
    }

    if (parts[1] === 'flows') {
      // 分页列表：内存取完自动接着读今天的落盘文件，前端滚到底就无感续上
      if (method === 'GET' && parts.length === 3 && parts[2] === 'page') {
        return this._json(res, 200, this._flowsPage(url.searchParams));
      }
      if (method === 'GET' && parts.length === 2) {
        return this._json(
          res,
          200,
          this.store.list({
            query: url.searchParams.get('q') || '',
            method: url.searchParams.get('method') || '',
            status: url.searchParams.get('status') || '',
            onlyMocked: url.searchParams.get('mocked') === '1',
            host: url.searchParams.get('host') || '',
            ip: url.searchParams.get('ip') || '',
            app: url.searchParams.get('app') || '',
            route: url.searchParams.get('route') || '',
            limit: Math.min(Number(url.searchParams.get('limit')) || 500, 2000),
          })
        );
      }
      if (method === 'GET' && parts.length === 3) {
        const flow = this.store.get(parts[2]);
        if (!flow) return this._json(res, 404, { error: 'flow 不存在' });
        return this._json(res, 200, flow);
      }
      if (method === 'DELETE' && parts.length === 2) {
        this.store.clear();
        return this._json(res, 200, { ok: true });
      }
      if (method === 'POST' && parts.length === 4 && parts[3] === 'replay') {
        const flow = this.store.get(parts[2]);
        if (!flow) return this._json(res, 404, { error: 'flow 不存在' });
        const body = await this._body(req);
        const result = await replay({ store: this.store, flow, overrides: body || {} });
        return this._json(res, 200, result);
      }
    }

    if (parts[1] === 'diagnostics' && method === 'DELETE') {
      // 带 ?host= 时只忽略这一个域名（及其子域），不清掉别的失败记录
      const host = url.searchParams.get('host');
      if (host && this.proxy && typeof this.proxy.clearTlsFailures === 'function') {
        const removed = this.proxy.clearTlsFailures(host);
        return this._json(res, 200, { ok: true, removed });
      }
      if (this.proxy && this.proxy.tlsFailures) this.proxy.tlsFailures.clear();
      this._broadcast({ type: 'tls-clear' });
      return this._json(res, 200, { ok: true });
    }

    if (parts[1] === 'diagnostics' && method === 'GET') {
      const diag = this.proxy ? this.proxy.diagnostics() : { tlsFailures: [], tunneled: 0 };
      return this._json(res, 200, {
        ...diag,
        passthrough: this.config.passthrough || [],
        mitmPorts: this.config.mitmPorts || [443],
      });
    }

    /* 跳过解密白名单的管理接口：GET 列表 / POST 追加 / PUT 全量替换 / DELETE 单条或清空 */
    if (parts[1] === 'passthrough') {
      if (method === 'GET') return this._json(res, 200, this._passthroughList());
      if (!['POST', 'PUT', 'DELETE'].includes(method)) {
        return this._json(res, 405, { error: '不支持的方法' });
      }
      const body = method === 'DELETE' ? {} : (await this._body(req)) || {};
      const asArray = (v) =>
        Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/).filter(Boolean);
      let rules;
      if (method === 'DELETE') {
        const key = normalizePassthroughRule(url.searchParams.get('rule') || '');
        rules = key
          ? (this.config.passthrough || []).filter((r) => normalizePassthroughRule(r) !== key)
          : [];
      } else if (method === 'POST') {
        rules = [...(this.config.passthrough || []), ...asArray(body.rules)];
      } else {
        rules = asArray(body.rules);
      }
      const changed = this._setPassthrough(rules, String(body.source || 'manager'));
      return this._json(res, 200, { ok: true, ...changed, ...this._passthroughList() });
    }

    if (parts[1] === 'ca-trust' && (method === 'GET' || method === 'POST')) {
      if (!this.caTrust) return this._json(res, 404, { error: '证书信任检测模块未启用' });
      let installResult = null;
      if (method === 'POST') {
        const body = (await this._body(req)) || {};
        if (body.action === 'install') installResult = this.caTrust.install();
      }
      // 安装之后必须强制刷新，让 config.caTrusted / 安全模式立刻跟着变
      const caTrust = this._syncTrust(method === 'POST');
      return this._json(res, 200, {
        ...caTrust,
        safeMode: this._safeMode(),
        caInfo: this.ca ? this.ca.info : null,
        install: installResult,
      });
    }

    // 证书档案元信息 + 钥匙串里遗留的旧 CA，供「证书与连接」的状态卡展示
    if (parts[1] === 'ca' && method === 'GET' && parts[2] === 'archive') {
      return this._json(res, 200, {
        ...(this.ca ? this.ca.info : {}),
        trustState: this.caTrust ? this.caTrust.state() : null,
        keychain: this.caTrust ? this.caTrust.keychainInfo() : { certs: [], stale: [] },
      });
    }

    if (parts[1] === 'ca' && method === 'POST' && parts[2] === 'import') {
      if (!this.ca) return this._json(res, 404, { error: 'CA 未初始化' });
      const body = (await this._body(req)) || {};
      const raw = String(body.p12 || '');
      if (!raw) return this._json(res, 400, { error: '没有收到 .p12 内容' });
      const der = Buffer.from(raw, 'base64');
      // 密码依次尝试：用户手填 → 默认 ireq → 本机档案里的导出密码 → 无密码。
      // 同一台机器导出后直接导入无需抄密码；跨机器时在状态卡里填导出时显示的密码。
      const pwd = String(body.password || '');
      const tries = [pwd, 'ireq', (this.ca.archive && this.ca.archive.p12Password) || '', ''];
      let info = null;
      let lastErr = null;
      for (const p of [...new Set(tries)]) {
        try {
          info = this.ca.importP12(der, p);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!info) {
        return this._json(res, 400, { error: String((lastErr && lastErr.message) || 'p12 导入失败') });
      }
      // 换 CA 后旧信任结论立刻作废，强制重新检测
      const caTrust = this._syncTrust(true);
      return this._json(res, 200, {
        ...caTrust,
        safeMode: this._safeMode(),
        caInfo: info,
        keychain: this.caTrust ? this.caTrust.keychainInfo() : { certs: [], stale: [] },
      });
    }

    if (parts[1] === 'system-proxy') {
      if (!this.systemProxy) return this._json(res, 404, { error: '系统代理模块未启用' });
      if (method === 'GET') {
        const st = this.systemProxy.status();
        this.config.localProxyOurs = Boolean(st.ours);
        return this._json(res, 200, {
          ...st,
          caTrust: this._syncTrust(),
          safeMode: this._safeMode(),
          commands: this.systemProxy.commands(st.service),
        });
      }
      if (method === 'POST') {
        const body = (await this._body(req)) || {};
        const r = body.enabled
          ? this.systemProxy.enable(body.service)
          : this.systemProxy.disable(body.service);
        // 接管时重新问一次系统：用户可能刚执行完信任命令。
        const caTrust = this._syncTrust(true);
        const st = r.status || this.systemProxy.status();
        this.config.localProxyOurs = Boolean(st.ours);
        const service = st.service || body.service || this.systemProxy.primaryService();
        return this._json(res, r.ok ? 200 : 400, {
          ...r,
          caTrust,
          safeMode: this._safeMode(),
          commands: this.systemProxy.commands(service),
        });
      }
    }

    if (parts[1] === 'facets' && method === 'GET') {
      const flows = this.store.flows.length;
      // 应用勾选（可多选，逗号分隔）后域名 / 接口结构级联：
      // hosts 不含 host / route 维度（选了域名不影响域名列表），
      // routes 含 host、只排除自身（只显示还在列表中的接口结构）。
      const base = {
        query: url.searchParams.get('q') || '',
        app: url.searchParams.get('app') || '',
        ip: url.searchParams.get('ip') || '',
      };
      const host = url.searchParams.get('host') || '';
      return this._json(res, 200, {
        flows,
        ...this.store.facets(40, {
          hosts: base,
          routes: { ...base, host },
        }),
      });
    }

    if (parts[1] === 'bookmarks' && this.bookmarks) {
      if (method === 'GET') return this._json(res, 200, this.bookmarks.list());
      if (method === 'POST' && parts.length === 2) {
        const body = (await this._body(req)) || {};
        const item = this.bookmarks.add({ label: body.label, filter: body.filter });
        if (!item) return this._json(res, 400, { error: '筛选条件为空' });
        return this._json(res, 200, item);
      }
      if (method === 'DELETE' && parts.length === 3) {
        return this._json(res, 200, { ok: this.bookmarks.remove(parts[2]) });
      }
    }

    if (parts[1] === 'rules') {
      // ---- 文件级 API：服务于界面文件树，同时是后期 AI 接入的直读直写通道 ----
      // （必须放在 GET /api/rules 的 list() 分支之前，否则 '/rules/tree' 会被 '/rules' 前缀截胡）
      // GET  /api/rules/tree                          → 文件树（文件夹/规则/body 三类节点）
      // GET  /api/rules/file?path=a/b.rule.json       → 读单个文件（规则含 body；body 文件返回原文）
      // PUT  /api/rules/file?path=a/b.body.json       → 直接写 body 文件 { text } 或 { base64 }
      // POST /api/rules/fs                            → 新建 { type:'dir'|'rule', dir, name }
      // POST /api/rules/move                          → 重命名/拖拽移动 { from, toDir, newName? }
      // POST /api/rules/copy                          → 复制粘贴 { from, toDir, newName? }
      // POST /api/rules/reveal                        → 在系统文件管理器中显示 { path }
      // DELETE /api/rules/file?path=...               → 删除文件或文件夹（递归）
      if (method === 'GET' && parts[2] === 'tree') {
        return this._json(res, 200, this.rules.tree());
      }
      if (parts[2] === 'file' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
        const rel = url.searchParams.get('path') || '';
        try {
          if (method === 'GET') return this._json(res, 200, this.rules.readFile(rel));
          if (method === 'DELETE') return this._json(res, 200, this.rules.deletePath(rel));
          const body = (await this._body(req)) || {};
          return this._json(res, 200, this.rules.writeBodyFile(rel, body));
        } catch (err) {
          return this._json(res, 400, { error: String((err && err.message) || err) });
        }
      }
      if (method === 'POST' && ['fs', 'move', 'copy', 'reveal'].includes(parts[2])) {
        const body = (await this._body(req)) || {};
        try {
          const out =
            parts[2] === 'fs'
              ? this.rules.create(body)
              : parts[2] === 'move'
                ? this.rules.move(body)
                : parts[2] === 'copy'
                  ? this.rules.copy(body)
                  : this.rules.reveal(body.path, { dryRun: body.dryRun === true });
          return this._json(res, 200, out);
        } catch (err) {
          return this._json(res, 400, { error: String((err && err.message) || err) });
        }
      }

      if (method === 'GET') return this._json(res, 200, this.rules.list());
      if (method === 'POST' && parts.length === 2) {
        const body = await this._body(req);
        return this._json(res, 200, this.rules.add(body || {}));
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'reorder') {
        const body = await this._body(req);
        return this._json(res, 200, this.rules.reorder((body || {}).ids));
      }
      if (method === 'PUT' && parts.length === 3) {
        const body = await this._body(req);
        const updated = this.rules.update(parts[2], body || {});
        if (!updated) return this._json(res, 404, { error: '规则不存在' });
        return this._json(res, 200, updated);
      }
      if (method === 'DELETE' && parts.length === 3) {
        const ok = this.rules.remove(parts[2]);
        return this._json(res, ok ? 200 : 404, { ok });
      }
    }

    if (parts[1] === 'config') {
      if (method === 'GET') return this._json(res, 200, this._publicConfig());
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        if (typeof body.capture === 'boolean') this.config.capture = body.capture;
        // Mock 总开关：会话级，dock / 设置里一键旁路所有规则
        if (typeof body.mockEnabled === 'boolean') this.config.mockEnabled = body.mockEnabled;
        // HTTP/2 协商开关：只影响之后的 TLS 握手（重建 mitm 服务器换 ALPN），不改存量连接
        if (body.h2Enabled !== undefined && this.proxy && typeof this.proxy.setH2Enabled === 'function') {
          this.proxy.setH2Enabled(body.h2Enabled);
        }
        if (Array.isArray(body.passthrough)) {
          // 用户把域名加进「跳过解密的域名」＝这个握手失败已经被处理。
          // 统一入口会清诊断、断掉还在解密的存量连接、落盘并广播给所有窗口。
          // 无论从诊断行详情、右键菜单、管理列表还是设置页手填保存，都会走这里。
          this._setPassthrough(body.passthrough, 'settings');
        }
        if (Array.isArray(body.mitmPorts)) {
          const ports = body.mitmPorts
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
          this.config.mitmPorts = ports.length ? ports : [443];
        }
        if (typeof body.processMap === 'boolean') this.config.processMap = body.processMap;
        // UA 别名：远程设备拿不到进程名时，按 UA 关键词手动标注应用
        if (typeof body.uaAppMapText === 'string') {
          this.config.uaAppMap = parseAppAliases(body.uaAppMapText);
        } else if (Array.isArray(body.uaAppMap)) {
          this.config.uaAppMap = body.uaAppMap
            .map((a) => ({ match: String((a && a.match) || '').trim(), name: String((a && a.name) || '').trim() }))
            .filter((a) => a.match && a.name);
        }
        if (Number(body.maxFlows) > 0) this.store.maxFlows = Number(body.maxFlows);
        if (typeof body.autoUpdate === 'boolean') this.config.autoUpdate = body.autoUpdate;
        // 首启引导「看过了」：只允许置 true，不给前端把它翻回去的口子
        if (body.onboarded === true) this.config.onboarded = true;
        // 网络模拟是会话级的（不落盘，重启自动恢复），改动实时同步到所有已开窗口。
        if (body.networkSim !== undefined) this.setNetworkSim(body.networkSim);
        // 用户偏好落盘（更新开关、跳过解密白名单），重启后保留
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        return this._json(res, 200, this._publicConfig());
      }
    }

    /** 更新检查：GET 查状态，POST 立即检查一次（手动按钮用） */
    if (parts[1] === 'update') {
      if (!this.updater) return this._json(res, 200, { enabled: false, current: null });
      if (method === 'GET') return this._json(res, 200, this.updater.status());
      if (method === 'POST') return this._json(res, 200, await this.updater.checkOnce(true));
    }

    // 导出 .p12 备份（含根证书 + 私钥）；导入密码通过响应头回传，UI 会提示用户保存
    if (parts[1] === 'ca' && method === 'GET' && parts[2] === 'p12') {
      if (!this.ca) return this._json(res, 404, { error: 'CA 未初始化' });
      const { der, password } = this.ca.exportP12();
      res.writeHead(200, {
        'content-type': 'application/x-pkcs12',
        'content-disposition': 'attachment; filename="ireq-root-ca.p12"',
        'x-ireq-p12-password': password,
        'content-length': der.length,
        'cache-control': 'no-store',
      });
      return res.end(der);
    }

    if (parts[1] === 'ca' && method === 'GET' && parts.length === 2) {
      return this._json(res, 200, {
        pem: this.ca ? this.ca.caPem : '',
        path: this.ca ? this.ca.caCertPath : '',
      });
    }

    return this._json(res, 404, { error: '未知接口: ' + pathname });
  }

  /* ---------------- 流量分页（往下滑无感加载） ----------------
   * 内存只留 maxFlows 条（设置页可调），磁盘上今天的文件才是全部。
   * 这里把两者接成一条逻辑流：先用 id 游标在内存里翻，翻完给一个 d: 游标，
   * 接着从落盘文件尾部往前读。前端拿到的 cursor 是不透明字符串，不关心它是什么。
   */
  _pageFilters(sp) {
    return {
      query: sp.get('q') || '',
      method: sp.get('method') || '',
      status: sp.get('status') || '',
      onlyMocked: sp.get('mocked') === '1',
      host: sp.get('host') || '',
      ip: sp.get('ip') || '',
      app: sp.get('app') || '',
      route: sp.get('route') || '',
    };
  }

  _flowsPage(sp) {
    const limit = Math.min(Math.max(Number(sp.get('limit')) || 200, 1), 500);
    const cursor = sp.get('cursor') || '';
    const filters = this._pageFilters(sp);
    const memoryTotal = this.store.flows.length;

    if (cursor.startsWith('d:')) {
      const [, rawTs, rawBytes] = cursor.split(':');
      const beforeTs = Number(rawTs) || 0;
      const bytes = Number(rawBytes) || null;
      try {
        const res = tailPage(this.store.todayFile(), {
          cursor: bytes,
          limit,
          filters: { ...filters, beforeTs },
        });
        return {
          flows: res.flows,
          nextCursor: res.hasMore ? `d:${beforeTs}:${res.nextCursor}` : '',
          hasMore: res.hasMore,
          total: memoryTotal,
          fromDisk: true,
        };
      } catch (_) {
        return { flows: [], nextCursor: '', hasMore: false, total: memoryTotal, fromDisk: true };
      }
    }

    const list = this.store.list({ ...filters, before: cursor, limit });
    if (list.length >= limit) {
      return {
        flows: list,
        nextCursor: list[list.length - 1].id,
        hasMore: true,
        total: memoryTotal,
      };
    }
    // 内存见底了：磁盘上还有更早的（今天的落盘文件），下一次请求接着往前读。
    // 用内存里最旧一条的时间当分界线，磁盘那边只给比它更早的，避免和内存重复。
    let oldest = 0;
    for (const f of this.store.flows) {
      const ts = Number(f.ts) || 0;
      if (!oldest || (ts && ts < oldest)) oldest = ts;
    }
    const canDisk = this.store.persist && oldest > 0;
    return {
      flows: list,
      nextCursor: canDisk ? `d:${oldest}:` : '',
      hasMore: canDisk,
      total: memoryTotal,
    };
  }

  /* ---------------- 历史记录：每次「清空」一条，可改名 / 回看 / 删除 ----------------
   *   GET    /api/history                  → 列表 + 总占用
   *   PATCH  /api/history/:id              → { name } 改名
   *   DELETE /api/history/:id              → 删掉这一条（连文件）
   *   DELETE /api/history                  → 全删
   *   GET    /api/history/:id/flows        → 分页回看（cursor 是字节游标）
   */
  async _apiHistory(req, res, parts, method, url) {
    const h = this.history;
    if (!h) return this._json(res, 400, { error: '未启用落盘，没有历史记录' });

    /* 导出这条历史：HAR（默认，能直接拖进浏览器 DevTools）或原始 JSONL 行 */
    if (parts[2] && parts[3] === 'export' && method === 'GET') {
      const sp = url.searchParams;
      const format = sp.get('format') === 'json' ? 'json' : 'har';
      const out = await h.exportFlows(parts[2], {
        filters: this._pageFilters(sp),
        limit: Math.min(Number(sp.get('limit')) || undefined, 50000),
      });
      if (out.error) {
        const gone = out.error === 'missing';
        return this._json(res, gone ? 410 : 404, { error: gone ? '文件已被删除' : '记录不存在' });
      }
      const flows = out.flows;
      const payload =
        format === 'json' ? flows.slice().reverse() : toHar(flows, VERSION);
      const data = Buffer.from(JSON.stringify(payload, null, format === 'har' ? 2 : 0));
      res.writeHead(200, {
        'content-type':
          format === 'har'
            ? 'application/har+json; charset=utf-8'
            : 'application/json; charset=utf-8',
        'content-disposition': exportDisposition(out.item, format),
        'content-length': data.length,
        'x-flow-count': String(flows.length),
        'x-export-truncated': out.truncated ? '1' : '0',
        'cache-control': 'no-store',
      });
      return res.end(data);
    }

    if (parts[2] && parts[3] === 'flows' && parts[4] && method === 'GET') {
      const out = h.getFlow(parts[2], parts[4]);
      if (out.error) {
        const gone = out.error === 'missing';
        return this._json(res, gone ? 410 : 404, {
          error: gone ? '文件已被删除' : '这条流量不在该记录里',
        });
      }
      return this._json(res, 200, out.flow);
    }

    /* 历史里重放：归档不参与抓包，但要能拿那条记录真发一次 */
    if (parts[2] && parts[3] === 'flows' && parts[4] && parts[5] === 'replay' && method === 'POST') {
      const out = h.getFlow(parts[2], parts[4]);
      if (out.error) {
        const gone = out.error === 'missing';
        return this._json(res, gone ? 410 : 404, {
          error: gone ? '文件已被删除' : '这条流量不在该记录里',
        });
      }
      const body = (await this._body(req)) || {};
      const result = await replay({ store: this.store, flow: out.flow, overrides: body || {} });
      return this._json(res, 200, result);
    }

    if (parts[2] && parts[3] === 'flows' && method === 'GET') {
      const sp = url.searchParams;
      const limit = Math.min(Math.max(Number(sp.get('limit')) || 200, 1), 500);
      const cursor = sp.get('cursor');
      const out = h.page(parts[2], {
        cursor: cursor ? Number(cursor) : null,
        limit,
        filters: this._pageFilters(sp),
      });
      if (out.error) {
        const gone = out.error === 'missing';
        return this._json(res, gone ? 410 : 404, { error: gone ? '文件已被删除' : '记录不存在' });
      }
      return this._json(res, 200, {
        flows: out.flows,
        nextCursor: out.hasMore ? String(out.nextCursor) : '',
        hasMore: out.hasMore,
        total: out.item.count == null ? null : out.item.count,
        item: out.item,
      });
    }

    if (method === 'GET') {
      return this._json(res, 200, { items: h.list(), stats: h.stats() });
    }

    if (method === 'DELETE' && parts.length === 2) {
      const removed = h.clearAll();
      this._broadcast({ type: 'history-changed' });
      return this._json(res, 200, { ok: true, removed, items: [], stats: h.stats() });
    }

    if (parts[2] && method === 'PATCH') {
      const body = (await this._body(req)) || {};
      const item = h.rename(parts[2], body.name);
      if (!item) return this._json(res, 404, { error: '记录不存在' });
      this._broadcast({ type: 'history-changed', item });
      return this._json(res, 200, { ok: true, item });
    }

    if (parts[2] && method === 'DELETE') {
      const ok = h.remove(parts[2]);
      this._broadcast({ type: 'history-changed' });
      return this._json(res, ok ? 200 : 404, { ok, items: h.list(), stats: h.stats() });
    }

    return this._json(res, 405, { error: 'method not allowed' });
  }

  /**
   * MCP 管理接口（本机控制台专用，和 /api/* 同权限）：
   *   GET    /api/mcp                 → 状态 + 工具清单 + 令牌 + 最近审计
   *   PUT    /api/mcp                 → { enabled } 开关
   *   POST   /api/mcp/tokens          → { name, scopes, expiresInDays } 生成（明文只返回一次）
   *   DELETE /api/mcp/tokens/:id      → 撤销
   *   DELETE /api/mcp/audit           → 清空审计
   */
  async _apiMcp(req, res, parts, method, url) {
    const auth = this.mcpAuth;
    const endpoint = `http://127.0.0.1:${this.port}/mcp`;

    if (parts[2] === 'tokens' && method === 'DELETE' && parts[3]) {
      const ok = auth.revokeToken(parts[3]);
      return this._json(res, ok ? 200 : 404, { ok, ...this._mcpView(endpoint) });
    }

    if (parts[2] === 'audit' && method === 'DELETE') {
      auth.clearAudit();
      return this._json(res, 200, { ok: true, audit: [] });
    }

    if (parts[2] === 'tokens' && method === 'POST') {
      const body = (await this._body(req)) || {};
      const scopes = body.scopes === 'read' ? ['read'] : ['read', 'write'];
      const out = auth.createToken({
        name: body.name,
        scopes,
        expiresInDays: body.expiresInDays,
      });
      if (!auth.enabled) auth.setEnabled(true); /* 生成令牌即视为要用，省一步 */
      return this._json(res, 200, {
        ok: true,
        token: out.token,
        entry: out.entry,
        endpoint,
        /* 直接可粘贴的客户端配置：token 明文只在这个响应里出现 */
        snippet: {
          http: {
            mcpServers: {
              ireq: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${out.token}` } },
            },
          },
          stdio: {
            mcpServers: {
              ireq: {
                command: 'ireq',
                args: ['mcp', '--url', endpoint, '--token', out.token],
              },
            },
          },
        },
        ...this._mcpView(endpoint),
      });
    }

    if (parts.length === 2 && method === 'GET') {
      const limit = Number(url.searchParams.get('audit')) || 20;
      return this._json(res, 200, { ...this._mcpView(endpoint), audit: auth.audit(limit) });
    }

    if (parts.length === 2 && method === 'PUT') {
      const body = (await this._body(req)) || {};
      if (typeof body.enabled !== 'boolean') {
        return this._json(res, 400, { error: 'enabled 必须是布尔值' });
      }
      auth.setEnabled(body.enabled);
      return this._json(res, 200, { ok: true, ...this._mcpView(endpoint) });
    }

    return this._json(res, 405, { error: '不支持的方法' });
  }

  /** MCP 状态视图（绝不含 hash / salt） */  _mcpView(endpoint) {
    return {
      enabled: this.mcpAuth.enabled,
      endpoint,
      protocols: mcp.PROTOCOL_VERSIONS,
      protocols_latest: mcp.LATEST_PROTOCOL,
      transport: 'streamable-http',
      tools: mcp.TOOLS.map((t) => ({ name: t.name, title: t.title, scope: t.scope })),
      tokens: this.mcpAuth.listTokens(),
      stats: this.mcpAuth.stats(),
    };
  }

  /** 配置外发前抹掉凭据：MCP 令牌的 hash / salt 绝不出进程 */
  _publicConfig() {
    const out = { ...this.config };
    if (out.mcp) {
      out.mcp = {
        enabled: this.config.mcp.enabled === true,
        tokenCount: (this.config.mcp.tokens || []).length,
      };
    }
    // 设置页要显示 data 目录占了多大：用户不会自己跑去 Application Support 里数文件，
    // 而 flows 一旦失控（清空归档堆积）能涨到几百 MB。
    out.diskUsage = this._diskUsage();
    return out;
  }

  /** data 目录的文件数与总字节数；只在拉配置时算一次，几百个文件的开销可以忽略 */
  _diskUsage() {
    if (!this.dataDir) return null;
    let bytes = 0;
    let files = 0;
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 6) walk(p, depth + 1);
        } else if (e.isFile()) {
          try {
            bytes += fs.statSync(p).size;
            files += 1;
          } catch (_) {
            /* 文件刚好被删掉 */
          }
        }
      }
    };
    walk(this.dataDir, 0);
    return { bytes, files };
  }

  _caFile(res, format = 'pem') {
    if (!this.ca) return this._json(res, 404, { error: 'CA 未初始化' });
    if (format === 'der') {
      const der = this.ca.der;
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="ireq-ca.cer"',
        'content-length': der.length,
        'cache-control': 'no-store',
      });
      return res.end(der);
    }
    const pem = this.ca.caPem;
    res.writeHead(200, {
      'content-type': 'application/x-pem-file',
      'content-disposition': 'attachment; filename="ireq-ca.pem"',
      'content-length': Buffer.byteLength(pem),
      'cache-control': 'no-store',
    });
    res.end(pem);
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve(null);
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          resolve(null);
        }
      });
      req.on('error', reject);
    });
  }

  _json(res, code, payload) {
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  _static(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(this.publicDir, rel);
    if (!file.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found: ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  stop() {
    for (const c of this.clients) {
      try {
        c.end();
      } catch (_) {
        /* noop */
      }
    }
    this.clients.clear();
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }
}

module.exports = { ConsoleServer };
