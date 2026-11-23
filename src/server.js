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
const { importHar } = require('./har-import');
const { aggregate: aggregatePerf } = require('./perf');
const { build: buildOverview, toMarkdown: overviewToMarkdown } = require('./overview');
const { Annotations, COLORS: ANNOT_COLORS } = require('./annotations');
const { applyColumns, normalizeColumns } = require('./columns');
const { normalizeScripts, TEMPLATES: SCRIPT_TEMPLATES } = require('./scripts');
const {
  normalize: normalizeRedact,
  lists: redactLists,
  describe: describeRedact,
  redactFlow,
  redactFlows,
  redactBodyText,
  PLACEHOLDER: REDACT_PLACEHOLDER,
  DEFAULT_HEADERS: REDACT_HEADERS,
  DEFAULT_FIELDS: REDACT_FIELDS,
  PII_FIELDS: REDACT_PII,
  QUERY_NAMES: REDACT_QUERY,
} = require('./redact');
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

/** 头部类型缺失（或只给了 octet-stream）时按魔数认一下，图片预览才不会因为上游乱写头就废掉 */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('BM')) return 'image/bmp';
  return '';
}

/* 能安全直接用 <img>/<video> 内联展示的类型。刻意不含 svg 与 html：
 * 控制台是本地服务的同源页面，内联一个带脚本的 SVG 等于给抓到的流量开了个 XSS 口子。 */
const INLINE_BODY_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

/** 从 URL 末段猜一个像样的文件名，猜不到就按类型补扩展名 */
function bodyFileName(flow, contentType, isRequest) {
  const extByType = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/html': 'html',
    'application/pdf': 'pdf',
  };
  let base = '';
  try {
    const last = new URL(String(flow.url || '')).pathname.split('/').filter(Boolean).pop() || '';
    base = decodeURIComponent(last);
  } catch (_) {
    /* URL 不合法就用兜底名 */
  }
  base = base.replace(/[\\/:*?"<>|\r\n\t]+/g, '-').slice(0, 60);
  if (!base) base = `${String(flow.method || 'GET').toLowerCase()}-${isRequest ? 'request' : 'response'}`;
  if (!/\.[a-z0-9]{1,5}$/i.test(base)) {
    const ext = extByType[contentType];
    if (ext) base = `${base}.${ext}`;
  }
  return base;
}

/* 导出文件名用记录名（下载下来一看就知道是哪次抓的）；中文走 RFC 5987，老客户端用 ASCII 兜底 */function exportDisposition(item, format) {
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
          // 标注跟着导出走：别人打开 HAR 也能看到「这条是关键请求」
          ...(f.note ? { note: f.note } : {}),
          ...(f.color ? { color: f.color } : {}),
          ...(f.pinned ? { pinned: true } : {}),
        },
      };
    });
  return {
    log: { version: '1.2', creator: { name: 'iReq', version: version || '' }, pages: [], entries },
  };
}

