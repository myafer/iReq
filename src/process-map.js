'use strict';

/**
 * 本机进程识别：把「客户端 TCP 源端口」映射到发起连接的进程 / App。
 *
 * 为什么需要它：appOf(UA) 只能猜，遇到 okhttp/4.9、CFNetwork 这种通用 UA
 * 就只剩「OkHttp 4」。而代理跑在本机时，连接的另一端就是本机的一个进程，
 * macOS 的 lsof 能直接告诉我们它是谁（DingTalk、Google Chrome、汽水音乐…）。
 * Reqable 桌面端显示的应用名就是这么来的。
 *
 * 限制：只对「本机发起的连接」有效。手机等远程设备经 Wi-Fi 代理进来时，
 * 我们只看得到设备 IP，拿不到对端进程 —— 那种情况仍走 UA 推断 / 别名映射。
 *
 * 一次 `lsof -nP -iTCP -F pcn` 约 40~60ms，输出形如：
 *   p6839
 *   cDingTalk
 *   f47
 *   n192.168.1.23:56839->93.184.216.34:443
 * 左侧端口即本机源端口；右侧 9090 的那条属于代理自己，不会出现在本机源端口里。
 * 因此按「本地端口」查表即可，不需要知道对端是谁。
 */

const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { isLocalClientIp } = require('./local-address');

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;
const PORT_TTL = 5 * 60 * 1000;
const MAX_PORTS = 10000;
const MAX_ATTEMPTS = 3;
const PENDING_TTL = 1500; // 端口最多重试 1.5 秒，之后判定为"短连接没赶上"
const MIN_REFRESH_GAP = 100; // 合并同一波连接，避免每个新连接都单独跑一次 lsof

/** 从可执行路径里取 .app 名：/Applications/DingTalk.app/Contents/MacOS/DingTalk → DingTalk */
function appNameFromPath(p) {
  const i = String(p || '').indexOf('.app/Contents/');
  if (i < 0) return null;
  const before = String(p).slice(0, i + 4);
  return path.basename(before).replace(/\.app$/, '') || null;
}

/** 清洗 lsof 的 command：Chrome Helper / WebKit.WebContent 之类归到主应用 */
function cleanCommand(command) {
  let s = String(command || '').trim();
  if (!s) return '未知进程';
  s = s.replace(/\s*\((?:Renderer|GPU|Plugin|Network|Storage)\)\s*$/i, '');
  s = s.replace(/\s+Helper(?:\s*\(.*\))?\s*$/i, '');
  s = s.replace(/^com\.apple\.WebKit\.WebContent$/i, 'Safari');
  s = s.replace(/^com\.apple\./i, '');
  return s || '未知进程';
}

/** lsof -F pcn 的极简状态机解析；返回 Map<localPort, {pid, command, port}> */
function parseLsof(out) {
  const map = new Map();
  let pid = 0;
  let command = '';
  for (const line of String(out || '').split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      pid = Number(val) || 0;
      command = '';
    } else if (tag === 'c') {
      command = val;
    } else if (tag === 'n' && val.includes('->')) {
      const local = val.split('->')[0];
      const at = local.lastIndexOf(':');
      if (at < 0) continue;
      const port = Number(local.slice(at + 1));
      // 代理自身、内核监听 socket 不参与
      if (!port || !pid || pid === process.pid) continue;
      // 同一端口可能同时属于多个进程（罕见）：优先保留已有的可识别项
      if (!map.has(port)) map.set(port, { pid, command, port });
    }
  }
  return map;
}

class ProcessMap {
  constructor({ enabled = true } = {}) {
    this.platform = process.platform;
    this.enabled = enabled && this.platform === 'darwin';
    this.byPort = new Map();
    this.pidNames = new Map(); // pid -> .app 名（null 表示查过但没有 .app）
    this.pending = new Map(); // port -> { attempts, since }
    this._timer = null;
    this._refreshing = null;
    this._lastRefreshAt = 0;
    this.stats = { refreshes: 0, resolved: 0, missed: 0, errors: 0 };
  }

  get supported() {
    return this.enabled;
  }

  /**
   * 只接受本机地址；远程设备即使端口碰巧相同也不能冒认进程。
   * 「本机」= 回环 + 这台机器的所有网卡 IP（访问局域网 IP 时源地址就是网卡 IP）。
   */
  static isLocalAddress(ip) {
    return isLocalClientIp(ip);
  }

  /** 连接刚建立时调用：登记端口并异步刷新一次快照 */
  observe(port, ip) {
    if (!this.enabled || !port || !ProcessMap.isLocalAddress(ip)) return false;
    const n = Number(port);
    const hit = this.byPort.get(n);
    if (hit && Date.now() - hit.at < 2000) return true;
    const cur = this.pending.get(n);
    if (cur && cur.attempts >= MAX_ATTEMPTS) return false;
    this.pending.set(n, {
      attempts: (cur && cur.attempts) || 0,
      since: (cur && cur.since) || Date.now(),
    });
    this._schedule();
    return true;
  }

