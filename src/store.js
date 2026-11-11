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

  add(flow) {
    if (this.paused) return flow;
    this.flows.unshift(flow);
    this.index.set(flow.id, flow);
    if (this.flows.length > this.maxFlows) {
      const dropped = this.flows.splice(this.maxFlows);
      for (const f of dropped) this.index.delete(f.id);
    }
    if (this.persist) {
      try {
        fs.appendFileSync(this._todayFile(), JSON.stringify(flow) + '\n');
      } catch (_) {
        /* 落盘失败不影响抓包 */
      }
    }
    this.emit('flow', flow);
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

  /** 条件筛选：返回完整 flow 对象。列表接口再映射成 summary，导出直接用完整对象。 */
  filter({
    query = '',
    method = '',
    status = '',
    onlyMocked = false,
    host = '',
    ip = '',
    app = '',
    route = '',
    limit = 500,
  } = {}) {
    const q = String(query || '').toLowerCase();
    const h = String(host || '').toLowerCase();
    const ipq = String(ip || '').trim();
    const out = [];
    for (const f0 of this.flows) {
      const f = ensureDerived(f0);
      if (onlyMocked && !f.mocked) continue;
      if (method && f.method !== method.toUpperCase()) continue;
      if (status === 'error' && !(f.status >= 400 || f.error)) continue;
      if (status === 'ok' && !(f.status >= 200 && f.status < 400)) continue;
      if (status === 'json' && !String(f.resContentType || '').includes('json')) continue;
      if (h && String(f.host || '').toLowerCase() !== h) continue;
      if (ipq) {
        // 'local' 是侧栏「本机」那一组：回环 + 本机所有网卡 IP 都要命中。
        // 老书签里存的是具体 IP，仍按精确匹配（顺手统一 ::ffff: / ::1 写法）。
        if (ipq === LOCAL_KEY) {
          if (!isLocalClientIp(f.clientIp)) continue;
        } else if (normalizeIp(f.clientIp) !== normalizeIp(ipq)) continue;
      }
      if (app && f.app !== app) continue;
      if (route && f.route !== route) continue;
      if (q) {
        const hay = `${f.method} ${f.url} ${f.status} ${f.app || ''} ${f.clientIp || ''} ${
          f.deviceLabel || ''
        } ${(f.process && `${f.process.name} ${f.process.command} ${f.process.pid}`) || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  list(options = {}) {
    return this.filter(options).map(summary);
  }

  /** 导出用：带 headers / body 的完整记录，条数上限交给调用方 */
  listFull(options = {}) {
    return this.filter({ limit: 2000, ...options });
  }

  /** 侧边栏用的聚合：设备 / 应用 / 域名 / 接口结构 */
  facets(limit = 40) {
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
      bump(hosts, f.host);
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

  clear() {
    this.flows = [];
    this.index.clear();
    if (this.persist) {
      // 「清空」必须连落盘一起处理：只清内存的话，重启时 _loadRecent
      // 会把刚删掉的当日记录全部恢复回来，用户会以为清空按钮坏了。
      // 这里不直接删文件，而是归档成 .cleared-<ts>（不会被 _todayFile 匹配），
      // 既不会复活，又保留了事后翻查原始抓包的可能。
      try {
        const file = this._todayFile();
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.cleared-${Date.now()}`);
      } catch (_) {
        /* 归档失败不影响内存清空 */
      }
    }
    this.emit('clear');
  }

  stats() {
    return { total: this.flows.length, maxFlows: this.maxFlows };
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
    status: f.status,
    statusText: f.statusText,
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

module.exports = { FlowStore, summary };