class ConsoleServer {
  constructor({ port = 9091, host = '127.0.0.1', store, rules, bookmarks, proxy, ca, config, systemProxy, caTrust, appIcons, updater, dataDir, publicDir, breakpoints, hostmap }) {
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
    this.breakpoints = breakpoints || (proxy && proxy.breakpoints) || null;
    this.hostmap = hostmap || (proxy && proxy.hostmap) || null;
    this.dataDir = dataDir || null;
    this.publicDir = publicDir || path.join(__dirname, '..', 'public');
    this.clients = new Set();
    this.server = null;
    /* MCP 授权：令牌只存哈希，界面里生成与撤销；默认关闭，开了也必须有令牌 */
    this.mcpAuth = new McpAuth({ config: this.config, dataDir: this.dataDir });
    /* 请求标注：按 flow id 存，落盘一个 json —— flow 被清空 / 挤掉后标注还在 */
    this.annotations = new Annotations({ file: this.dataDir ? path.join(this.dataDir, 'annotations.json') : '' });
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
        source: m.source || (m.auto ? 'auto' : 'startup'),
        auto: !!m.auto,
        reason: m.reason || '',
        skippedAt: m.at || 0,
        addedAt: m.addedAt || m.at || 0,
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
      // 自动跳过的那条不清：列表里那一行就是「这个域名看不到明文」的唯一标记，
      // 用户还要靠它点「重新尝试解密」。手动加白名单则照旧清掉诊断。
      for (const rule of next) {
        const m = meta[rule] || {};
        if (m.auto) continue;
        this.proxy.clearTlsFailures(rule);
      }
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

  /**
   * 后台重新数归档条数（一次只跑一条，避免几个大文件同时解析把主线程占满）。
   * 数完广播 history-changed，界面自己刷新那一行的「N 条」。
   */
  _queueHistoryRecount(id) {
    if (!this.history || !id) return;
    if (!this._recountQueue) this._recountQueue = [];
    if (this._recountQueue.includes(id)) return;
    this._recountQueue.push(id);
    if (this._recountTimer) return;
    const tick = () => {
      this._recountTimer = null;
      const next = this._recountQueue.shift();
      if (next == null) return;
      try {
        const n = this.history.recount(next);
        if (n != null) this._broadcast({ type: 'history-changed' });
      } catch (_) {
        /* 文件被删了就跳过 */
      }
      if (this._recountQueue.length) this._recountTimer = setTimeout(tick, 80);
    };
    this._recountTimer = setTimeout(tick, 150);
  }

  /** 已经接管就按最新配置重放一遍（绕过名单 / 抓包范围改了要立刻生效） */
  _reapplyProxyIfOurs() {
    if (!this.config.localProxyOurs || !this.systemProxy) return;
    const st = this._localProxyStatus(0);
    const scope = this._captureScope();
    this.systemProxy.enable(st.service, {
      bypass: this._proxyBypass(),
      pac: scope.mode === 'list' ? this._pacUrl() : '',
    });
    this._lpCache = { at: Date.now(), st: this.systemProxy.status() };
  }

  _pacFile(res) {
    const body = this._pacScript();
    res.writeHead(200, {
      'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /** 控制台端口上的 PAC 地址（PAC 由本机进程拉取，绑回环即可） */
  _pacUrl() {
    return `http://127.0.0.1:${this.port}/proxy.pac`;
  }

  /** 抓包范围：mode 'all' | 'list'，list 模式下只有这些域名走 iReq */
  _captureScope() {
    const scope = this.config.captureScope || {};
    const mode = scope.mode === 'list' ? 'list' : 'all';
    const domains = (Array.isArray(scope.domains) ? scope.domains : [])
      .map((d) => String(d || '').trim().toLowerCase())
      .map((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''))
      .filter((d) => d && /^[\w.*\-]+$/.test(d))
      .slice(0, 200);
    return { mode: mode === 'list' && !domains.length ? 'all' : mode, domains };
  }

  /** 生成 PAC：命中列表 → PROXY，其余 → DIRECT */
  _pacScript() {
    const { domains } = this._captureScope();
    const proxy = `PROXY 127.0.0.1:${this.proxy ? this.proxy.port : 9090}; DIRECT`;
    const tests = domains.map((d) => {
      if (d.startsWith('*.')) {
        const base = d.slice(1); // ".example.com"
        return `dnsDomainIs(host, ${JSON.stringify(base)})`;
      }
      return `(host === ${JSON.stringify(d)} || dnsDomainIs(host, ${JSON.stringify('.' + d)}))`;
    });
    return [
      '// iReq 生成：只让列表里的域名走抓包，其余直连',
      'function FindProxyForURL(url, host) {',
      '  host = (host || "").toLowerCase();',
      '  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "DIRECT";',
      tests.length ? `  if (${tests.join(' ||\n      ')}) return ${JSON.stringify(proxy)};` : '',
      '  return "DIRECT";',
      '}',
      '',
    ].filter(Boolean).join('\n');
  }

  /** 用户配置的「不走代理」名单（VPN 网关、内网面板…），归一化后去重 */
  _proxyBypass() {
    const raw = Array.isArray(this.config.proxyBypass) ? this.config.proxyBypass : [];
    const out = [];
    for (const item of raw) {
      let v = String(item || '').trim().toLowerCase();
      // 贴 URL 就取主机部分；但 CIDR（10.0.0.0/8）里的斜杠要留着 —— 早先无脑 replace(/\/.*$/)
      // 会把掩码吃掉，结果系统里只剩 10.0.0.0
      if (/^https?:\/\//.test(v)) v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!v || v.length > 253) continue;
      if (!/^[\w.*:\-\[\]/]+$/.test(v)) continue; // 只接受域名 / IP / CIDR
      if (!out.includes(v)) out.push(v);
      if (out.length >= 60) break;
    }
    return out;
  }

  /** 系统代理状态的短缓存：多个窗口轮询时只跑一次 networksetup */
  _localProxyStatus(ttlMs = 1500) {
    const now = Date.now();
    if (this._lpCache && now - this._lpCache.at < ttlMs) return this._lpCache.st;
    const st = this.systemProxy.status();
    this._lpCache = { at: now, st };
    return st;
  }

  /** 老版本留下的偏小计数（等于内存上限的那些）启动后补数一遍 */
  _healHistoryCounts() {
    if (!this.history) return;
    const cap = (this.store && this.store.maxFlows) || 2000;
    for (const item of this.history.items) {
      if (Number(item.count) >= cap) this._queueHistoryRecount(item.id);
    }
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
        if (this.systemProxy) this.systemProxy.pacUrl = this._pacUrl();
        this._bindEvents();
        this._healHistoryCounts();
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
      // 清空那一刻记的是「内存里剩几条」，内存有上限（默认 2000），
      // 文件里往往更多 —— 后台重新数一遍，别让列表看起来像只存了 2000 条
      this._queueHistoryRecount(item.id);
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
      // 连续握手失败自动跳过解密：落盘 + 通知界面（那一行会改成「已跳过解密」）
      this.proxy.on('passthrough-auto', (info) => {
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'passthrough-auto', ...info, passthrough: this.config.passthrough || [] });
      });
      // 条件告警：规则命中时广播，所有打开的窗口都会弹提示
      this.proxy.on('alert', (alert) => this._broadcast({ type: 'alert', alert }));
      // 反代端口启停 / 失败时同步给界面（比如端口被占用）
      this.proxy.on('reverse', (reverse) => this._broadcast({ type: 'reverse-changed', reverse }));
    }
    // 断点挂起 / 放行：所有窗口同步弹窗与角标（开两个标签页时两边都能操作同一条）
    if (this.breakpoints) {
      this.breakpoints.events.on('hold', (record) => {
        const { body, ...rest } = record;
        this._broadcast({ type: 'break-hold', record: { ...rest, bodyPreview: String(body || '').slice(0, 2000) } });
      });
      this.breakpoints.events.on('release', ({ id, phase }) =>
        this._broadcast({ type: 'break-release', id, phase })
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
    /* 「只抓指定域名」用的 PAC：命中的域名走代理端口，其余 DIRECT（真直连，不过我们） */
    if (pathname === '/proxy.pac') return this._pacFile(res);
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
        proxyBypass: this.config.proxyBypass || [],
        captureScope: this._captureScope(),
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
        // 断点只在状态里给「开了没 / 几条规则 / 几条在等」，body 走单独接口
        breakpoints: this.breakpoints
          ? {
              enabled: this.breakpoints.enabled,
              timeoutMs: this.breakpoints.timeoutMs,
              rules: this.breakpoints.rules.map((r) => ({ ...r })),
              pending: this.breakpoints.pending.size,
            }
          : null,
        version: VERSION,
        update: this.updater ? this.updater.status() : null,
      });
    }

    /* ---------------- MCP 接入：开关 / 令牌 / 审计（本机控制台专用） ---------------- */
    if (parts[1] === 'mcp') return this._apiMcp(req, res, parts, method, url);

    /* ---------------- 反向代理：抓打向本机服务的请求（webhook / 回调） ---------------- */
    if (parts[1] === 'reverse') {
      if (!this.proxy) return this._json(res, 400, { error: '代理未启动' });
      if (method === 'GET') return this._json(res, 200, this.proxy.reverseStatus());
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        const status = await this.proxy.setReverseProxy({
          enabled: body.enabled === true,
          port: body.port,
          target: body.target,
        });
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'reverse-changed', reverse: status });
        return this._json(res, status.error ? 400 : 200, status);
      }
    }

    /* ---------------- 标注：数量与颜色（界面用来画徽标） ---------------- */
    if (parts[1] === 'annotations' && method === 'GET') {
      return this._json(res, 200, { ...this.annotations.stats(), colors: ANNOT_COLORS });
    }

    /* ---------------- 脱敏：导出 / MCP / 带 redact=1 的接口才动手，界面永远原值 ---------------- */
    if (parts[1] === 'redact') {
      if (method === 'GET' && parts[2] === 'preview') {
        return this._json(res, 200, this._redactPreview(url.searchParams));
      }
      if (method === 'GET') return this._json(res, 200, this._redactView());
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        this.config.redact = normalizeRedact({
          enabled: body.enabled !== false,
          headers: body.headers !== false,
          query: body.query !== false,
          body: body.body !== false,
          pii: body.pii === true,
          extraHeaders: body.extraHeaders,
          extraHeaderText: body.extraHeaderText,
          extraFields: body.extraFields,
          extraFieldText: body.extraFieldText,
        });
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'redact-changed', redact: this.config.redact });
        return this._json(res, 200, this._redactView());
      }
    }

    /* ---------------- 脚本规则：JS 钩子改请求 / 响应 ---------------- */
    if (parts[1] === 'scripts') {
      const engine = this.proxy && this.proxy.scripts;
      if (!engine) return this._json(res, 404, { error: '脚本模块未启用' });
      // 模板是纯数据：界面「从模板开始」直接用，不用在前端再抄一份
      if (method === 'GET' && parts[2] === 'templates') {
        return this._json(res, 200, { templates: SCRIPT_TEMPLATES });
      }
      if (method === 'GET' && parts.length === 2) {
        return this._json(res, 200, engine.settings());
      }
      if (method === 'POST' && parts[2] === 'check') {
        const body = (await this._body(req)) || {};
        const out = engine.compile(String(body.code || ''), Number(body.timeoutMs) || undefined);
        return this._json(res, 200, {
          ok: out.ok,
          error: out.error || '',
          logs: (out.logs || []).slice(0, 20),
          hooks: out.hooks || null,
        });
      }
      if (method === 'PUT' && parts.length === 2) {
        const body = (await this._body(req)) || {};
        const next = normalizeScripts({
          enabled: body.enabled !== undefined ? body.enabled : engine.settings().enabled,
          rules: Array.isArray(body.rules) ? body.rules : engine.settings().rules,
        });
        // 保存前先编译：语法错、死循环的规则不该悄悄存下去
        const errors = [];
        for (const rule of next.rules) {
          const c = engine.compile(rule.code, rule.timeoutMs);
          if (!c.ok) errors.push({ id: rule.id, name: rule.name, error: c.error });
        }
        if (errors.length) {
          return this._json(res, 400, { error: '脚本有错，未保存', errors });
        }
        engine.set(next);
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'scripts-changed', scripts: next });
        return this._json(res, 200, next);
      }
    }

    /* ---------------- 条件告警：命中规则就提醒，可静音 ---------------- */
    if (parts[1] === 'alerts') {
      const engine = this.proxy && this.proxy.alerts;
      if (!engine) return this._json(res, 404, { error: '告警模块未启用' });
      if (method === 'GET') return this._json(res, 200, engine.status());
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        const saved = engine.set({
          enabled: body.enabled !== undefined ? body.enabled : engine.settings().enabled,
          rules: Array.isArray(body.rules) ? body.rules : engine.settings().rules,
        });
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'alerts-changed', alerts: saved });
        return this._json(res, 200, engine.status());
      }
      if (method === 'POST' && parts[2] === 'mute') {
        const body = (await this._body(req)) || {};
        const until = engine.mute(body.minutes);
        this._broadcast({ type: 'alerts-changed', alerts: engine.settings() });
        return this._json(res, 200, { ...engine.status(), mutedUntil: until });
      }
    }

    /* ---------------- 派生列：把响应 JSON 字段提成列表里的一列 ---------------- */
    if (parts[1] === 'columns') {
      if (method === 'GET') {
        return this._json(res, 200, { columns: this.config.derivedColumns || [] });
      }
      if (method === 'PUT') {
        const body = (await this._body(req)) || {};
        const columns = normalizeColumns(body.columns);
        this.config.derivedColumns = columns;
        // 立刻重算已有流量：改列配置不该只对新抓的请求生效
        for (const f of this.store.flows) {
          const d = applyColumns(f, columns);
          if (d) f.derived = d;
          else delete f.derived;
        }
        if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
        this._broadcast({ type: 'columns-changed', columns });
        return this._json(res, 200, { ok: true, columns });
      }
    }

    /* ---------------- 性能视图：按接口 / 域名聚合耗时与错误率 ---------------- */
    if (parts[1] === 'perf' && method === 'GET') {
      const sp = url.searchParams;
      const by = sp.get('by') === 'host' ? 'host' : 'route';
      const flows = this.store.list({
        query: sp.get('q') || '',
        method: sp.get('method') || '',
        status: sp.get('status') || '',
        onlyMocked: sp.get('mocked') === '1',
        host: sp.get('host') || '',
        ip: sp.get('ip') || '',
        app: sp.get('app') || '',
        route: sp.get('route') || '',
        limit: Math.min(Number(sp.get('limit')) || 2000, 5000),
      });
      return this._json(res, 200, {
        ...aggregatePerf(flows, {
          by,
          limit: Math.min(Number(sp.get('groups')) || 200, 500),
          slowest: Math.min(Number(sp.get('slowest')) || 8, 50),
        }),
        // 内存里的总条数（含进行中）：让界面能提示「统计的是筛出来的这 N 条里的多少」
        inMemory: this.store.flows.length,
      });
    }

    /* ---------------- 会话总览：一页结论 + 可贴进工单的 Markdown ---------------- */
    if (parts[1] === 'overview' && method === 'GET') {
      const sp = url.searchParams;
      const flows = this.store.list({
        query: sp.get('q') || '',
        method: sp.get('method') || '',
        status: sp.get('status') || '',
        onlyMocked: sp.get('mocked') === '1',
        host: sp.get('host') || '',
        ip: sp.get('ip') || '',
        app: sp.get('app') || '',
        route: sp.get('route') || '',
        limit: Math.min(Number(sp.get('limit')) || 2000, 5000),
      });
      const ov = buildOverview(this.annotations.applyAll(flows), {
        version: VERSION,
        redact: this.config.redact,
        columns: this.config.derivedColumns,
      });
      if (parts[2] !== 'report.md') return this._json(res, 200, { ...ov, inMemory: this.store.flows.length });

      // 报告里的筛选条件是给人看的句子，不是 url 参数
      const filters = [];
      if (sp.get('host')) filters.push(`域名 ${sp.get('host')}`);
      if (sp.get('route')) filters.push(`接口 ${sp.get('route')}`);
      if (sp.get('app')) filters.push(`应用 ${sp.get('app')}`);
      if (sp.get('q')) filters.push(`关键词 ${sp.get('q')}`);
      if (sp.get('status')) filters.push(`状态 ${sp.get('status')}`);
      if (sp.get('mocked') === '1') filters.push('仅 Mock');
      const md = overviewToMarkdown(ov, { title: 'iReq 抓包报告', filters });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const data = Buffer.from(md, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="ireq-report-${stamp}.md"`,
        'content-length': data.length,
        'x-ireq-redacted': String(ov.redactions || 0),
        'cache-control': 'no-store',
      });
      return res.end(data);
    }

    /* ---------------- 历史记录：每次「清空」一条，可改名 / 回看 / 删除 ---------------- */
    if (parts[1] === 'history') return this._apiHistory(req, res, parts, method, url);

    /* ---------------- 断点：命中规则时挂起请求 / 响应，等人放行 ---------------- */
    if (parts[1] === 'breakpoints') return this._apiBreak(req, res, parts, method);

    /* ---------------- 域名映射：把某个域名的请求实际发到另一台机器 ---------------- */
    if (parts[1] === 'hostmap') return this._apiHostMap(req, res, method);

    /* ---------------- 导入 HAR：别人的抓包文件变成这里的一份历史记录 ---------------- */
    if (parts[1] === 'har' && method === 'POST') return this._apiHarImport(req, res, url);
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
      const red = redactFlows(
        this.annotations.applyAll(flows),
        this.config.redact,
        this.config.derivedColumns
      );
      const payload = format === 'json' ? red.flows.slice().reverse() : toHar(red.flows, VERSION);
      // HAR 里有 comment 字段：打开的人一眼能看出这份是脱敏过的，不至于拿它去复现 bug
      if (format === 'har' && red.count) {
        payload.log.comment = `iReq: 已脱敏 ${red.count} 处（凭据类头部 / 查询参数 / 正文字段），原值仍保留在本机控制台`;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const data = Buffer.from(JSON.stringify(payload, null, format === 'har' ? 2 : 0));
      res.writeHead(200, {
        'content-type': format === 'har' ? 'application/har+json; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="ireq-${stamp}.${format === 'json' ? 'json' : 'har'}"`,
        'content-length': data.length,
        'x-flow-count': String(flows.length),
        'x-ireq-redacted': String(red.count),
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
        const list = this.store.list({
          query: url.searchParams.get('q') || '',
          method: url.searchParams.get('method') || '',
          status: url.searchParams.get('status') || '',
          onlyMocked: url.searchParams.get('mocked') === '1',
          host: url.searchParams.get('host') || '',
          ip: url.searchParams.get('ip') || '',
          app: url.searchParams.get('app') || '',
          route: url.searchParams.get('route') || '',
          limit: Math.min(Number(url.searchParams.get('limit')) || 500, 2000),
        });
        const annotated = this.annotations.applyAll(list);
        if (url.searchParams.get('redact') !== '1') return this._json(res, 200, annotated);
        return this._json(res, 200, redactFlows(annotated, this.config.redact, this.config.derivedColumns).flows);
      }
      /* 标注：合并语义，只改传进来的字段；三个字段都空等于删掉标注 */
      if (parts.length === 4 && parts[3] === 'annotation' && (method === 'PUT' || method === 'DELETE')) {
        const id = parts[2];
        if (!this.store.get(id) && !this.annotations.get(id)) {
          return this._json(res, 404, { error: 'flow 不存在' });
        }
        if (method === 'DELETE') {
          this.annotations.remove(id);
          this._broadcast({ type: 'annotation', id, annotation: null });
          return this._json(res, 200, { ok: true, id, annotation: null });
        }
        const body = (await this._body(req)) || {};
        const saved = this.annotations.set(id, {
          note: body.note,
          color: body.color === undefined ? undefined : String(body.color || ''),
          pinned: body.pinned === undefined ? undefined : body.pinned === true,
        });
        this._broadcast({ type: 'annotation', id, annotation: saved });
        return this._json(res, 200, { ok: true, id, annotation: saved });
      }
      if (method === 'GET' && parts.length === 3) {
        const flow = this.annotations.apply(this.store.get(parts[2]));
        if (!flow) return this._json(res, 404, { error: 'flow 不存在' });
        if (url.searchParams.get('redact') !== '1') return this._json(res, 200, flow);
        const safe = { ...redactFlow(flow, this.config.redact, this.config.derivedColumns) };
        delete safe._redactions;
        return this._json(res, 200, safe);
      }
      /* WebSocket 帧 / SSE 消息：列表不带正文，这里按需取。
       * WS 帧在会话结束前只存在内存里，所以优先问代理要实时数据。 */
      if (method === 'GET' && parts.length === 4 && parts[3] === 'messages') {
        const flow = this.store.get(parts[2]);
        if (!flow) return this._json(res, 404, { error: 'flow 不存在' });
        const live = this.proxy && typeof this.proxy.wsFramesOf === 'function'
          ? this.proxy.wsFramesOf(parts[2])
          : null;
        const ws = flow.ws
          ? {
              live: !!live,
              frames: live ? live.frames : flow.wsFrames || [],
              count: live ? live.count : flow.wsFrameCount || (flow.wsFrames || []).length,
              dropped: live ? live.dropped : flow.wsFramesDropped || 0,
              bytes: live ? live.bytes : flow.wsBytes || 0,
              compressed: live ? live.compressed : flow.wsCompressed || 0,
              protocol: flow.wsProtocol || '',
              extensions: flow.wsExtensions || '',
              closedAt: flow.wsClosedAt || null,
            }
          : null;
        const sseMessages = flow.sseMessages || [];
        const sse = flow.sseCount || sseMessages.length
          ? {
              live: !!flow.pending,
              messages: sseMessages,
              count: flow.sseCount || sseMessages.length,
              comments: flow.sseComments || 0,
              dropped: flow.sseDropped || 0,
            }
          : null;
        return this._json(res, 200, {
          id: flow.id,
          ws,
          sse,
          contentType: flow.resContentType || '',
          pending: !!flow.pending,
        });
      }
      // 原始字节：图片直接当 <img src> 用，其它类型给「保存为文件」
      if (method === 'GET' && parts.length === 4 && parts[3] === 'body') {
        const flow = this.store.get(parts[2]);
        if (!flow) return this._json(res, 404, { error: 'flow 不存在' });
        return this._sendFlowBody(res, flow, url.searchParams);
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
        // 重放出来的记录也要按当前配置补派生列，否则列表里那一格是空的
        if (result && result.flow) {
          const derived = applyColumns(result.flow, this.config.derivedColumns);
          if (derived) {
            result.flow.derived = derived;
            this.store.emit('flow-update', result.flow);
          }
        }
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
      let dropped = '';
      if (method === 'DELETE') {
        const key = normalizePassthroughRule(url.searchParams.get('rule') || '');
        dropped = key;
        rules = key
          ? (this.config.passthrough || []).filter((r) => normalizePassthroughRule(r) !== key)
          : [];
      } else if (method === 'POST') {
        rules = [...(this.config.passthrough || []), ...asArray(body.rules)];
      } else {
        rules = asArray(body.rules);
      }
      const changed = this._setPassthrough(rules, String(body.source || 'manager'));
      // 删掉某条规则 = 让这个域名重新试解密：诊断行（含「已跳过」标记）一起撤掉，计数从头开始
      if (dropped && this.proxy && typeof this.proxy.clearTlsFailures === 'function') {
        this.proxy.clearTlsFailures(dropped);
      }
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
        // 界面会周期性轻量轮询（?fast=1）：状态缓存 1.5s，别让每个窗口都跑一遍 networksetup；
        // 证书信任在 fast 模式下用缓存，不做强制检查
        const fast = url.searchParams.get('fast') === '1';
        const st = this._localProxyStatus();
        const prev = Boolean(this.config.localProxyOurs);
        this.config.localProxyOurs = Boolean(st.ours);
        // 别的地方改了系统代理（Clash / VPN / 终端命令）：让所有窗口都刷新顶栏那个状态
        if (prev !== Boolean(st.ours)) {
          this._broadcast({ type: 'local-proxy', ours: Boolean(st.ours) });
        }
        return this._json(res, 200, {
          ...st,
          captureScope: this._captureScope(),
          caTrust: fast ? this.caTrust && this.caTrust.status(false) : this._syncTrust(),
          safeMode: this._safeMode(),
          commands: this.systemProxy.commands(st.service, this._proxyBypass()),
        });
      }
      if (method === 'POST') {
        const body = (await this._body(req)) || {};
        const scope = this._captureScope();
        const r = body.enabled
          ? this.systemProxy.enable(body.service, {
              bypass: this._proxyBypass(),
              // 只抓指定域名时用 PAC：未命中的域名根本不会连到我们
              pac: scope.mode === 'list' ? this._pacUrl() : '',
            })
          : this.systemProxy.disable(body.service);
        // 接管时重新问一次系统：用户可能刚执行完信任命令。
        const caTrust = this._syncTrust(true);
        const st = r.status || this.systemProxy.status();
        this._lpCache = { at: Date.now(), st };
        this.config.localProxyOurs = Boolean(st.ours);
        this._broadcast({ type: 'local-proxy', ours: Boolean(st.ours) });
        const service = st.service || body.service || this.systemProxy.primaryService();
        return this._json(res, r.ok ? 200 : 400, {
          ...r,
          // 把状态字段平铺出来：界面和自检都要直接读 ours / mode
          ...st,
          captureScope: this._captureScope(),
          caTrust,
          safeMode: this._safeMode(),
          commands: this.systemProxy.commands(service, this._proxyBypass()),
        });
      }
    }

    /* 在文件管理器里打开数据目录 / 证书目录：重装、备份、手动清理前先看得见 */
    if (parts[1] === 'reveal-dir' && method === 'POST') {
      const body = (await this._body(req)) || {};
      const which = body.which === 'ca' ? 'ca' : 'data';
      const dir = which === 'ca' ? (this.ca ? this.ca.dir : '') : this.dataDir;
      if (!dir) return this._json(res, 400, { error: '目录未启用' });
      const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try {
        require('child_process').spawn(open, [dir], { detached: true, stdio: 'ignore' }).unref();
        return this._json(res, 200, { ok: true, dir });
      } catch (err) {
        return this._json(res, 500, { error: String((err && err.message) || err) });
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
        // 抓包范围：全部 / 只抓列表里的域名（改完若正在接管，立即重新应用）
        if (body.captureScope && typeof body.captureScope === 'object') {
          const mode = body.captureScope.mode === 'list' ? 'list' : 'all';
          const domains = (Array.isArray(body.captureScope.domains) ? body.captureScope.domains : String(body.captureScope.domains || '').split('\n'))
            .map((d) => String(d || '').trim())
            .filter(Boolean)
            .slice(0, 200);
          this.config.captureScope = { mode, domains };
          this._reapplyProxyIfOurs();
        }
        // 系统代理绕过名单（VPN 网关、内网面板…）：改了立即生效 —— 正在接管就重新应用一次
        if (body.proxyBypass !== undefined) {
          const list = (Array.isArray(body.proxyBypass) ? body.proxyBypass : String(body.proxyBypass || '').split('\n'))
            .map((x) => String(x || '').trim())
            .filter(Boolean)
            .slice(0, 60);
          this.config.proxyBypass = list;
          this._reapplyProxyIfOurs();
        }
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
      // 搜索范围扩到正文（请求体 / 响应体）。默认关，前端搜索框上有个开关
      inBody: sp.get('body') === '1',
    };
  }

  /** 分页列表也要带标注：界面拉的是这个接口，漏了就等于标注只在导出的文件里有效 */
  _flowsPage(sp) {
    const page = this._flowsPageRaw(sp);
    if (page && Array.isArray(page.flows)) page.flows = this.annotations.applyAll(page.flows);
    return page;
  }

  _flowsPageRaw(sp) {
    const limit = Math.min(Math.max(Number(sp.get('limit')) || 200, 1), 500);
    const cursor = sp.get('cursor') || '';
    const filters = this._pageFilters(sp);
    const memoryTotal = this.store.flows.length;
    // 排序：只有内存阶段能做（磁盘是倒序分块读，跨块排序得整份读进内存）。
    // 排序结果一次给全，所以 hasMore 恒为 false，前端也不会再要下一页。
    // 白名单校验：拼错的 sort 不能被当成「排过序了」而返回半截结果
    const SORTS = ['time', 'duration', 'size', 'status'];
    const sort = SORTS.includes(sp.get('sort')) ? sp.get('sort') : '';
    const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';

    if (sort) {
      const flows = this.store.list({ ...filters, sort, dir, limit });
      return { flows, nextCursor: '', hasMore: false, total: memoryTotal, sorted: true };
    }

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
  /* ---------------- 断点：命中规则就挂起，等人放行 ----------------
   *   GET  /api/breakpoints              → { enabled, rules, pending: [...] }
   *   PUT  /api/breakpoints              → { enabled, rules } 保存（关掉会立刻放行所有挂起项）
   *   GET  /api/breakpoints/:id          → 单条待处理项（含 body 全文）
   *   POST /api/breakpoints/:id          → 放行：{ type:'resume', method?,url?,headers?,body? }
   *                                       或 { type:'abort', status, statusText?, body?, headers? }
   *   POST /api/breakpoints/release-all  → 全部放行（原样继续）
   */
  async _apiBreak(req, res, parts, method) {
    const bp = this.breakpoints;
    if (!bp) return this._json(res, 400, { error: '断点模块未启用' });

    if (parts.length === 2) {
      if (method === 'GET') return this._json(res, 200, bp.state());
      if (method === 'PUT' || method === 'POST') {
        const body = (await this._body(req)) || {};
        if (body.timeoutMs != null) bp.setTimeoutMs(body.timeoutMs);
        const out = bp.setRules(body.rules, body.enabled);
        this._broadcast({
          type: 'breakpoints',
          state: {
            enabled: out.enabled,
            rules: out.rules,
            pending: out.pending.length,
            timeoutMs: out.timeoutMs,
          },
        });
        return this._json(res, 200, out);
      }
      return this._json(res, 405, { error: '方法不允许' });
    }

    if (parts[2] === 'release-all' && method === 'POST') {
      const n = bp.releaseAll('manual');
      return this._json(res, 200, { released: n });
    }

    const id = parts[2];
    if (method === 'GET') {
      const rec = bp.get(id);
      if (!rec) return this._json(res, 404, { error: '这条断点已经放行了' });
      return this._json(res, 200, rec);
    }
    if (method === 'POST') {
      const body = (await this._body(req)) || {};
      const ok = bp.resolve(id, body);
      if (!ok) return this._json(res, 404, { error: '这条断点已经放行了' });
      return this._json(res, 200, { ok: true });
    }
    return this._json(res, 405, { error: '方法不允许' });
  }

  /**
   * 域名映射：GET 拿配置，PUT 整体替换（开关 + 规则）。
   * 规则格式 { from, to }：from 是域名（可含 `*`，可带路径前缀），to 是 `host:port` 或完整 URL。
   * 保存后立刻落盘，并广播给所有窗口 —— 映射是全局面板，不该只对当前标签页生效。
   */
  async _apiHostMap(req, res, method) {
    const hm = this.hostmap;
    if (!hm) return this._json(res, 400, { error: '域名映射未启用' });

    if (method === 'GET') return this._json(res, 200, hm.state());
    if (method === 'PUT' || method === 'POST') {
      const body = (await this._body(req)) || {};
      const out = hm.setState({ enabled: body.enabled, rules: body.rules });
      // 顺手记进 config，重启后还在：这是配置，不是一次性的会话状态
      this.config.hostMap = out;
      if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
      this._broadcast({ type: 'hostmap', state: out });
      return this._json(res, 200, out);
    }
    return this._json(res, 405, { error: '方法不允许' });
  }

  /**
   * 导入 HAR：请求体是文件原文（不是 JSON 包装），`?name=` 可指定记录名。
   * 解析后落成一条历史记录，侧栏点开就能回看 / 重放 / 对比。
   */
  async _apiHarImport(req, res, url) {
    if (!this.history) return this._json(res, 400, { error: '未启用落盘，无法导入' });
    let text;
    try {
      text = await this._rawText(req);
    } catch (err) {
      return this._json(res, 413, { error: `文件太大，最多 64MB（${err.message}）` });
    }
    if (!text || !text.trim()) return this._json(res, 400, { error: '空文件' });

    const out = importHar({
      text,
      dir: path.join(this.dataDir, 'flows'),
      name: url.searchParams.get('name') || '',
      history: this.history,
    });
    if (!out.ok) return this._json(res, 400, { error: out.error });

    this._broadcast({ type: 'history-changed' });
    return this._json(res, 200, out);
  }

  async _apiHistory(req, res, parts, method, url) {    const h = this.history;
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
      const red = redactFlows(
        this.annotations.applyAll(flows),
        this.config.redact,
        this.config.derivedColumns
      );
      const payload =
        format === 'json' ? red.flows.slice().reverse() : toHar(red.flows, VERSION);
      if (format === 'har' && red.count) {
        payload.log.comment = `iReq: 已脱敏 ${red.count} 处（凭据类头部 / 查询参数 / 正文字段），原值仍保留在本机控制台`;
      }
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
        'x-ireq-redacted': String(red.count),
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
      // 归档里的原始字节：导入的 HAR 里常有图片，回看时也要能看 / 能存
      if (parts[5] === 'body') return this._sendFlowBody(res, out.flow, url.searchParams);
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
   *   PATCH  /api/mcp/tokens/:id      → { name } 重命名
   *   DELETE /api/mcp/tokens/:id      → 撤销
   *   DELETE /api/mcp/audit           → 清空审计
   */
  async _apiMcp(req, res, parts, method, url) {
    const auth = this.mcpAuth;
    const endpoint = `http://127.0.0.1:${this.port}/mcp`;

    if (parts[2] === 'tokens' && method === 'PATCH' && parts[3]) {
      const body = (await this._body(req)) || {};
      const entry = auth.renameToken(parts[3], body.name);
      if (!entry) return this._json(res, 404, { error: '令牌不存在' });
      return this._json(res, 200, { ok: true, token: entry, ...this._mcpView(endpoint) });
    }

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
    // 把真实路径一起给界面：重装 / 备份前总得知道数据在哪
    return { bytes, files, dir: this.dataDir };
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

  _body(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
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

  /** 原始文本（不按 JSON 解析）：导入 HAR 时直接吃文件内容，省一次转义膨胀 */
  _rawText(req, limit = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('文件太大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /**
   * 正文原始字节：`?side=req|res`（默认响应），`?dl=1` 强制下载。
   * 图片 / 音视频内联（可直接当 <img src> 用），其余一律 attachment ——
   * 抓到的内容是不可信数据，不能让它以 html / svg 的身份在控制台同源里跑起来。
   */
  /** 脱敏配置视图：生效名单一起给出来，界面不用自己拼默认值 */
  /** MCP 工具改完配置后统一落盘（没有 dataDir 就只在内存里生效） */
  _persistConfig() {
    if (this.dataDir) savePersistedConfig(this.dataDir, this.config);
  }

  _redactView() {
    const cfg = normalizeRedact(this.config.redact);
    const sets = redactLists(cfg);
    return {
      ...cfg,
      parts: describeRedact(cfg),
      placeholder: REDACT_PLACEHOLDER,
      effective: {
        headers: [...sets.headers],
        fields: [...sets.fields],
        query: [...sets.query],
      },
      defaults: {
        headers: REDACT_HEADERS,
        fields: REDACT_FIELDS,
        query: REDACT_QUERY,
        pii: REDACT_PII,
      },
    };
  }

  /** 拿一条真实流量做「打码前 / 打码后」对照：不敢给人看效果的开关，用户不会信 */
  _redactPreview(sp) {
    const id = sp.get('id');
    let cfg = normalizeRedact(this.config.redact);
    // draft=1：面板上还没保存的草稿，按参数临时算一份给用户看效果
    if (sp.get('draft') === '1') {
      cfg = normalizeRedact({
        enabled: sp.get('enabled') !== '0',
        headers: sp.get('headers') === '1',
        query: sp.get('query') === '1',
        body: sp.get('body') === '1',
        pii: sp.get('pii') === '1',
        extraHeaders: sp.get('extraHeaders') || '',
        extraFields: sp.get('extraFields') || '',
      });
    }
    let flow = id ? this.store.get(id) : null;
    if (!flow) flow = (this.store.list({ limit: 1 }) || [])[0] || null;
    if (!flow) {
      return { id: null, count: 0, parts: [], placeholder: REDACT_PLACEHOLDER, before: null, after: null };
    }
    const trimmed = (v) => {
      if (v == null) return '';
      const s = String(v);
      return s.length > 1500 ? `${s.slice(0, 1500)}…（预览已截断）` : s;
    };
    const pick = (f) => ({
      method: f.method,
      url: f.url,
      request: { headers: f.reqHeaders || {}, body: trimmed(f.reqBody) },
      response: { headers: f.resHeaders || {}, body: trimmed(f.resBody) },
    });
    const safe = redactFlow(flow, cfg, this.config.derivedColumns);
    return {
      id: flow.id,
      count: safe._redactions || 0,
      parts: describeRedact(cfg),
      placeholder: REDACT_PLACEHOLDER,
      before: pick(flow),
      after: pick(safe),
    };
  }

  _sendFlowBody(res, flow, sp) {
    const isReq = sp.get('side') === 'req';
    const b64 = isReq ? flow.reqBodyBase64 : flow.resBodyBase64;
    const text = isReq ? flow.reqBody : flow.resBody;
    if (!b64 && (text == null || text === '')) {
      return this._json(res, 404, { error: '这条流量没有正文' });
    }
    let buf = b64 ? Buffer.from(String(b64), 'base64') : Buffer.from(String(text), 'utf8');
    const heads = (isReq ? flow.reqHeaders : flow.resHeaders) || {};
    const rawType = heads['content-type'];
    const type = String(Array.isArray(rawType) ? rawType[0] : rawType || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    // 上游经常把图片写成 application/octet-stream 甚至不写，按魔数补一下才认得出是图
    const sniffed = sniffImageType(buf);
    const contentType = (!type || type === 'application/octet-stream') && sniffed ? sniffed : type || 'application/octet-stream';
    // 存成文件再发给别人是常见的泄漏路径，所以这里也认 redact=1；二进制没法安全打码就不动
    if (!b64 && sp.get('redact') === '1') {
      const cfg = normalizeRedact(this.config.redact);
      if (cfg.enabled) {
        const counter = { n: 0, parts: new Set() };
        const safe = redactBodyText(String(text), contentType, redactLists(cfg).fields, counter);
        if (counter.n) buf = Buffer.from(safe, 'utf8');
      }
    }
    const name = bodyFileName(flow, contentType, isReq);
    const inline = !sp.get('dl') && INLINE_BODY_TYPES.has(contentType);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': buf.length,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-body-truncated': (isReq ? flow.reqBodyTruncated : flow.resBodyTruncated) ? '1' : '0',
    });
    return res.end(buf);
  }

  _json(res, code, payload) {    const data = Buffer.from(JSON.stringify(payload));
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
