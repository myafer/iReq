'use strict';

/**
 * MITM 代理核心：
 *   明文 HTTP  -> 直接转发
 *   HTTPS      -> CONNECT 后自己跟客户端握手（动态签发证书），解出明文再转发
 *   WebSocket  -> 原样建隧道透传（不解密，仅记录建连）
 *
 * 记录一份 flow，交给 store；命中 Mock 规则则本地直返。
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { clientIpOf, clientPortOf, platformOf, appOf, aliasOf, routeOf } = require('./derive');
const { ProcessMap } = require('./process-map');
const { deviceKeyOf, deviceLabelOf } = require('./local-address');
const { normalize: normalizeNetworkSim, resolve: resolveNetworkSim, throttleTransform } = require('./network-sim');

const MAX_BODY_CAPTURE = 2 * 1024 * 1024; // 每个 body 最多记录 2MB
const TEXTUAL_RE =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|problem\+json|x-js)|application\/[\w.+-]*\+(json|xml)|image\/svg)/i;

const DROP_HEADERS = ['proxy-connection', 'proxy-authorization', 'proxy-authenticate'];

function isTextual(contentType) {
  return !!contentType && TEXTUAL_RE.test(String(contentType));
}

function splitHostPort(value) {
  const s = String(value || '');
  const i = s.lastIndexOf(':');
  const withoutBrackets = (h) => h.replace(/^\[/, '').replace(/\]$/, '');
  if (i === -1) return [withoutBrackets(s), 443];
  return [withoutBrackets(s.slice(0, i)), Number(s.slice(i + 1)) || 443];
}

/** 跳过解密规则的域名匹配：规则可写 example.com 或 *.example.com，命中自身与所有子域 */
function passthroughMatches(host, rules) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return (rules || []).some((p) => {
    const rule = String(p || '').trim().toLowerCase().replace(/^\*?\./, '');
    return !!rule && (h === rule || h.endsWith('.' + rule));
  });
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (!enc || !buf || !buf.length) return buf;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('zstd') && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  } catch (_) {
    /* 压缩格式不标准就按原始字节处理 */
  }
  return buf;
}

class BodyCapture {
  constructor(contentType, contentEncoding, limit = MAX_BODY_CAPTURE) {
    this.chunks = [];
    this.size = 0;
    this.kept = 0;
    this.limit = limit;
    this.contentType = contentType;
    this.contentEncoding = contentEncoding;
    this.truncated = false;
  }