  _schedule(delay = 0) {
    if (this._timer || !this.enabled) return;
    // 节流：一波并发连接只跑一次 lsof，别让每个 socket 都触发一次全表扫描
    const gap = MIN_REFRESH_GAP - (Date.now() - this._lastRefreshAt);
    const wait = Math.max(delay, gap, 0);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refresh().catch(() => {});
    }, wait);
    // 不因为一个定时器就阻止进程退出
    if (this._timer.unref) this._timer.unref();
  }

  /** 同步查缓存。命中返回 {pid, name, command, path} */
  lookup(port) {
    if (!this.enabled || !port) return null;
    const hit = this.byPort.get(Number(port));
    if (!hit) return null;
    return {
      pid: hit.pid,
      name: this.pidNames.get(hit.pid) || hit.name || cleanCommand(hit.command),
      command: hit.command,
      path: hit.path || null,
    };
  }

  /** 请求进来时若还没解析好，等一次刷新再回填 */
  async resolve(port, ip) {
    if (!this.enabled || !port || !ProcessMap.isLocalAddress(ip)) return null;
    const hit = this.lookup(port);
    if (hit) return hit;
    try {
      await this.refresh();
    } catch (_) {
      return null;
    }
    return this.lookup(port);
  }

  /** 抓一次全量连接快照；并发调用会合并成一次 */
  refresh() {
    if (!this.enabled) return Promise.resolve(this.byPort);
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _doRefresh() {
    this._lastRefreshAt = Date.now();
    let out;
    try {
      const r = await execFileAsync('lsof', ['-nP', '-iTCP', '-F', 'pcn'], {
        maxBuffer: MAX_BUFFER,
        timeout: 3000,
        env: { ...process.env, LC_ALL: 'C' },
      });
      out = r.stdout;
    } catch (err) {
      this.stats.errors += 1;
      return this.byPort;
    }
    this.stats.refreshes += 1;

    const now = Date.now();
    const fresh = parseLsof(out);
    const newPids = new Set();
    for (const [port, info] of fresh) {
      const prev = this.byPort.get(port);
      // 端口会被复用：pid 变了就当新条目
      if (prev && prev.pid === info.pid && now - prev.at < PORT_TTL) {
        info.at = prev.at;
        info.name = prev.name;
        info.path = prev.path;
      } else {
        info.at = now;
        info.name = cleanCommand(info.command);
        if (!this.pidNames.has(info.pid)) newPids.add(info.pid);
      }
      this.byPort.set(port, info);
    }

    // 清掉过期项，避免长跑后内存无限涨
    if (this.byPort.size > MAX_PORTS / 2) {
      for (const [p, v] of this.byPort) if (now - v.at > PORT_TTL) this.byPort.delete(p);
    }
    while (this.byPort.size > MAX_PORTS) {
      const oldest = this.byPort.keys().next().value;
      this.byPort.delete(oldest);
    }

    // 只对第一次见到的 PID 补查 .app 路径（按 PID 缓存，一次几十毫秒）
    await Promise.all(
      [...newPids].slice(0, 8).map((pid) => this._enrich(pid))
    );

    // 只对「本轮真正关心的端口」结算成功/失败。
    // 以前每轮都给所有未命中端口 missed+1，还让 attempts 永远不增长 ——
    // 结果是一个查不到的端口会每 250ms 触发一次全量 lsof，服务长期空转。
    for (const [port, state] of [...this.pending]) {
      if (this.byPort.has(port)) {
        this.pending.delete(port);
        this.stats.resolved += 1;
        continue;
      }
      state.attempts += 1;
      if (state.attempts >= MAX_ATTEMPTS || Date.now() - state.since > PENDING_TTL) {
        this.pending.delete(port);
        this.stats.missed += 1;
      }
    }
    if (this.pending.size) this._schedule(250);
    return this.byPort;
  }

  async _enrich(pid) {
    let name = null;
    let exePath = null;
    try {
      const r = await execFileAsync('lsof', ['-nP', '-p', String(pid), '-Fn'], {
        maxBuffer: MAX_BUFFER,
        timeout: 3000,
      });
      for (const line of String(r.stdout).split('\n')) {
        if (line[0] !== 'n' || !line.includes('.app/Contents/')) continue;
        const p = line.slice(1);
        const candidate = appNameFromPath(p);
        if (candidate) {
          name = candidate;
          exePath = p;
          break;
        }
      }
    } catch (_) {
      /* 进程可能已退出，或者没权限列它的文件 */
    }
    this.pidNames.set(pid, name);
    if (name) {
      for (const info of this.byPort.values()) {
        if (info.pid === pid) {
          info.name = name;
          info.path = exePath;
        }
      }
    }
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.pending.clear();
  }
}

module.exports = { ProcessMap, parseLsof, cleanCommand, appNameFromPath };
