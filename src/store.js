'use strict';

/**
 * 流量存储：内存环形队列 + 当日 JSONL 落盘（可选）。
 * 只保留展示需要的字段，body 超长会截断并打标。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appOf, platformOf, routeOf } = require('./derive');
const {
  LOCAL_KEY,
  normalizeIp,
  isLocalClientIp,
  deviceKeyOf,
  deviceLabelOf,
} = require('./local-address');

/**
 * 落盘封顶：每天一个的 flows-*.jsonl 不会自己消失（实测两周攒到几百 MB），
 * 保留最近几份即可，启动时只读今天那份。
 * 清空产生的 .cleared-* 归档不在这里处理 —— 它们已经是界面上的「历史记录」，
 * 删不删由用户决定，自动删就等于把用户看得到的东西悄悄抹掉。
 */
const DAILY_KEEP = 7;
/** 单日流量能到几百 MB，7 份叠起来就上 GB，份数之外再加一道总量线 */
const DAILY_MAX_BYTES = 200 * 1024 * 1024;

class FlowStore extends EventEmitter {
  constructor({ dir, maxFlows = 2000, persist = true, loadRecent = 300 } = {}) {
    super();
    this.dir = dir || path.join(process.cwd(), 'data');
    this.maxFlows = maxFlows;
    this.persist = persist;
    this.flows = [];
    this.index = new Map();
    this.paused = false;
    if (persist) {
      fs.mkdirSync(this.dir, { recursive: true });
      this._loadRecent(loadRecent);
      this._pruneDisk();
    }
  }

  _todayFile() {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    return path.join(this.dir, `flows-${stamp}.jsonl`);
  }

