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
const { summary } = require('./store');
const { parseAppAliases } = require('./derive');
const { savePersistedConfig } = require('./user-config');

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
        passthrough: this.config.passthrough,
        mitmPorts: this.config.mitmPorts,
        rules: this.rules.list().length,
        caPath: this.ca ? this.ca.caCertPath : null,
        caCreated: this.ca ? this.ca.created : false,
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
        appIcons: this.appIcons ? this.appIcons.status() : { supported: false },
        version: require('../package.json').version,
        update: this.updater ? this.updater.status() : null,
      });
    }

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
      const payload = format === 'json' ? flows.slice().reverse() : toHar(flows, require('../package.json').version);
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

    if (parts[1] === 'diagnostics' && method === 'GET') {
      const diag = this.proxy ? this.proxy.diagnostics() : { tlsFailures: [], tunneled: 0 };
      return this._json(res, 200, {
        ...diag,
        passthrough: this.config.passthrough || [],
        mitmPorts: this.config.mitmPorts || [443],
      });
    }

    if (parts[1] === 'ca-trust' && (method === 'GET' || method === 'POST')) {
      if (!this.caTrust) return this._json(res, 404, { error: '证书信任检测模块未启用' });
      const caTrust = this._syncTrust(method === 'POST');
      return this._json(res, 200, { ...caTrust, safeMode: this._safeMode() });
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
      return this._json(res, 200, { flows, ...this.store.facets() });
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
      if (method === 'POST' && (parts[2] === 'fs' || parts[2] === 'move')) {
        const body = (await this._body(req)) || {};
        try {
          const out = parts[2] === 'fs' ? this.rules.create(body) : this.rules.move(body);
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
      if (method === 'GET') return this._json(res, 200, this.config);
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        if (typeof body.capture === 'boolean') this.config.capture = body.capture;
        if (Array.isArray(body.passthrough)) {
          this.config.passthrough = body.passthrough
            .map((s) => String(s).trim())
            .filter(Boolean);
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
        // 用户偏好落盘（目前只有更新开关），重启后保留
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        return this._json(res, 200, this.config);
      }
    }

    /** 更新检查：GET 查状态，POST 立即检查一次（手动按钮用） */
    if (parts[1] === 'update') {
      if (!this.updater) return this._json(res, 200, { enabled: false, current: null });
      if (method === 'GET') return this._json(res, 200, this.updater.status());
      if (method === 'POST') return this._json(res, 200, await this.updater.checkOnce(true));
    }

    if (parts[1] === 'ca' && method === 'GET') {
      return this._json(res, 200, {
        pem: this.ca ? this.ca.caPem : '',
        path: this.ca ? this.ca.caCertPath : '',
      });
    }

    return this._json(res, 404, { error: '未知接口: ' + pathname });
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