  push(chunk) {
    this.size += chunk.length;
    if (this.kept >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.kept;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(Buffer.from(slice));
    this.kept += slice.length;
    if (slice.length < chunk.length) this.truncated = true;
  }

  /** 返回 { text, base64, size, truncated } —— 文本类给 text，二进制给 base64 摘要 */
  digest() {
    const raw = Buffer.concat(this.chunks);
    const decoded = decompress(raw, this.contentEncoding);
    const textual = isTextual(this.contentType);
    return {
      size: this.size,
      truncated: this.truncated,
      text: textual ? decoded.toString('utf8') : null,
      base64: textual || !decoded.length ? null : decoded.toString('base64'),
      decodedSize: decoded.length,
    };
  }
}

class ProxyServer extends EventEmitter {
  constructor({ port = 9090, host = '0.0.0.0', ca, store, rules, config = {}, processMap } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.ca = ca;
    this.store = store;
    this.rules = rules;
    // 本机流量可以按「源端口 → 进程」拿到真实应用名；远程设备拿不到，走 UA。
    this.processMap = processMap || new ProcessMap();
    // 注意：必须复用传入的 config 引用（控制台改设置时是直接改这个对象），
    // 以前用 {...config} 新建对象，导致 UI 切换抓包 / 改透传域名对代理无效。
    const cfg = config || {};
    if (cfg.capture === undefined) cfg.capture = true;
    if (cfg.mockEnabled === undefined) cfg.mockEnabled = true;
    if (!Array.isArray(cfg.passthrough)) cfg.passthrough = [];
    if (!Array.isArray(cfg.mitmPorts)) cfg.mitmPorts = [443];
    cfg.networkSim = normalizeNetworkSim(cfg.networkSim);
    this.config = cfg;
    this.connections = new Set();
    this.stats = { total: 0, mocked: 0, errors: 0, bytes: 0, tunneled: 0, tlsFailed: 0, safeTunneled: 0 };
    // 握手失败的域名：客户端不认我们的证书（证书固定 / App 自带校验），提示用户加白名单
    this.tlsFailures = new Map();
    // CONNECT 阶段拿不到 UA，靠历史 flow 把 host / IP 关联到应用名，规则才能命中手机 / 模拟器
    this.appHints = { byHost: new Map(), byIp: new Map() };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('connect', (req, socket, head) => this._handleConnect(req, socket, head));
      this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        // 连接一建立就登记源端口：lsof 快照是异步的，等请求进来再查可能已经错过短连接
        const port = Number(socket.remotePort || (socket._parent && socket._parent.remotePort) || 0);
        const ip = socket.remoteAddress || (socket._parent && socket._parent.remoteAddress);
        if (port && this.config.processMap !== false) this.processMap.observe(port, ip);
        socket.on('close', () => this.connections.delete(socket));
        socket.on('error', () => {});
      });
      this.server.on('clientError', (err, socket) => {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        } catch (_) {
          /* noop */
        }
      });
      // 保活：默认 5s 太短，App 复用连接时容易撞上刚被关掉的 socket，表现为"偶发连不上"
      this.server.keepAliveTimeout = 65000;
      this.server.headersTimeout = 70000;
      this.server.requestTimeout = 0;
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    for (const socket of this.connections) {
      try {
        socket.destroy();
      } catch (_) {
        /* noop */
      }
    }
    this.connections.clear();
    this.processMap.stop();
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }

  // ---------------------------------------------------------------- CONNECT

  /**
   * 是否解密这条 CONNECT。抽成方法便于自检覆盖各种分支。
   *
   * 关键的安全模式：本机根证书没被信任、且系统代理是本工具接管的，
   * 此时若照常给本机 HTTPS 签自签证书，Chrome 会直接报「您的连接不是私密连接」，
   * 连带把所有网站搞坏。所以这种组合下让本机 HTTPS 原样透传 —— 上网不受影响，
   * 只是暂时看不到 HTTPS 明文；装好根证书后自动恢复解密。
   *
   * 只限制「本机 + 系统代理接管」：手机流量不受影响，显式 --proxy 的自检/开发流量也不受影响。
   */
  _shouldDecrypt(host, port, clientIp) {
    if (passthroughMatches(host, this.config.passthrough)) {
      // 兜底：白名单也可能来自启动配置 / 落盘文件，没经过 /api/config PUT。
      // 这里顺手清掉该域名遗留的握手失败诊断，避免「已加白名单还挂在列表顶部」。
      this.clearTlsFailures(host);
      return { decrypt: false, reason: 'passthrough' };
    }

    // 只有 443（或显式配置的端口）才尝试解密，其余端口原样透传。
    // 否则 MQTT / IMAP / 私有二进制 TLS 协议都会被我们"HTTP 化"，App 直接连不上。
    const mitmPorts = this.config.mitmPorts || [443];
    if (!(port === 443 || mitmPorts.includes(port))) return { decrypt: false, reason: 'port' };

    if (
      this.config.caTrusted === false &&
      this.config.localProxyOurs === true &&
      ProcessMap.isLocalAddress(clientIp)
    ) {
      return { decrypt: false, reason: 'untrusted-ca' };
    }
    return { decrypt: true, reason: 'mitm' };
  }

  // ------------------------------------------------------------ 网络模拟

  /** CONNECT 只有 host + 源端口，UA 还拿不到：本机查进程，远程用历史 flow 学到的 host / IP 关联 */
  _simFact(req, host, socket) {
    const meta = this._appMeta(req);
    const ip = meta.clientIp || clientIpOf(req) || (socket && socket.remoteAddress) || '';
    let app = String(meta.app || '');
    const unknown = !app || /未知|未识别|unknown/i.test(app);
    if (unknown && host) app = this.appHints.byHost.get(String(host).toLowerCase()) || app;
    if (unknown && ip) app = this.appHints.byIp.get(String(ip).toLowerCase()) || app;
    return { app, host, ip, deviceLabel: meta.deviceLabel || '' };
  }

  _simConnectRecord(req, host, port, sim) {
    if (this.config.capture === false) return;
    const text =
      sim.mode === 'offline'
        ? 'iReq 断网模拟：连接已重置'
        : `iReq 超时模拟：挂起 ${sim.timeoutMs}ms 后断开`;
    try {
      this._record({
        method: 'CONNECT',
        url: `https://${host}${port === 443 ? '' : ':' + port}/`,
        scheme: 'https',
        host,
        path: '/',
        status: 0,
        duration: sim.mode === 'timeout' ? sim.timeoutMs : 0,
        reqHeaders: { ...(req.headers || {}) },
        resHeaders: {},
        reqBody: '',
        resBody: '',
        ...this._appMeta(req),
        route: 'CONNECT /',
        error: text,
        simMode: sim.mode,
        simRule: sim.rule.match,
      });
    } catch (_) {
      /* 记录失败绝不能影响模拟本身 */
    }
  }

  /** 断网 = 立刻重置连接（贴近真实断网）；超时 = 不回 200，挂到时限再断 */
  _simBlockConnect(req, socket, host, port, sim) {
    this._simConnectRecord(req, host, port, sim);
    if (sim.mode === 'offline') {
      try {
        socket.destroy();
      } catch (_) {
        /* noop */
      }
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch (_) {
        /* noop */
      }
    }, sim.timeoutMs);
    socket.on('close', () => clearTimeout(timer));
  }

  _handleConnect(req, clientSocket, head) {
    const [host, port] = splitHostPort(req.url);
    clientSocket.on('error', () => {});

    // 用 https 打开代理端口（常见于浏览器自动把 http 升级成 https）：
    // 此时还没装证书，握手必然失败，给出明确中文提示而不是让浏览器报「证书错误」
    if (this._isSelfAddress(host, port)) {
      const msg =
        'iReq: 不要用 https 打开这个地址。\n\n' +
        '请改用 http:// 开头的地址下载证书，例如：\n' +
        `  http://${this._hostForDisplay()}:${this.port}/\n\n` +
        '如果浏览器自动跳到了 https，可以先把 Wi-Fi 代理关掉再打开上面的地址。\n';
      const body = Buffer.from(msg, 'utf8');
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Connection: close\r\n\r\n' +
          msg
      );
      return;
    }

    const sim = resolveNetworkSim(this.config.networkSim, this._simFact(req, host, clientSocket));
    // 断网 / 超时必须在 CONNECT 这一层拦掉：等 TLS 握手失败再拦，客户端看到的就变成证书错误了。
    // 弱网交给请求层做延迟 + 限速（透传隧道例外，见下面）。
    if (sim && sim.mode !== 'weak') {
      return this._simBlockConnect(req, clientSocket, host, port, sim);
    }

    const decision = this._shouldDecrypt(host, port, clientSocket.remoteAddress);
    if (!decision.decrypt) {
      if (decision.reason === 'untrusted-ca') {
        this.stats.safeTunneled += 1;
        // 透传也要留一条记录：否则用户会发现「代理明明开着，列表却一直是空的」，
        // 完全不知道流量其实经过了这里、只是没被解密。
        if (this.config.capture !== false) {
          try {
            this._record({
              method: 'CONNECT',
              url: `https://${host}${port === 443 ? '' : ':' + port}/`,
              scheme: 'https',
              host,
              path: '/',
              status: 0,
              duration: 0,
              reqHeaders: { ...(req.headers || {}) },
              resHeaders: {},
              reqBody: '',
              resBody: '',
              ...this._appMeta(req),
              route: 'CONNECT /',
              tunneled: true,
              note:
                '本机根证书未信任，为避免浏览器报「连接不是私密连接」，这条 HTTPS 已原样透传，看不到明文。' +
                '到「设置 › 本机抓包」把根证书设为始终信任，再点「重新检测」即可恢复解密。',
            });
          } catch (_) {
            /* 记录失败绝不能影响转发 */
          }
        }
      }
      this.stats.tunneled += 1;
      const establish = () => {
        const upstream = net.connect(port, host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) upstream.write(head);
          if (sim && sim.mode === 'weak') {
            // 透传隧道看不到明文请求，只能在字节层做延迟 + 限速
            const down = throttleTransform(sim.kbps);
            const up = throttleTransform(sim.kbps);
            upstream.pipe(down).pipe(clientSocket);
            clientSocket.pipe(up).pipe(upstream);
            clientSocket.on('close', () => {
              down.destroy();
              up.destroy();
            });
          } else {
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
          }
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('close', () => upstream.destroy());
      };
      if (sim && sim.mode === 'weak' && sim.latencyMs > 0) {
        const timer = setTimeout(establish, sim.latencyMs);
        clientSocket.on('close', () => clearTimeout(timer));
      } else establish();
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);

    let ctx;
    try {
      ctx = this.ca.getSecureContext(host);
    } catch (err) {
      clientSocket.destroy();
      return;
    }

    let secure = false;
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: ctx,
      // 以客户端给的 SNI 动态签证书：CONNECT 到 IP、SNI 是域名时也能对上
      SNICallback: (servername, cb) => {
        try {
          tlsSocket.__sni = servername;
          cb(null, this.ca.getSecureContext(servername));
        } catch (err) {
          cb(err);
        }
      },
      ALPNProtocols: ['http/1.1'],
    });
    tlsSocket.__mitmHost = host;
    tlsSocket.__mitmPort = port;
    // 保留原始 TCP socket 的地址/端口：进程识别只认这一层，TLSSocket 上取不到
    tlsSocket.__reqliteClientSocket = clientSocket;
    tlsSocket.__reqliteClientPort = clientSocket.remotePort;
    tlsSocket.__reqliteClientIp = clientSocket.remoteAddress;
    tlsSocket.once('secure', () => {
      secure = true;
      // 后端删了也要通知前端：否则控制台要刷新页面才会消掉那条诊断行
      this.clearTlsFailures(host);
    });
    tlsSocket.once('close', () => {
      // 走到这里说明这条 TLS 连接一次请求都没成功发出来（_handle 会打 __used）
      // 这通常就是"App 连不上"的真凶：客户端不认证书、或协议不是 HTTP
      if (!tlsSocket.__used) {
        // getCipher() 在 socket 已销毁时会抛，用内部标记判断"握手是否真正完成"
        let established = tlsSocket._secureEstablished === true;
        if (!established) {
          try {
            established = !!tlsSocket.getCipher();
          } catch (_) {
            /* 没协商出来 */
          }
        }
        // 只有"握手根本没成"才算失败；握手成功但没发请求多半是预连接，不算问题
        if (!established) {
          // close 和 error 可能都触发，同一条连接只算一次
          if (!tlsSocket.__tlsFailureNoted) {
            tlsSocket.__tlsFailureNoted = true;
            this._noteTlsFailure(host, port, new Error('TLS 握手失败（客户端可能不信任证书，或不是 HTTP 协议）'));
          }
        }
      }
    });
    tlsSocket.on('error', (err) => {
      if (!secure && !tlsSocket.__tlsFailureNoted) {
        tlsSocket.__tlsFailureNoted = true;
        this._noteTlsFailure(host, port, err);
      }
      try {
        clientSocket.destroy();
      } catch (_) {
        /* noop */
      }
    });
    this.server.emit('connection', tlsSocket);
  }

  /**
   * 应用名优先级：本机真实进程 > 用户配的 UA 别名 > UA 推断。
   * 带 appSource，让控制台能说清「这个名字是查出来的还是猜出来的」。
   */
  _appMeta(req) {
    const ua = (req.headers || {})['user-agent'];
    const port = clientPortOf(req);
    const ip = clientIpOf(req);
    const enabled = this.config.processMap !== false && this.processMap.supported;
    const proc = enabled && ProcessMap.isLocalAddress(ip) ? this.processMap.lookup(port) : null;
    const alias = proc ? null : aliasOf(ua, this.config.uaAppMap);
    const platform = platformOf(ua);
    const meta = {
      clientIp: ip,
      deviceKey: deviceKeyOf(ip),
      deviceLabel: deviceLabelOf(ip, platform),
      platform,
      app: proc ? proc.name : alias || appOf(ua, this.config.uaAppMap),
      appSource: proc ? 'process' : alias ? 'alias' : 'ua',
      process: proc
        ? { pid: proc.pid, name: proc.name, command: proc.command, path: proc.path }
        : null,
    };
    if (port) meta.clientPort = port;
    return meta;
  }

  /**
   * 清掉某个域名（或某条跳过解密规则覆盖的所有子域）的握手失败诊断。
   * 只在真的删到记录时广播 tls-remove，避免高频 CONNECT 无谓刷 SSE。
   */
  clearTlsFailures(hostOrRule) {
    const rule = String(hostOrRule || '').trim().toLowerCase().replace(/^\*?\./, '');
    if (!rule || !this.tlsFailures.size) return 0;
    const hosts = [];
    for (const h of this.tlsFailures.keys()) {
      const lh = String(h).toLowerCase();
      if (lh === rule || lh.endsWith('.' + rule)) hosts.push(h);
    }
    for (const h of hosts) this.tlsFailures.delete(h);
    if (hosts.length) this.emit('tls-remove', { hosts });
    return hosts.length;
  }

  _noteTlsFailure(host, port, err) {
    // 已加入跳过解密的域名不再解密，理论上不会再失败；但加白名单之前建立的
    // 旧 MITM 连接可能晚一点才报错，别让它把刚清掉的记录又顶回列表顶部。
    if (passthroughMatches(host, this.config.passthrough)) return;
    this.stats.tlsFailed += 1;
    const rec = this.tlsFailures.get(host) || { host, port, count: 0, error: '', lastAt: 0 };
    rec.count += 1;
    rec.error = String((err && err.message) || err).slice(0, 160);
    rec.lastAt = Date.now();
    this.tlsFailures.set(host, rec);
    // 实时推给控制台：握手失败直接出现在主列表，不必去设置页翻诊断区
    this.emit('tls-failure', { ...rec });
  }

  /** 诊断信息：握手失败的域名，可直接拿来加进「跳过解密的域名」 */
  diagnostics() {
    return {
      tlsFailures: [...this.tlsFailures.values()].sort((a, b) => b.count - a.count),
      tunneled: this.stats.tunneled,
      safeTunneled: this.stats.safeTunneled,
      safeMode: this.config.caTrusted === false && this.config.localProxyOurs === true,
      stats: this.stats,
    };
  }

  // -------------------------------------------------------------- WebSocket

  _handleUpgrade(req, socket, head) {
    const mitmHost = req.socket.__mitmHost;
    const mitmPort = req.socket.__mitmPort;
    let target;
    try {
      target = mitmHost
        ? new URL(`https://${mitmHost}${mitmPort && mitmPort !== 443 ? ':' + mitmPort : ''}${req.url}`)
        : /^https?:\/\//i.test(req.url)
        ? new URL(req.url)
        : new URL(`http://${req.headers.host}${req.url}`);
    } catch (_) {
      socket.destroy();
      return;
    }

    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const upstream = net.connect(port, target.hostname, () => {
      const headers = [];
      headers.push(`${req.method} ${target.pathname}${target.search || ''} HTTP/1.1`);
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'proxy-connection') continue;
        headers.push(`${k}: ${v}`);
      }
      upstream.write(headers.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());

    if (this.config.capture) {
      this._record({
        method: req.method,
        url: target.toString(),
        host: target.hostname,
        scheme: target.protocol.replace(':', ''),
        path: (target.pathname || '/') + (target.search || ''),
        reqHeaders: { ...req.headers },
        ...this._appMeta(req),
        route: routeOf(req.method, target.pathname || '/'),
        resHeaders: {},
        status: 101,
        statusText: 'Switching Protocols',
        reqBody: null,
        resBody: null,
        reqSize: 0,
        resSize: 0,
        duration: 0,
        ws: true,
      });
    }
  }

  // ----------------------------------------------------------------- HTTP

  /** host:port 是不是代理自己（会导致无限自我转发） */
  _isSelfAddress(hostname, port) {
    if (Number(port) !== this.port) return false;
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (!this._localIps) {
      this._localIps = new Set(['127.0.0.1', '::1']);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const nic of list || []) if (nic.address) this._localIps.add(nic.address.toLowerCase());
      }
    }
    return this._localIps.has(host);
  }

  _isSelfUrl(url) {
    try {
      const u = new URL(url);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      return this._isSelfAddress(u.hostname, port);
    } catch (_) {
      return false;
    }
  }

  /** 展示给用户的“本机地址”：优先用请求 Host，否则取第一个局域网 IPv4 */
  _hostForDisplay(req) {
    const hostHeader = req && req.headers && req.headers.host;
    if (hostHeader) {
      const h = hostHeader.split(':')[0];
      if (h) return h;
    }
    if (!this._localIps) {
      this._localIps = new Set(['127.0.0.1', '::1']);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const nic of list || []) if (nic.address) this._localIps.add(nic.address.toLowerCase());
      }
    }
    for (const ip of this._localIps) if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1') return ip;
    return '127.0.0.1';
  }

  /** 代理端口上的本地路由：安装页 + 证书下载 */
  _serveLocal(req, res, rawPath) {
    const pathname = String(rawPath || '/').split('?')[0];
    const onlyGet = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/ca.pem' || pathname === '/ireq-ca.pem' || pathname === '/reqlite-ca.pem') {
      const pem = this.ca.caPem;
      res.writeHead(200, {
        'content-type': 'application/x-pem-file',
        'content-disposition': 'attachment; filename="reqlite-ca.pem"',
        'content-length': Buffer.byteLength(pem),
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : pem);
    }

    if (pathname === '/ca.cer' || pathname === '/ca.crt' || pathname === '/ca.der') {
      const der = this.ca.der;
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="reqlite-ca.cer"',
        'content-length': der.length,
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : der);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/install') {
      if (!onlyGet) {
        res.writeHead(405, { allow: 'GET, HEAD' });
        return res.end();
      }
      const html = this._installPage(req);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      });
      return res.end(html);
    }

    const body = Buffer.from(`iReq: 没有这个路由 ${pathname}\n试试 / 或 /ca.cer\n`, 'utf8');
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }

  _installPage(req) {
    const templatePath = path.join(__dirname, '..', 'public', 'install.html');
    const proxy = `${this._hostForDisplay(req)}:${this.port}`;
    try {
      return fs.readFileSync(templatePath, 'utf8').replace(/__PROXY__/g, proxy);
    } catch (_) {
      return `<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1">
<h1>安装 iReq 根证书</h1>
<p>代理：${proxy}</p>
<p><a href="/ca.cer">下载证书（.cer）</a> · <a href="/ca.pem">下载 PEM</a></p>
<ol>
<li>iOS：设置 › 已下载描述文件 › 安装</li>
<li>设置 › 通用 › 关于本机 › 证书信任设置 › 打开 iReq Root CA</li>
</ol>`;
    }
  }

  _handle(req, res) {
    req.socket.__used = true;
    const mitmHost = req.socket.__mitmHost;
    const mitmPort = req.socket.__mitmPort;
    const sni = req.socket.__sni;
    const absolute = /^https?:\/\//i.test(req.url);

    // 本机自身路由：证书下载 / 安装页
    if (!mitmHost && (!absolute || this._isSelfUrl(req.url))) {
      return this._serveLocal(req, res, absolute ? new URL(req.url).pathname : req.url);
    }

    // CONNECT 到 IP、但 TLS 里带了 SNI（CDN、直连 IP 的 App）：以 SNI 为准，否则证书和 Host 都会错
    let authorityHost = mitmHost;
    if (mitmHost && sni && (net.isIP(mitmHost) || sni.includes('.'))) authorityHost = sni;

    let target;
    try {
      if (absolute) target = new URL(req.url);
      else if (authorityHost)
        target = new URL(
          `https://${authorityHost}${mitmPort && mitmPort !== 443 ? ':' + mitmPort : ''}${req.url}`
        );
      else target = new URL(`http://${req.headers.host || '127.0.0.1'}${req.url}`);
    } catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('iReq: 无法解析请求地址');
      req.resume();
      return;
    }

    const startedAt = process.hrtime.bigint();
    const reqCapture = new BodyCapture(req.headers['content-type'], req.headers['content-encoding']);
    // 边转发边记录，不整体缓存请求体：大上传、长连接不会被卡住
    req.on('data', (chunk) => {
      if (this.config.capture) reqCapture.push(chunk);
    });

    const meta = {
      method: req.method,
      url: target.toString(),
      host: target.hostname,
      scheme: target.protocol.replace(':', ''),
      path: (target.pathname || '/') + (target.search || ''),
      reqHeaders: { ...req.headers },
      ...this._appMeta(req),
      route: routeOf(req.method, target.pathname || '/'),
    };

    const ctx = { req, res, target, startedAt, reqCapture, meta };
    // 请求一进来就出现在列表和侧栏，不等上游响应
    ctx.flow = this._begin(ctx);
    // 客户端 / 上游提前断开（没有走完任何收尾分支）时，别让「进行中」永远挂着
    if (ctx.flow) {
      res.once('close', () => {
        const flow = ctx.flow;
        if (!flow || !flow.pending) return;
        setImmediate(() => {
          if (!flow.pending || this.store.index.get(flow.id) !== flow) return;
          this.store.finish(flow, {
            status: 0,
            statusText: '',
            duration: elapsed(startedAt),
            error: 'iReq: 请求未完成（连接已关闭）',
          });
        });
      });
    }

    // 防自环
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    if (this._isSelfAddress(target.hostname, targetPort)) {
      this.stats.errors += 1;
      const msg = `iReq: 目标 ${target.host} 就是代理自己，已拦截（避免无限转发）。\n证书安装页在 http://${this._hostForDisplay(req)}:${this.port}/\n`;
      res.writeHead(508, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(msg);
      req.resume();
      if (this.config.capture) {
        this._record({
          ...meta,
          reqBody: null,
          reqSize: 0,
          resHeaders: { 'content-type': 'text/plain; charset=utf-8' },
          resBody: msg,
          resSize: msg.length,
          status: 508,
          statusText: 'Loop Detected',
          duration: 0,
          error: msg,
        }, ctx);
      }
      return;
    }

    // 网络模拟：这里已能看到完整 URL / UA，比 CONNECT 阶段识别应用更准
    const sim = resolveNetworkSim(this.config.networkSim, this._simFact(req, target.hostname, req.socket));
    if (sim && sim.mode !== 'weak') return this._simBlockHttp(ctx, sim);
    // 弱网的限速参数随 ctx 传给 _forward；延迟放在真正发起请求之前
    ctx.sim = sim && sim.mode === 'weak' ? sim : null;

    // Mock 与「抓包开关」解耦：关掉记录时规则依旧生效；
    // 总开关（dock / 设置）关掉时所有规则整体旁路，直接转发。
    const run = () => {
      if (this.config.mockEnabled === false) return this._forward(ctx);
      const rule = this.rules.match({
        method: req.method,
        url: target.toString(),
        host: target.hostname,
      });
      if (rule) return this._replyMock(ctx, rule);
      this._forward(ctx);
    };
    if (ctx.sim && ctx.sim.latencyMs > 0) {
      const timer = setTimeout(run, ctx.sim.latencyMs);
      req.on('aborted', () => clearTimeout(timer));
      req.socket.on('close', () => clearTimeout(timer));
    } else run();
  }

  /** 断网：直接重置连接；超时：不写任何响应，挂到时限再断 */
  _simBlockHttp(ctx, sim) {
    const { req, meta, startedAt } = ctx;
    const text =
      sim.mode === 'offline'
        ? 'iReq 断网模拟：连接已重置'
        : `iReq 超时模拟：挂起 ${sim.timeoutMs}ms 后断开`;
    if (this.config.capture !== false) {
      this._record({
        ...meta,
        reqBody: '',
        reqSize: 0,
        resHeaders: {},
        resBody: '',
        resSize: 0,
        status: 0,
        statusText: '',
        duration: sim.mode === 'timeout' ? sim.timeoutMs : elapsed(startedAt),
        error: text,
        simMode: sim.mode,
        simRule: sim.rule.match,
      }, ctx);
    }
    if (sim.mode === 'offline') {
      try {
        req.socket.destroy();
      } catch (_) {
        /* noop */
      }
      return;
    }
    const timer = setTimeout(() => {
      try {
        req.socket.destroy();
      } catch (_) {
        /* noop */
      }
    }, sim.timeoutMs);
    req.on('aborted', () => clearTimeout(timer));
    req.socket.on('close', () => clearTimeout(timer));
    req.resume();
  }

  _replyMock(ctx, rule) {
    const { req, res, meta, startedAt, reqCapture } = ctx;
    req.resume(); // 丢弃请求体，但保证连接正常收尾

    const send = () => {
      const outHeaders = { ...(rule.headers || {}) };
      const raw = rule.bodyBase64
        ? Buffer.from(rule.body || '', 'base64')
        : Buffer.from(rule.body || '', 'utf8');
      if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/json; charset=utf-8';
      if (rule.status !== 204 && rule.status !== 304) outHeaders['content-length'] = String(raw.length);
      outHeaders['x-reqlite-mock'] = encodeURIComponent(rule.name || rule.id);

      try {
        res.writeHead(rule.status || 200, outHeaders);
        res.end(meta.method === 'HEAD' ? undefined : raw);
      } catch (_) {
        res.destroy();
      }

      this.stats.mocked += 1;
      if (!this.config.capture) return;

      const reqDigest = reqCapture.digest();
      this._record({
        ...meta,
        reqBody: reqDigest.text,
        reqBodyBase64: reqDigest.base64,
        reqBodyTruncated: reqDigest.truncated,
        reqSize: reqDigest.size,
        resHeaders: outHeaders,
        resBody: raw.toString('utf8'),
        resSize: raw.length,
        resContentType: outHeaders['content-type'],
        status: rule.status || 200,
        statusText: http.STATUS_CODES[rule.status || 200] || '',
        duration: elapsed(startedAt),
        mocked: true,
        mockRule: rule.name || rule.id,
      }, ctx);
    };

    const delay = Number(rule.delayMs) || 0;
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  _forward(ctx) {
    const { req, res, target, startedAt, reqCapture, meta, sim } = ctx;
    const isSecure = target.protocol === 'https:';
    const transport = isSecure ? https : http;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_HEADERS.includes(k)) continue;
      headers[k] = v;
    }
    headers.host = target.host;

    let upstream;
    try {
      upstream = transport.request({
        method: req.method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: Number(target.port) || (isSecure ? 443 : 80),
        path: (target.pathname || '/') + (target.search || ''),
        headers,
        // 调试工具：上游证书异常（企业代理、自签名）不应阻断排查
        rejectUnauthorized: false,
        servername: isSecure && !net.isIP(target.hostname) ? target.hostname : undefined,
      });
    } catch (err) {
      this._fail(ctx, err);
      req.resume();
      return;
    }

    upstream.setTimeout(120000, () => {
      upstream.destroy(new Error('上游响应超时（120s）'));
    });

    // 请求体流式转发（同时被 BodyCapture 记录），chunked / 大文件都不会被卡住
    req.pipe(upstream);
    req.on('aborted', () => upstream.destroy());

    upstream.on('response', (upRes) => {
      const resHeaders = { ...upRes.headers };
      const resCapture = new BodyCapture(resHeaders['content-type'], resHeaders['content-encoding']);

      try {
        res.writeHead(upRes.statusCode, upRes.statusMessage, resHeaders);
      } catch (_) {
        try {
          res.writeHead(upRes.statusCode, resHeaders);
        } catch (e) {
          upRes.destroy();
          res.destroy();
          return;
        }
      }

      const writeChunk = (chunk) => {
        res.write(chunk);
        this.stats.bytes += chunk.length;
        if (this.config.capture) resCapture.push(chunk);
      };
      const finishResponse = () => {
        res.end();
        if (!this.config.capture) return;
        const digest = resCapture.digest();
        const reqDigest = reqCapture.digest();
        this._record({
          ...meta,
          reqBody: reqDigest.text,
          reqBodyBase64: reqDigest.base64,
          reqBodyTruncated: reqDigest.truncated,
          reqSize: reqDigest.size,
          resHeaders,
          resBody: digest.text,
          resBodyBase64: digest.base64,
          resBodyTruncated: digest.truncated,
          resSize: digest.size,
          resContentType: resHeaders['content-type'],
          status: upRes.statusCode,
          statusText: upRes.statusMessage || '',
          duration: elapsed(startedAt),
          ...(sim ? { simMode: 'weak', simRule: sim.rule.match } : {}),
        }, ctx);
      };
      if (sim) {
        // 弱网：响应体按目标带宽分片放行，不整体缓冲，大响应也不会撑爆内存
        const throttle = throttleTransform(sim.kbps);
        throttle.on('data', writeChunk);
        throttle.on('end', finishResponse);
        upRes.pipe(throttle);
      } else {
        upRes.on('data', writeChunk);
        upRes.on('end', finishResponse);
      }
      upRes.on('error', (err) => {
        res.destroy();
        this._fail(ctx, err);
      });
    });

    upstream.on('error', (err) => this._fail(ctx, err));
  }

  _fail(ctx, err) {
    const { res, startedAt, meta, reqCapture } = ctx;
    this.stats.errors += 1;
    if (err && err.errors && err.errors.length) {
      // Node 的 autoSelectFamily 聚合错误：把真实原因拼出来，方便排查
      err.message = err.errors.map((e) => `${e.code || ''} ${e.message}`.trim()).join(' / ');
    }
    const message = `iReq 上游请求失败: ${err && err.message ? err.message : err}`;
    try {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
      } else {
        res.destroy();
      }
    } catch (_) {
      /* noop */
    }

    if (!this.config.capture) return;
    const reqDigest = reqCapture.digest();
    this._record({
      ...meta,
      reqBody: reqDigest.text,
      reqBodyBase64: reqDigest.base64,
      reqBodyTruncated: reqDigest.truncated,
      resHeaders: {},
      resBody: null,
      resSize: 0,
      status: 0,
      statusText: '',
      duration: elapsed(startedAt),
      error: String(message),
    }, ctx);
  }

  /**
   * 请求刚进代理就先落一条「进行中」占位记录并推 SSE：
   * 列表、侧栏（设备 / 应用 / 域名 / 接口）在请求发起的那一刻就能看到，
   * 而不是等上游响应收完。响应结束时 _record 复用同一个 id 就地补完，不产生第二行。
   */
  _begin(ctx) {
    if (!this.config.capture) return null;
    const flow = {
      id: randomUUID(),
      ts: Date.now(),
      ...ctx.meta,
      reqBody: '',
      reqSize: 0,
      resHeaders: {},
      resBody: null,
      resSize: 0,
      status: 0,
      statusText: '',
      duration: 0,
      pending: true,
    };
    this.stats.total += 1;
    this._prepare(flow);
    const saved = this.store.add(flow, { persist: false });
    this._afterAdd(saved);
    return saved;
  }

  /** 广播前必须补齐的字段：设备 key / 标签、HTTP 版本 */
  _prepare(flow) {
    // 兜底：任何记录路径（含未来新增的分支）都带上稳定的设备 key / 标签，
    // 这样 SSE 推给控制台的实时流量也能按「本机」筛选，不依赖 UA。
    if (!flow.deviceKey || !flow.deviceLabel) {
      flow.deviceKey = deviceKeyOf(flow.clientIp);
      flow.deviceLabel = deviceLabelOf(flow.clientIp, flow.platform);
    }
    // 筛选条按 HTTP1 / HTTP2 分流：本代理与上游固定 ALPN http/1.1，明文请求也是 1.1
    // 解析，所以真实发生 HTTP 交换的记录都是 HTTP/1.1；CONNECT 透传未解密，版本未知不标。
    if (flow.method !== 'CONNECT' && !flow.httpVersion) flow.httpVersion = 'HTTP/1.1';
  }

  /** 入库后：学习应用名来源、异步回填本机进程名 */
  _afterAdd(flow) {
    // CONNECT 阶段没有 UA：把应用名记到 host / IP 上，后续同域名、同设备的连接
    // 也能被「按应用」的模拟规则命中（手机、模拟器尤其依赖这条兜底）。
    const learned = String(flow.app || '');
    if (learned && !/未知|未识别|unknown/i.test(learned)) {
      if (flow.host) this.appHints.byHost.set(String(flow.host).toLowerCase(), learned);
      if (flow.clientIp) this.appHints.byIp.set(String(flow.clientIp).toLowerCase(), learned);
    }

    // lsof 快照是异步的：连接刚建立时的第一个请求可能还没解析到进程。
    // 拿到结果后回填 + 推 SSE，列表和侧栏里的应用名会自动换成真实 App 名。
    if (
      this.config.processMap !== false &&
      this.processMap.supported &&
      !flow.process &&
      flow.clientPort &&
      ProcessMap.isLocalAddress(flow.clientIp)
    ) {
      this.processMap
        .resolve(flow.clientPort, flow.clientIp)
        .then((proc) => {
          if (!proc || !this.store.get(flow.id)) return;
          flow.app = proc.name;
          flow.appSource = 'process';
          flow.process = {
            pid: proc.pid,
            name: proc.name,
            command: proc.command,
            path: proc.path,
          };
          this.store.touch(flow);
        })
        .catch(() => {});
    }
  }

  /**
   * 记录收尾。带 ctx 且占位记录还在库里时，走 store.finish 就地更新（同一个 id）；
   * 否则是 CONNECT / WebSocket / 模拟阻断这类一次性记录，按老逻辑新增。
   */
  _record(fields, ctx) {
    if (ctx && ctx.flow) {
      // 主链路一定已有占位记录。它可能刚被「清空」或被挤出环形队列：
      // 这时只丢弃，绝不退化成新增——否则点完清空，在途请求的收尾会把行带回来。
      if (this.store.index.get(ctx.flow.id) !== ctx.flow) return null;
      return this.store.finish(ctx.flow, fields) || ctx.flow;
    }
    this.stats.total += 1;
    const flow = {
      id: randomUUID(),
      ts: Date.now(),
      ...fields,
    };
    this._prepare(flow);
    const saved = this.store.add(flow);
    this._afterAdd(saved);
    return saved;
  }
}

function elapsed(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1000000n);
}

module.exports = { ProxyServer, decompress, isTextual, passthroughMatches };