  _loadRecent(limit) {
    try {
      const file = this._todayFile();
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-limit).reverse();
      const patches = new Map();
      for (const line of recent) {
        try {
          const flow = JSON.parse(line);
          // 进程识别是异步回填的，补丁单独成行；启动时按 id 合并回去
          if (flow.__patch) {
            patches.set(flow.id, flow);
            continue;
          }
          flow._restored = true;
          this.flows.push(flow);
          this.index.set(flow.id, flow);
        } catch (_) {
          /* 忽略损坏行 */
        }
      }
      for (const flow of this.flows) {
        const p = patches.get(flow.id);
        if (!p) continue;
        flow.app = p.app;
        flow.appSource = p.appSource;
        flow.process = p.process;
      }
    } catch (_) {
      /* 读取失败不影响启动 */
    }
  }

  add(flow, { persist = true } = {}) {
    if (this.paused) return flow;
    this.flows.unshift(flow);
    this.index.set(flow.id, flow);
    if (this.flows.length > this.maxFlows) {
      const dropped = this.flows.splice(this.maxFlows);
      for (const f of dropped) this.index.delete(f.id);
    }
    // 「进行中」的占位记录不落盘：请求没走完就写一行 status=0，重启后会变成
    // 一堆永远没有结果的幽灵记录。等 finish 时一次性写入完整行。
    if (persist && this.persist) {
      try {
        fs.appendFileSync(this._todayFile(), JSON.stringify(flow) + '\n');
      } catch (_) {
        /* 落盘失败不影响抓包 */
      }
    }
    this.emit('flow', flow);
    return flow;
  }

  /**
   * 请求完成：把占位记录就地补成最终结果，复用同一个 id。
   * 列表和侧栏在请求「发起」时就已看到这条记录，这里只推一次 update，不新增行。
   * 已被清空 / 挤出环形队列的记录不复活（否则点清空后，在途请求的收尾会把行带回来）。
   */
  finish(flow, patch) {
    if (!flow || this.index.get(flow.id) !== flow) return null;
    // 请求收尾的 fields 里带着「发起时」算出的 app（可能只是 UA 推断）。
    // 若期间 lsof 已异步回填了真实进程名，不能被它覆盖回去。
    const resolved =
      flow.appSource === 'process'
        ? { app: flow.app, appSource: flow.appSource, process: flow.process }
        : null;
    if (patch) Object.assign(flow, patch);
    if (resolved) Object.assign(flow, resolved);
    delete flow.pending;
    if (this.persist) {
      try {
        fs.appendFileSync(this._todayFile(), JSON.stringify(flow) + '\n');
      } catch (_) {
        /* 落盘失败不影响内存更新 */
      }
    }
    this.emit('flow-update', flow);
    return flow;
  }

  get(id) {
    const f = this.index.get(id);
    // 老数据没有派生字段，详情接口也要能拿到「本机」这类展示标签
    return f ? ensureDerived(f) : undefined;
  }

  /**
   * 记录已入库后才补到的字段（目前是本机进程名）。
   * 不重写整条 flow（body 可能几 MB），只追加一条轻量 patch 行并广播更新。
   */
  touch(flow, patch) {
    if (patch) Object.assign(flow, patch);
    if (this.persist) {
      try {
        fs.appendFileSync(
          this._todayFile(),
          JSON.stringify({
            __patch: true,
            id: flow.id,
            app: flow.app,
            appSource: flow.appSource,
            process: flow.process,
          }) + '\n'
        );
      } catch (_) {
        /* 落盘失败不影响内存更新 */
      }
    }
    this.emit('flow-update', flow);
    return flow;
  }

  /**
   * 条件筛选：返回完整 flow 对象。列表接口再映射成 summary，导出直接用完整对象。
   * status 单值匹配语义见模块底的 matchStatus（与前端 matchStatusUi 保持一致）：
   * 协议（http/https/ws/sse/http1/http2）、内容类型（json/xml/text/html/js/image/media/binary）、
   * 状态码（1xx..5xx）、error / ok / json（历史值，保持兼容）。
   */
  filter({ limit = 500, before = '', sort = '', dir = '', ...opts } = {}) {
    const ok = prepareFilter(opts);
    const key = SORT_KEYS[String(sort || '')];
    // 排序模式：内存条数有上限（默认 2000），全量匹配后排完再切前 limit 条。
    // 游标翻页在这里没意义 —— 第 2 页的「第 200 名」要重新排一遍才知道是谁，
    // 所以忽略 before，调用方看到 hasMore=false 就别再要求下一页了。
    if (key) {
      const all = [];
      for (const f0 of this.flows) {
        const f = ensureDerived(f0);
        if (ok(f)) all.push(f);
      }
      return sortFlows(all, key, dir).slice(0, limit);
    }
    const out = [];
    // 游标：从某条 id 之后（更早）继续取。实时列表「往下滑加载更多」用，
    // 翻页时新流量还在往队头插，用下标分页会错位，所以按 id 定位。
    let armed = !before;
    for (const f0 of this.flows) {
      const f = ensureDerived(f0);
      if (!armed) {
        if (f.id === before) armed = true;
        continue;
      }
      if (!ok(f)) continue;
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  list(options = {}) {
    return this.filter(options).map(summary);
  }

  /**
   * 只要「匹配多少条」，不关心内容。
   * MCP 的 list_flows 用它算 total：列表本身被 limit 截断，但调用方
   * 需要知道「是不是还有更多」，否则 AI 会把 50 条当成全部。
   */
  count(options = {}) {
    return this.filter({ ...options, limit: Infinity }).length;
  }

  /** 导出用：带 headers / body 的完整记录，条数上限交给调用方。
   *  进行中的占位记录没有响应，导出时跳过，避免 HAR 里出现 status=0 的空条目。 */
  listFull(options = {}) {
    return this.filter({ limit: 2000, ...options }).filter((f) => !f.pending);
  }

  /**
   * 侧边栏用的聚合：设备 / 应用 / 域名 / 接口结构。
   * scope（可选）：{ hosts: filterOpts, routes: filterOpts } —— 域名 / 接口结构
   * 改在按条件筛出的子集上聚合（应用勾选 → 只显示该应用下的域名 / 接口），
   * 设备与应用始终聚合全量（应用列表「一直显示全部」）。
   */
  facets(limit = 40, scope = null) {
    const bump = (map, key, label) => {
      if (!key) return;
      const cur = map.get(key) || { key, label: label || key, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    };
    const hosts = new Map();
    const apps = new Map();
    const appSources = new Map();
    const devices = new Map();
    const routes = new Map();

    for (const f0 of this.flows) {
      const f = ensureDerived(f0);
      bump(apps, f.app || '未知来源');
      // 应用名来源：'process' 是本机查到的真实进程，'alias' 是用户配的，
      // 'ua' 只是猜的 —— 侧栏据此给出不同标记
      if (f.appSource === 'process' || (f.appSource === 'alias' && !appSources.has(f.app))) {
        appSources.set(f.app, f.appSource);
      }
      // 设备：先按「是不是本机」归一，平台名取该设备下出现最多的一种，
      // 标签不随最新一条流量的 UA 变来变去（以前会闪跳成「未知 127.0.0.1」）。
      const dk = deviceKeyOf(f.clientIp);
      const d = devices.get(dk) || {
        key: dk,
        count: 0,
        ip: normalizeIp(f.clientIp),
        platforms: new Map(),
      };
      d.count += 1;
      const plat = String(f.platform || '').trim();
      if (plat && plat !== '未知') d.platforms.set(plat, (d.platforms.get(plat) || 0) + 1);
      devices.set(dk, d);
    }

    // 域名 / 接口结构：按作用域子集聚合；无作用域时与旧行为一致（全量）
    // 注意 limit 传 Infinity：聚合要吃满子集，不能被默认 500 截断。
    const hostSub = scope && scope.hosts ? this.filter({ limit: Infinity, ...scope.hosts }) : this.flows;
    for (const f0 of hostSub) {
      bump(hosts, ensureDerived(f0).host);
    }
    const routeSub =
      scope && scope.routes ? this.filter({ limit: Infinity, ...scope.routes }) : this.flows;
    for (const f0 of routeSub) {
      const f = ensureDerived(f0);
      bump(routes, f.route || `${f.method} ${f.path}`);
    }

    const toArr = (map, lim = limit) =>
      [...map.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, lim)
        .map(({ key, label, count }) => ({ key, label, count }));

    const deviceArr = [...devices.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((d) => {
        const top = [...d.platforms.entries()].sort((a, b) => b[1] - a[1])[0];
        return { key: d.key, label: deviceLabelOf(d.ip, top && top[0]), count: d.count };
      });

    return {
      hosts: toArr(hosts),
      apps: toArr(apps).map((x) => ({ ...x, source: appSources.get(x.key) || 'ua' })),
      devices: deviceArr,
      // 接口结构前端要按 path 分段建树，聚合上限放宽，避免树被 40 条截断
      routes: toArr(routes, 400),
    };
  }

/**
   * 磁盘封顶：日文件按「份数 + 总量」双封顶，超出的从最旧的删起。
   * 今天的落盘文件永远不动（正被追加写）；.cleared-* 归档是用户可见的历史记录，
   * 不在这里处理，删不删由 FlowHistory 那边按用户的显式操作来。
   */
  _pruneDisk() {
    const out = { removed: 0, freed: 0 };
    if (!this.persist) return out;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (_) {
      return out;
    }
    const todayName = path.basename(this._todayFile());
    const dailies = [];
    for (const name of names) {
      if (name === todayName) continue;
      if (!/^flows-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const abs = path.join(this.dir, name);
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) dailies.push({ abs, name, size: st.size });
      } catch (_) {
        continue;
      }
    }

    const doomed = [];
    // 日文件名即日期，字典序等于时间序；新的在后
    dailies.sort((a, b) => (a.name < b.name ? -1 : 1));
    // 数量封顶
    if (dailies.length > DAILY_KEEP) doomed.push(...dailies.slice(0, dailies.length - DAILY_KEEP));
    // 总量封顶：从最新往前累加，加上就超限的（且不是最新那份）删掉；至少留一份
    let dailyBytes = 0;
    for (let i = dailies.length - 1; i >= 0; i--) {
      const next = dailyBytes + dailies[i].size;
      if (i < dailies.length - 1 && next > DAILY_MAX_BYTES) doomed.push(dailies[i]);
      else dailyBytes = next;
    }

    for (const f of [...new Set(doomed)]) {
      try {
        fs.unlinkSync(f.abs);
        out.removed += 1;
        out.freed += f.size;
      } catch (_) {
        /* 被占用 / 权限不足就跳过 */
      }
    }
    return out;
  }

  clear() {
    const count = this.flows.length;
    this.flows = [];
    this.index.clear();
    let archived = null;
    if (this.persist) {
      // 「清空」必须连落盘一起处理：只清内存的话，重启时 _loadRecent
      // 会把刚删掉的当日记录全部恢复回来，用户会以为清空按钮坏了。
      // 归档成 .cleared-<ts>（不会被 _todayFile 匹配），同时成为界面上的一条
      // 「历史记录」—— 可以改名、回看、删除，删不删由用户决定。
      try {
        const file = this._todayFile();
        if (fs.existsSync(file) && fs.statSync(file).size > 0) {
          // 同一毫秒内连续清空两次会重名，rename 会静默覆盖前一份归档
          const ts = Date.now() + (this._clearSeq = (this._clearSeq || 0) + 1);
          const dest = `${file}.cleared-${ts}`;
          fs.renameSync(file, dest);
          archived = {
            id: String(ts),
            file: path.basename(dest),
            bytes: fs.statSync(dest).size,
            count,
            createdAt: ts,
          };
        }
      } catch (_) {
        /* 归档失败不影响内存清空 */
      }
      this._pruneDisk();
    }
    if (archived) this.emit('archived', archived);
    this.emit('clear');
    return archived;
  }

  /** 今天正在写的落盘文件；内存取完后从这里接着往前翻 */
  todayFile() {
    return this._todayFile();
  }

  stats() {
    return { total: this.flows.length, maxFlows: this.maxFlows };
  }
}

/**
 * 把筛选条件编译成判定函数。
 * 条件解析（小写化、多选拆分）放在循环外，否则每行都要重算一遍；
 * 历史记录从磁盘分页读时复用同一套语义，避免「内存里筛得出来、归档里筛不出来」。
 * beforeTs 是「只看比这个时间更早的」，用于内存已取完后接着读今天的落盘文件。
 */
/* ---------------- 搜索与排序 ---------------- */

/** 列表可点的排序字段。时间本身就是内存队列的默认序，只有这三项需要真排 */
const SORT_KEYS = { time: 'ts', duration: 'duration', size: 'resSize', status: 'status' };

/** 升 / 降序。缺值（进行中还没有耗时）永远沉底，升序降序都不该让它冒到最前面 */
function sortFlows(list, key, dir) {
  const mul = String(dir || '').toLowerCase() === 'asc' ? 1 : -1;
  const val = (f) => {
    const n = Number(key === 'ts' ? f.ts : f[key]);
    return Number.isFinite(n) ? n : null;
  };
  return list.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * mul;
  });
}

/**
 * 正文命中：请求体 / 响应体任一命中即可。
 * re 由 prepareFilter 编译好传进来，这里只 test，不重复构造。
 */
function bodyHit(f, re) {
  return (
    (typeof f.reqBody === 'string' && !!f.reqBody && re.test(f.reqBody)) ||
    (typeof f.resBody === 'string' && !!f.resBody && re.test(f.resBody))
  );
}

/**
 * 条件筛选：返回完整 flow 对象。
 *
 * inBody：把搜索范围扩到请求体 / 响应体。默认关闭 —— 每条 body 最大 2MB，
 * 开着搜等于每帧筛一遍几十 MB 文本，实时列表会掉帧，所以做成显式开关。
 * query 以 `body:` 开头时等价于「只搜正文」，方便 MCP / 命令行直接指定。
 */
function prepareFilter({
  query = '',
  method = '',
  status = '',
  onlyMocked = false,
  host = '',
  ip = '',
  app = '',
  route = '',
  since = 0,
  beforeTs = 0,
  inBody = false,
} = {}) {
  let q = String(query || '').trim();
  // `body:xxx` = 只搜正文（元信息不参与）
  const bodyOnly = /^body:/i.test(q);
  if (bodyOnly) q = q.slice(5).trim();
  q = q.toLowerCase();
  // 大小写不敏感又不想复制字符串：body 能有 2MB，逐条 toLowerCase() 是一次大分配，
  // 改用 /i 正则扫原串（V8 在原文上匹配，不建副本）
  const bodyRe =
    (inBody || bodyOnly) && q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const h = String(host || '').toLowerCase();
  const ipq = String(ip || '').trim();
  const wantIp = ipq && ipq !== LOCAL_KEY ? normalizeIp(ipq) : '';
  const isLocalWanted = ipq === LOCAL_KEY;
  // 应用支持多选：数组或逗号分隔字符串（侧栏勾选多个应用）
  const appArr = Array.isArray(app)
    ? app.map((s) => String(s)).filter(Boolean)
    : String(app || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const appSet = appArr.length ? new Set(appArr) : null;
  const m = method ? method.toUpperCase() : '';
  const sinceMs = Number(since) || 0;
  const beforeMs = Number(beforeTs) || 0;

  return (f) => {
    // 时间窗：MCP 里「只看最近 N 秒」用，前端列表不传就是全量
    if (sinceMs && Number(f.ts || 0) < sinceMs) return false;
    if (beforeMs && Number(f.ts || 0) >= beforeMs) return false;
    if (onlyMocked && !f.mocked) return false;
    if (m && f.method !== m) return false;
    if (!matchStatus(f, status)) return false;
    if (appSet && !appSet.has(f.app)) return false;
    if (h && String(f.host || '').toLowerCase() !== h) return false;
    if (isLocalWanted) {
      if (!isLocalClientIp(f.clientIp)) return false;
    } else if (wantIp && normalizeIp(f.clientIp) !== wantIp) return false;
    if (route && f.route !== route) return false;
    if (q) {
      // body: 前缀只搜正文；否则先看元信息，没命中再看正文（仅当开关打开）
      const metaHit =
        !bodyOnly &&
        `${f.method} ${f.url} ${f.status} ${f.app || ''} ${f.clientIp || ''} ${
          f.deviceLabel || ''
        } ${
          (f.process && `${f.process.name} ${f.process.command} ${f.process.pid}`) || ''
        }`
          .toLowerCase()
          .includes(q);
      if (!metaHit && !(bodyRe && bodyHit(f, bodyRe))) return false;
    }
    return true;
  };
}

/**
 * 筛选条 status 单值匹配。语义必须与前端 matchStatusUi 保持一致：
 * 协议（http/https/ws/sse/http1/http2）、内容类型（json/xml/text/html/js/image/media/binary）、
 * 状态码（1xx..5xx）、error / ok / json（历史值，保持兼容）。
 */
function matchStatus(f, status) {
  if (!status) return true;
  const st = Number(f.status) || 0;
  const ct = String(f.resContentType || '').toLowerCase();
  switch (status) {
    case 'error':
      return st >= 400 || !!f.error;
    case 'ok':
      return st >= 200 && st < 400;
    case 'json':
      return ct.includes('json');
    case 'http':
      return f.scheme === 'http';
    case 'https':
      return f.scheme === 'https';
    case 'ws':
      return !!f.ws;
    case 'sse':
      return ct.includes('text/event-stream');
    case 'http1':
      return String(f.httpVersion || '').toUpperCase().startsWith('HTTP/1');
    case 'http2':
      return String(f.httpVersion || '').toUpperCase().startsWith('HTTP/2');
    case 'xml':
      return ct.includes('xml') && !ct.includes('html');
    case 'html':
      return ct.includes('html');
    case 'js':
      return /javascript|ecmascript/.test(ct);
    case 'text':
      return ct.startsWith('text/') && !/html|javascript|ecmascript|event-stream/.test(ct);
    case 'image':
      return ct.startsWith('image/');
    case 'media':
      return ct.startsWith('audio/') || ct.startsWith('video/');
    case 'binary':
      return (
        !!ct &&
        !ct.startsWith('text/') &&
        !/json|xml|html|javascript|ecmascript|event-stream|image\/|audio\/|video\//.test(ct)
      );
    case '1xx':
      return st >= 100 && st < 200;
    case '2xx':
      return st >= 200 && st < 300;
    case '3xx':
      return st >= 300 && st < 400;
    case '4xx':
      return st >= 400 && st < 500;
    case '5xx':
      return st >= 500 && st < 600;
    default:
      // 具体状态码（404 / 500）：按数值精确匹配。
      // 以前这里无条件返回 true，MCP 传 status:'404' 等于没筛。
      return /^\d{3}$/.test(status) ? st === Number(status) : true;
  }
}

/** 老数据没有 app / platform / route，按需补一次，避免聚合里一堆"未知" */
function ensureDerived(f) {
  const ua = (f.reqHeaders || {})['user-agent'];
  if (!f.app) f.app = appOf(ua);
  if (!f.platform) f.platform = platformOf(ua);
  if (!f.route) f.route = routeOf(f.method, (f.path || '/').split('?')[0]);
  // 设备标签每次重算：网卡 IP 可能变（切 Wi-Fi / 连 VPN），且它不依赖 UA，
  // 保证「本机」不会因为新来一条无 UA 的请求就闪成「未知 127.0.0.1」。
  f.deviceKey = deviceKeyOf(f.clientIp);
  f.deviceLabel = deviceLabelOf(f.clientIp, f.platform);
  return f;
}

function summary(f) {
  return {
    id: f.id,
    ts: f.ts,
    method: f.method,
    url: f.url,
    host: f.host,
    path: f.path,
    scheme: f.scheme,
    httpVersion: f.httpVersion,
    status: f.status,
    statusText: f.statusText,
    pending: !!f.pending,
    duration: f.duration,
    reqSize: f.reqSize,
    resSize: f.resSize,
    resContentType: f.resContentType,
    mocked: f.mocked,
    replayOf: f.replayOf,
    error: f.error,
    ws: f.ws,
    tunneled: f.tunneled,
    simMode: f.simMode,
    simRule: f.simRule,
    clientIp: f.clientIp,
    deviceKey: deviceKeyOf(f.clientIp),
    deviceLabel: deviceLabelOf(f.clientIp, f.platform),
    app: f.app,
    appSource: f.appSource || 'ua',
    process: f.process || null,
    platform: f.platform,
    route: f.route,
  };
}

module.exports = { FlowStore, summary, matchStatus, prepareFilter, ensureDerived };
