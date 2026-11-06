'use strict';

/* iReq 控制台 —— 无框架，原生 DOM */

const S = {
  flows: [],
  selectedId: null,
  selected: null,
  detailTab: 'overview',
  filter: { q: '', status: '', mocked: false, host: '', ip: '', app: '', route: '' },
  rules: [],
  status: {},
  editingRule: null,
  bodyView: {},
  facets: { hosts: [], apps: [], devices: [], routes: [] },
  bookmarks: [],
  closedGroups: new Set(JSON.parse(localStorage.getItem('reqlite-side-closed') || '[]')),
  /* 接口结构树：与默认展开态相反的目录 key（顶层默认展开，深层默认收起） */
  routeToggled: new Set(JSON.parse(localStorage.getItem('reqlite-route-toggled') || '[]')),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ICONS = () =>
  window.ReqLiteIcons || { iconHtml: () => '', deviceHtml: () => '', mount: () => {}, hydrate: () => {} };
let detailEmptyHtml = '';

/* ---------------------------------------------------------------- 字号缩放 */

const SCALE_KEY = 'reqlite-scale';
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.6;
const SCALE_STEP = 0.05;

function currentScale() {
  const v = Number(document.documentElement.style.getPropertyValue('--ui-scale'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function applyScale(value, persist = true) {
  const raw = Math.round(Number(value) * 100) / 100;
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(raw) ? raw : 1));
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  const label = Math.round(scale * 100) + '%';
  const val = $('#fontVal');
  if (val) val.textContent = label;
  const down = $('#fontDown');
  const up = $('#fontUp');
  if (down) down.disabled = scale <= SCALE_MIN + 1e-9;
  if (up) up.disabled = scale >= SCALE_MAX - 1e-9;
  if (persist) localStorage.setItem(SCALE_KEY, String(scale));
  if (window.ReqLiteJSON) window.ReqLiteJSON.setScale(scale);
  return scale;
}

const esc = (v) =>
  String(v === undefined || v === null ? '' : v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error || detail;
    } catch (_) {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 220);
  }, 1900);
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtTime(ms) {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusClass(code) {
  if (!code) return 's0';
  return 's' + String(code)[0];
}

function pretty(body, contentType) {
  if (body === null || body === undefined) return '';
  const t = String(body);
  if (/json/i.test(contentType || '') || /^\s*[[{]/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch (_) {
      return t;
    }
  }
  return t;
}

/* ------------------------------------------------- 代理地址（分段复制） */

/*
 * 顶栏地址是「给手机 / 其它设备配 Wi-Fi 代理」用的，所以默认必须是局域网 IP，
 * 不能是 127.0.0.1（那个地址在手机上指向手机自己）。
 * 页面上所有出现代理地址的地方（顶栏 / 空状态 / 证书弹窗 / 设置）都走这一个来源，
 * 以前各写各的，导致顶栏改了、提示里还是 127。
 */
const ADDR_KEY = 'reqlite-addr-ip';

function addrKind(ip) {
  if (/^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return '局域网';
  if (/^169\.254\./.test(ip)) return '本地链路';
  if (ip === '127.0.0.1') return '本机回环';
  return '其它网卡';
}

function addrCandidates() {
  const st = S.status || {};
  const info = st.lanInfo && st.lanInfo.length
    ? st.lanInfo
    : (st.lan || []).map((ip) => ({ ip, iface: '' }));
  const list = info
    .filter((x) => x && x.ip && !/^127\./.test(x.ip))
    .map((x) => ({ ip: x.ip, label: addrKind(x.ip), iface: x.iface || '' }));
  list.push({ ip: '127.0.0.1', label: '本机回环', iface: 'lo0' });
  return list;
}

function currentAddr() {
  const list = addrCandidates();
  let saved = null;
  try {
    saved = localStorage.getItem(ADDR_KEY);
  } catch (_) {
    /* 隐私模式下 localStorage 不可用，退回内存选择 */
  }
  if (!saved) saved = (S.status && S.status._addrPicked) || null;
  const picked = list.find((x) => x.ip === saved);
  // 没手动选过：优先常见局域网私有网段，其次任意非回环，最后才退回本机回环
  const auto =
    list.find((x) => x.label === '局域网') ||
    list.find((x) => x.ip !== '127.0.0.1') ||
    list[0];
  const chosen = picked || auto || { ip: '127.0.0.1', label: '本机回环', iface: 'lo0' };
  return { ...chosen, port: (S.status && S.status.proxyPort) || 9090 };
}

function addrFull(a) {
  return `${a.ip}:${a.port}`;
}

function renderAddrOptions() {
  const box = $('#addrOptions');
  if (!box) return;
  const cur = currentAddr();
  box.innerHTML = addrCandidates()
    .map(
      (x) => `<button type="button" class="addr-opt ${x.ip === cur.ip ? 'on' : ''}" data-addr="${esc(x.ip)}">
        <span class="ao-tick">${x.ip === cur.ip ? '✓' : ''}</span>
        <span class="ao-ip">${esc(x.ip)}</span>
        <span class="ao-label">${esc(x.label)}${x.iface ? ' · ' + esc(x.iface) : ''}</span>
      </button>`
    )
    .join('');
}

function applyAddr() {
  const a = currentAddr();
  const full = addrFull(a);
  const ipEl = $('#addrIp');
  const portEl = $('#addrPort');
  if (!ipEl || !portEl) return;
  ipEl.textContent = a.ip;
  portEl.textContent = String(a.port);
  ipEl.title = `复制 IP ${a.ip}（Wi-Fi 代理的「服务器」）`;
  portEl.title = `复制端口 ${a.port}（Wi-Fi 代理的「端口」）`;
  $('#addrCopyAll').title = `复制完整地址 ${full}`;
  $('#addrPick').title = `切换地址，当前：${a.label} ${a.ip}（多网卡 / 本机回环）`;
  $('#addrBox').title = `${a.label} · ${full}｜点 IP / 端口分别复制，⧉ 复制完整地址，▾ 切换地址`;

  // 其它位置跟随同一个地址；元素可能被 renderList / openModal 重建，所以每次都查
  const sync = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  sync('#emptyProxy', full);
  sync('#caMobileProxy', full);
  sync('#caUrl', `http://${full}/`);
  sync('#stAddrFull', full);
  sync('#stAddrKind', `${a.label}${a.iface ? ' · ' + a.iface : ''}`);
  sync(
    '#stAddrTip',
    a.ip === '127.0.0.1'
      ? '当前是本机回环：只适合抓这台 Mac 自己的流量。手机请点顶栏 ▾ 切回局域网 IP。'
      : `手机 Wi-Fi 代理：服务器 ${a.ip}、端口 ${a.port}；证书安装页 http://${full}/`
  );
  renderAddrOptions();
}

async function copyAddr(which) {
  const a = currentAddr();
  const text = which === 'ip' ? a.ip : which === 'port' ? String(a.port) : addrFull(a);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    // 非安全上下文或剪贴板权限被拒时降级
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      /* noop */
    }
    ta.remove();
  }
  toast(ok ? `已复制 ${which === 'all' ? '完整地址' : which === 'ip' ? 'IP' : '端口'}：${text}` : '复制失败，请手动选中地址');
  return ok;
}

function toggleAddrMenu(force) {
  const m = $('#addrMenu');
  const btn = $('#addrPick');
  if (!m || !btn) return;
  const show = force === undefined ? m.hidden : force;
  m.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
  if (show) renderAddrOptions();
}

/* ------------------------------------------------------------- 状态/列表 */

async function loadStatus() {
  try {
    const st = await api('/api/status');
    S.status = st;
    $('#dot').className = 'dot on';
    $('#connText').textContent = '监听中';
    $('#capture').checked = st.capture;
    $('#ruleCount').textContent = st.rules;
    applyAddr();
    renderUpdate(st.update);
    return st;
  } catch (err) {
    $('#dot').className = 'dot off';
    $('#connText').textContent = '未连接';
    return null;
  }
}

/** 顶栏「有新版」徽标 + 设置面板「更新」卡片 */
function renderUpdate(u) {
  S.update = u || S.update || null;
  const badge = $('#updBadge');
  if (badge) {
    if (S.update && S.update.hasUpdate && S.update.latest) {
      badge.hidden = false;
      badge.href = S.update.latest.url;
      $('#updBadgeVer').textContent = 'v' + S.update.latest.version;
    } else {
      badge.hidden = true;
    }
  }
  const stateBadge = $('#updStateBadge');
  if (stateBadge) {
    if (!S.update || S.update.enabled === false) stateBadge.textContent = '已关闭';
    else if (S.update.checking) stateBadge.textContent = '检查中…';
    else if (S.update.hasUpdate) stateBadge.textContent = `有新版 v${S.update.latest.version}`;
    else stateBadge.textContent = '已是最新';
  }
  const text = $('#updStatusText');
  if (text) {
    if (S.update && S.update.error) text.textContent = `上次检查失败：${S.update.error}（工具会自动走自家代理重试）`;
    else if (S.update && S.update.hasUpdate)
      text.textContent = `当前 v${S.update.current}，最新 v${S.update.latest.version}，点「前往下载」获取。`;
    else if (S.update && S.update.checkedAt)
      text.textContent = `当前 v${S.update.current}，已是最新。上次检查 ${new Date(S.update.checkedAt).toLocaleString()}。`;
    else text.textContent = '启动时和每 6 小时自动检查一次 GitHub Releases；关闭后仍可手动「检查更新」。';
  }
  const go = $('#updGoRelease');
  if (go) {
    go.hidden = !(S.update && S.update.hasUpdate && S.update.latest);
    if (S.update && S.update.latest) go.href = S.update.latest.url;
  }
}

async function loadFlows() {
  const params = new URLSearchParams({ limit: '800' });
  if (S.filter.q) params.set('q', S.filter.q);
  if (S.filter.status) params.set('status', S.filter.status);
  if (S.filter.mocked) params.set('mocked', '1');
  for (const key of ['host', 'ip', 'app', 'route']) {
    if (S.filter[key]) params.set(key, S.filter[key]);
  }
  const list = await api('/api/flows?' + params.toString());
  S.flows = list;
  renderList();
  if (S.selectedId && !list.some((f) => f.id === S.selectedId)) {
    // 过滤后不在这批里，保留详情但不高亮
    $$('.row').forEach((r) => r.classList.remove('sel'));
  }
}

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderList();
  });
}

function renderList() {
  const list = $('#list');
  const rows = S.flows.map((f) => rowHtml(f)).join('');
  list.innerHTML = rows;
  $('#count').textContent = `${S.flows.length} 条`;
  const empty = $('#listEmpty');
  empty.hidden = S.flows.length > 0;
  if (!S.flows.length) {
    const filtering =
      activeFilterKeys().length > 0 || !!S.filter.status || !!S.filter.mocked || !!S.filter.q;
    const title = empty.querySelector('.empty-title');
    const hint = empty.querySelector('.empty-hint');
    if (title) title.textContent = filtering ? '没有匹配的请求' : '还没有流量';
    if (hint) {
      const a = currentAddr();
      hint.innerHTML = filtering
        ? '换个条件，或点上方已选筛选的 × 取消。'
        : `<b>抓本机</b>：右上「设置 › 本机抓包」一键接管系统代理（顶栏也有快捷入口）；<br>` +
          `<b>抓手机 / 其它设备</b>：Wi-Fi 代理指向 <code id="emptyProxy">${esc(addrFull(a))}</code>（IP / 端口可在顶栏分别复制），然后刷新页面。`;
    }
  }
  const sel = list.querySelector(`.row[data-id="${S.selectedId}"]`);
  if (sel) sel.classList.add('sel');
}

function rowHtml(f) {
  const p = f.path || f.url || '';
  const badges = [
    f.mocked ? '<span class="tag mock">MOCK</span>' : '',
    f.replayOf ? '<span class="tag replay">REPLAY</span>' : '',
    f.ws ? '<span class="tag">WS</span>' : '',
    f.tunneled ? '<span class="tag tunnel">透传</span>' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const stText = f.error ? 'ERR' : f.status || '—';
  const appName = f.app && f.app !== f.host ? f.app : '';
  const hostPart = esc(f.host);
  const appPart = appName ? ` · ${ICONS().iconHtml(appName, 'xs')}${esc(appName)}` : '';
  const sub = `<span class="hl">${hostPart}${appPart}</span>`;
  return `<div class="row" data-id="${f.id}">
    <span class="m ${esc(f.method)}">${esc(f.method)}</span>
    <span class="cellurl">
      <div class="p">${esc(p)}</div>
      <div class="h">${sub}${badges}</div>
    </span>
    <span class="st ${statusClass(f.status)}">${esc(stText)}</span>
    <span class="tm ${f.duration > 800 ? 'slow' : ''}">${f.duration === undefined ? '' : fmtTime(f.duration)}</span>
  </div>`;
}

/* ---------------------------------------------------------------- 分组边栏 */

const FACET_SECTIONS = [
  { key: 'devices', title: '设备', filterKey: 'ip' },
  { key: 'apps', title: '应用', filterKey: 'app' },
  { key: 'hosts', title: '域名', filterKey: 'host' },
  { key: 'routes', title: '接口结构', filterKey: 'route' },
];

const FILTER_LABELS = { ip: '设备', app: '应用', host: '域名', route: '接口', q: '搜索' };
const LOCAL_DEVICE_KEY = 'local';

/** 设备这一组里，'local' 是后端把回环 + 本机网卡 IP 合并后的内部 key，展示成「本机」 */
function facetDisplay(key, value) {
  return key === 'ip' && value === LOCAL_DEVICE_KEY ? '本机' : String(value);
}

/** 前端兜底判断本机 IP：SSE 推来的老格式流量可能没有 deviceKey */
function isLocalClientIpUi(ip) {
  const s = String(ip || '')
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '')
    .replace(/%[a-z0-9._-]+$/, '');
  if (!s) return false;
  if (s === '::1' || s === '0:0:0:0:0:0:0:1' || s === '127.0.0.1' || s.startsWith('127.')) return true;
  const lans = (S.status.lan || []).concat((S.status.lanInfo || []).map((x) => x.ip));
  return lans.some((x) => String(x).toLowerCase() === s);
}

async function loadFacets() {
  try {
    S.facets = await api('/api/facets');
  } catch (_) {
    /* 忽略，保留上一次结果 */
  }
  renderSide();
}

async function loadBookmarks() {
  try {
    S.bookmarks = await api('/api/bookmarks');
  } catch (_) {
    S.bookmarks = [];
  }
  renderSide();
}

let facetTimer;
function scheduleFacets() {
  clearTimeout(facetTimer);
  facetTimer = setTimeout(loadFacets, 1200);
}

function activeFilterKeys() {
  return ['ip', 'app', 'host', 'route', 'q'].filter((k) => S.filter[k]);
}

function renderSide() {
  const body = $('#sideBody');
  if (!body) return;

  const groups = [bookmarkGroupHtml(), ...FACET_SECTIONS.map(facetGroupHtml)];
  body.innerHTML = groups.join('');
}

function facetGroupHtml(section) {
  if (section.key === 'routes') return routeGroupHtml(section);
  const items = S.facets[section.key] || [];
  const closed = S.closedGroups.has(section.key);
  const rows = items.length
    ? items
        .map((it) => {
          const src = section.key === 'apps' ? it.source : '';
          const localDevice = section.key === 'devices' && it.key === LOCAL_DEVICE_KEY;
          const icon =
            section.key === 'apps'
              ? ICONS().iconHtml(it.key, 'sm')
              : section.key === 'devices'
                ? ICONS().deviceHtml(it.label, it.key)
                : '';
          const wrap = icon ? `<span class="app-icon-wrap">${icon}</span>` : '';
          const tip = localDevice
            ? ' · 回环地址与本机所有网卡 IP 都算本机'
            : src === 'process'
              ? ' · 来自本机真实进程'
              : src === 'alias'
              ? ' · 来自 UA 别名'
              : src === 'ua'
              ? ' · 由 User-Agent 推断'
              : '';
          return `<button class="sitem ${S.filter[section.filterKey] === it.key ? 'on' : ''}"
          data-facet="${section.filterKey}" data-value="${esc(it.key)}" title="${esc(it.label + tip)}">
        <span class="lbl">${wrap}${esc(it.label)}</span><span class="cnt">${it.count}</span>
      </button>`;
        })
        .join('')
    : '<div class="side-empty">还没有数据</div>';

  return `<div class="sgroup ${closed ? 'closed' : ''}" data-group="${section.key}">
    <button class="sgroup-head" data-toggle="${section.key}">
      <span class="caret">▾</span>${section.title}<span class="n">${items.length || ''}</span>
    </button>
    <div class="sitems">${rows}</div>
  </div>`;
}

/* ------------------------------------------------------------- 接口结构树 */

/** 把 `GET /a/b/:id` 聚合项按 path 分段建树；目录 count = 之下所有叶之和，own = 本级精确命中数，
 *  routes = 汇到本级节点上的所有接口（同路径不同 method 会有多个） */
function buildRouteTree(items) {
  const root = { seg: '', count: 0, own: 0, children: new Map(), routes: new Map() };
  for (const it of items) {
    const m = String(it.key || '').match(/^(\S+)\s+(.*)$/);
    const path = m ? m[2] : String(it.key || '');
    const segs = path.split('/').filter(Boolean);
    root.count += it.count;
    if (!segs.length) {
      // 根路径 "/" 本身也是一个叶
      let n = root.children.get('/');
      if (!n) {
        n = { seg: '/', count: 0, own: 0, children: new Map(), routes: new Map() };
        root.children.set('/', n);
      }
      n.count += it.count;
      n.own += it.count;
      n.routes.set(it.key, (n.routes.get(it.key) || 0) + it.count);
      continue;
    }
    let node = root;
    segs.forEach((seg, i) => {
      let child = node.children.get(seg);
      if (!child) {
        child = { seg, count: 0, own: 0, children: new Map(), routes: new Map() };
        node.children.set(seg, child);
      }
      child.count += it.count;
      if (i === segs.length - 1) {
        child.own += it.count;
        child.routes.set(it.key, (child.routes.get(it.key) || 0) + it.count);
      }
      node = child;
    });
  }
  return root;
}

function renderRouteKids(node, depth, prefix) {
  const kids = [...node.children.values()].sort((a, b) => {
    if (!!a.children.size !== !!b.children.size) return a.children.size ? -1 : 1; /* 目录在前 */
    return b.count - a.count;
  });
  return kids.map((c) => renderRouteNode(c, depth, prefix)).join('');
}

function routeLeafHtml(route, seg, count, depth, extraClass = '') {
  const m = String(route || '').match(/^(\S+)\s+(.*)$/);
  const method = m ? m[1] : '';
  const on = S.filter.route === route ? 'on' : '';
  const pad = `padding-left:${depth * 13 + 8}px`;
  return `<button class="sitem ${on} ${extraClass}" data-facet="route" data-value="${esc(route)}" title="${esc(route)}" style="${pad}">
    <span class="lbl">${esc(seg)}<i class="rmethod">${esc(method)}</i></span>
    <span class="cnt">${count}</span>
  </button>`;
}

function renderRouteNode(node, depth, prefix) {
  const routes = [...(node.routes || [])];
  // 同一路径挂了多个 method（GET /a/b + POST /a/b）且没有下级：直接平铺成多个叶
  if (routes.length > 1 && !node.children.size) {
    return routes.map(([r, c]) => routeLeafHtml(r, node.seg, c, depth)).join('');
  }
  if (routes.length === 1 && !node.children.size) {
    return routeLeafHtml(routes[0][0], node.seg, node.own, depth);
  }

  const key = prefix ? `${prefix}/${node.seg}` : node.seg;
  const defOpen = depth < 1;
  const open = S.routeToggled.has(key) ? !defOpen : defOpen;
  const pad = `padding-left:${depth * 13 + 8}px`;
  const first = String(routes[0] ? routes[0][0] : node.seg);
  const selfLeaves = routes.map(([r, c]) => routeLeafHtml(r, '· 本级', c, depth + 1)).join('');
  return `<div class="rnode ${open ? 'open' : ''}">
    <button class="rhead" data-rtoggle="${esc(key)}" title="${esc(first)}" style="${pad}">
      <span class="caret">▸</span><span class="lbl">${esc(node.seg)}</span><span class="cnt">${node.count}</span>
    </button>
    <div class="rchildren" ${open ? '' : 'hidden'}>${selfLeaves}${renderRouteKids(node, depth + 1, key + '/')}</div>
  </div>`;
}

function routeGroupHtml(section) {
  const items = S.facets.routes || [];
  const closed = S.closedGroups.has(section.key);
  const rows = items.length ? renderRouteKids(buildRouteTree(items), 0, '') : '<div class="side-empty">还没有数据</div>';
  return `<div class="sgroup ${closed ? 'closed' : ''}" data-group="${section.key}">
    <button class="sgroup-head" data-toggle="${section.key}">
      <span class="caret">▾</span>${section.title}<span class="n">${items.length || ''}</span>
    </button>
    <div class="sitems rtree">${rows}</div>
  </div>`;
}

function bookmarkGroupHtml() {  const closed = S.closedGroups.has('bookmarks');
  const active = activeFilterKeys().length > 0;
  const items = S.bookmarks
    .map(
      (b) => `<div class="sitem ${sameFilter(b.filter) ? 'on' : ''}" data-bookmark="${b.id}" title="${esc(
        JSON.stringify(b.filter)
      )}">
        <span class="lbl">★ ${esc(b.label)}</span>
        <button class="del" data-del-bookmark="${b.id}" title="删除书签">✕</button>
      </div>`
    )
    .join('');

  return `<div class="sgroup ${closed ? 'closed' : ''}" data-group="bookmarks">
    <button class="sgroup-head" data-toggle="bookmarks">
      <span class="caret">▾</span>收藏<span class="n">${S.bookmarks.length || ''}</span>
    </button>
    <div class="sitems">
      ${items}
      ${active ? '<div class="sitem" data-save-bookmark="1"><span class="lbl">＋ 收藏当前筛选</span></div>' : ''}
      ${
        !S.bookmarks.length && !active
          ? '<div class="side-empty">在请求详情里点「收藏」，会把这条请求的「应用 + 接口」存成书签</div>'
          : ''
      }
    </div>
  </div>`;
}

function sameFilter(filter) {
  const keys = Object.keys(filter || {});
  if (!keys.length) return false;
  return keys.every((k) => String(S.filter[k] || '') === String(filter[k]));
}

function setFacet(key, value) {
  if (!value) return;
  if (S.filter[key] === value) delete S.filter[key];
  else S.filter[key] = value;
  syncFilters();
}

function clearFacet(key) {
  delete S.filter[key];
  if (key === 'q') {
    S.filter.q = '';
    const input = $('#search');
    if (input) input.value = '';
  }
  syncFilters();
}

function syncFilters() {
  renderChips();
  renderSide();
  loadFlows();
}

function renderChips() {
  const el = $('#chips');
  if (!el) return;
  const parts = [];
  for (const key of ['ip', 'app', 'host', 'route']) {
    if (!S.filter[key]) continue;
    parts.push(
      `<span class="chip"><span class="t">${FILTER_LABELS[key]}：${esc(facetDisplay(key, S.filter[key]))}</span><button data-clear="${key}" title="取消">✕</button></span>`
    );
  }
  if (S.filter.q) {
    parts.push(
      `<span class="chip"><span class="t">搜索：${esc(S.filter.q)}</span><button data-clear="q" title="取消">✕</button></span>`
    );
  }
  el.innerHTML = parts.join('');
}

async function saveBookmark(filter, label) {
  try {
    await api('/api/bookmarks', { method: 'POST', body: { filter, label } });
    await loadBookmarks();
    toast('已收藏');
  } catch (err) {
    toast('收藏失败: ' + err.message);
  }
}

async function bookmarkFlow(f) {
  const filter = {};
  if (f.app && f.app !== '未知来源') filter.app = f.app;
  if (f.host) filter.host = f.host;
  if (f.route) filter.route = f.route;
  if (!Object.keys(filter).length) return;
  const label = [filter.app, filter.route || filter.host].filter(Boolean).join(' · ');
  await saveBookmark(filter, label);
}

async function saveCurrentFilter() {
  const filter = {};
  for (const key of activeFilterKeys()) {
    if (key === 'mocked') continue;
    filter[key] = S.filter[key];
  }
  if (!Object.keys(filter).length) return;
  const label = activeFilterKeys()
    .map((k) => facetDisplay(k, S.filter[k]))
    .join(' · ')
    .slice(0, 80);
  await saveBookmark(filter, label);
}

const NARROW = window.matchMedia('(max-width: 900px)');

function setSideVisible(visible) {
  const side = $('#side');
  const split = $('#splitSide');
  const show = $('#sideShow');
  const backdrop = $('#sideBackdrop');
  if (!side) return;
  if (NARROW.matches) {
    side.hidden = false;
    side.classList.toggle('open', visible);
    if (split) split.hidden = true;
    if (backdrop) backdrop.hidden = !visible;
    if (show) show.hidden = true;
  } else {
    side.hidden = !visible;
    side.classList.remove('open');
    if (split) split.hidden = !visible;
    if (backdrop) backdrop.hidden = true;
    if (show) show.hidden = visible;
    localStorage.setItem('reqlite-side-hidden', visible ? '0' : '1');
  }
}

/** 窗口宽度变化时重置边栏形态：宽屏是常驻栏，窄屏是抽屉 */
function syncSideForViewport() {
  const side = $('#side');
  const split = $('#splitSide');
  const show = $('#sideShow');
  const backdrop = $('#sideBackdrop');
  if (!side) return;
  side.classList.remove('open');
  if (backdrop) backdrop.hidden = true;
  if (NARROW.matches) {
    side.hidden = false;
    if (split) split.hidden = true;
    if (show) show.hidden = false;
  } else {
    const hidden = localStorage.getItem('reqlite-side-hidden') === '1';
    side.hidden = hidden;
    if (split) split.hidden = hidden;
    if (show) show.hidden = !hidden;
  }
}

/* ------------------------------------------------ 两根纵向分割线的拖动 */

const PANE_KEY = 'reqlite-panes';
const SIDE_MIN = 160;
const SIDE_MAX = 360;
const LIST_MIN = 260;
const DETAIL_MIN = 260;

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const paneVar = (which) => (which === 'side' ? '--side-w' : '--list-w');
const paneEl = (which) => (which === 'side' ? $('#side') : $('.listpane'));
const paneCurrent = (which) => {
  const el = paneEl(which);
  return el ? el.getBoundingClientRect().width : 0;
};

function paneWidths() {
  try {
    const v = JSON.parse(localStorage.getItem(PANE_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

function writePaneWidths(p) {
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify(p));
  } catch (_) {
    /* 隐私模式：只在本次会话内生效 */
  }
}

/** 当前窗口下该栏允许的像素范围；上限保证另外两栏还看得见 */
function paneBounds(which) {
  if (which === 'side') {
    const shell = $('#shell');
    const w = shell ? shell.getBoundingClientRect().width : window.innerWidth;
    return [SIDE_MIN, clampNum(w - LIST_MIN - DETAIL_MIN, SIDE_MIN, SIDE_MAX)];
  }
  const layout = $('.layout');
  const w = layout ? layout.getBoundingClientRect().width : window.innerWidth;
  return [LIST_MIN, clampNum(w - DETAIL_MIN - 1, LIST_MIN, 100000)];
}

function setPaneWidth(which, px) {
  document.documentElement.style.setProperty(paneVar(which), Math.round(px) + 'px');
}

function savePaneWidth(which, px) {
  const p = paneWidths();
  p[which] = Math.round(px);
  writePaneWidths(p);
}

function resetPaneWidth(which) {
  document.documentElement.style.removeProperty(paneVar(which));
  const p = paneWidths();
  delete p[which];
  writePaneWidths(p);
  updateSplitterAria();
  toast('栏宽已复位');
}

/** 首屏 / 窗口尺寸变化时，把持久化的宽度夹到合法范围再应用 */
function applyPaneWidths() {
  const p = paneWidths();
  ['side', 'list'].forEach((which) => {
    const v = Number(p[which]);
    if (!Number.isFinite(v) || v <= 0) {
      document.documentElement.style.removeProperty(paneVar(which));
      return;
    }
    const [lo, hi] = paneBounds(which);
    setPaneWidth(which, clampNum(v, lo, hi));
  });
  updateSplitterAria();
}

function updateSplitterAria() {
  $$('.splitter').forEach((el) => {
    const which = el.id === 'splitSide' ? 'side' : 'list';
    const [lo, hi] = paneBounds(which);
    el.setAttribute('aria-valuemin', String(Math.round(lo)));
    el.setAttribute('aria-valuemax', String(Math.round(hi)));
    el.setAttribute('aria-valuenow', String(Math.round(paneCurrent(which))));
  });
}

function bindSplitter(which) {
  const el = which === 'side' ? $('#splitSide') : $('#splitList');
  if (!el) return;
  let startX = 0;
  let startW = 0;
  let lastW = 0;
  let active = false;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || NARROW.matches || el.hidden) return;
    active = true;
    startX = e.clientX;
    startW = paneCurrent(which);
    lastW = startW;
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 老浏览器靠 document 兜底 */
    }
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const [lo, hi] = paneBounds(which);
    lastW = clampNum(startW + (e.clientX - startX), lo, hi);
    setPaneWidth(which, lastW);
    updateSplitterAria();
  });

  const finish = () => {
    if (!active) return;
    active = false;
    el.classList.remove('dragging');
    document.body.classList.remove('resizing');
    savePaneWidth(which, lastW);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);

  el.addEventListener('dblclick', () => resetPaneWidth(which));
  el.addEventListener('keydown', (e) => {
    if (NARROW.matches) return;
    if (e.key === 'Home') {
      resetPaneWidth(which);
      e.preventDefault();
      return;
    }
    let next;
    if (e.key === 'ArrowLeft') next = paneCurrent(which) - (e.shiftKey ? 48 : 16);
    else if (e.key === 'ArrowRight') next = paneCurrent(which) + (e.shiftKey ? 48 : 16);
    else return;
    const [lo, hi] = paneBounds(which);
    const v = clampNum(next, lo, hi);
    setPaneWidth(which, v);
    savePaneWidth(which, v);
    updateSplitterAria();
    e.preventDefault();
  });
}

/* ---------------------------------------------------------------- 详情 */

async function selectFlow(id) {
  if (!id) return;
  S.selectedId = id;
  $$('.row').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
  try {
    const flow = await api('/api/flows/' + id);
    S.selected = flow;
    S.detailTab = 'overview';
    renderDetail();
  } catch (err) {
    toast('读取详情失败: ' + err.message);
  }
}

function kv(pairs) {
  const items = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!items.length) return '<p class="hint">（无）</p>';
  return `<dl class="kv">${items
    .map(([k, v]) => {
      // 值可以是 { html } —— 详情里的「应用 / 设备」行要带图标，不能整体 esc
      const body =
        v && typeof v === 'object' && typeof v.html === 'string' ? v.html : esc(v);
      return `<dt>${esc(k)}</dt><dd>${body}</dd>`;
    })
    .join('')}</dl>`;
}

const HOT_HEADERS = new Set([
  'content-type', 'authorization', 'cookie', 'set-cookie', 'user-agent', 'host', 'origin', 'referer',
  'content-length', 'location', 'accept-encoding', 'proxy-authorization', 'x-requested-with',
]);

function headersKv(headers, side) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '<p class="hint">（无）</p>';
  return `<dl class="kv headers">${entries
    .map(([k, v], i) => {
      const val = Array.isArray(v) ? v.join('\n') : String(v);
      const hot = HOT_HEADERS.has(k.toLowerCase()) ? ' hot' : '';
      return `<div class="kv-row${hot}" data-hd-row="${side}:${i}" title="点击复制此行"><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`;
    })
    .join('')}</dl>`;
}

/** 请求头/响应头区块：行 hover 复制 + 复制全部（k: v）/ 复制 JSON */
function headerSec(title, headers, side) {
  const n = Object.keys(headers || {}).length;
  const tools = n
    ? `<span class="body-tools">
        <button class="body-tool" data-hd-copy="${side}" title="按行复制全部（每行 name: value）">复制全部</button>
        <button class="body-tool" data-hd-json="${side}" title="复制为 JSON 对象">复制 JSON</button>
      </span>`
    : '';
  return `<div class="sec"><div class="sec-head">${esc(title)} <span class="hint">${n} 项</span>${tools}<span class="fill"></span></div>${headersKv(headers, side)}</div>`;
}

/** 原始报文文本（渲染与复制共用一份逻辑） */
function rawTextOf(f, side) {
  const lines =
    side === 'req'
      ? [`${f.method} ${f.path || f.url || '/'} HTTP/1.1`]
      : [`HTTP/1.1 ${f.status || 0} ${f.statusText || ''}`.trim()];
  const headers = side === 'req' ? f.reqHeaders : f.resHeaders;
  for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${Array.isArray(v) ? v.join('\n') : v}`);
  const body = side === 'req' ? f.reqBody : f.resBody;
  if (body) lines.push('', body);
  return lines;
}

function renderDetail() {
  const f = S.selected;
  const pane = $('#detail');
  if (!f) return;

  const tabs = [
    ['overview', '概览'],
    ['request', '请求'],
    ['response', '响应'],
    ['raw', '原始'],
  ];

  const bodyHtml =
    S.detailTab === 'overview'
      ? tabOverview(f)
      : S.detailTab === 'request'
      ? tabRequest(f)
      : S.detailTab === 'response'
      ? tabResponse(f)
      : tabRaw(f);

  pane.innerHTML = `
    <div class="dhead">
      <div class="dline">
        <span class="dmethod">${esc(f.method)}</span>
        <span class="durl">${urlHtml(f)}</span>
      </div>
      <div class="dmeta">
        <span class="st ${statusClass(f.status)}">${esc(f.error ? 'ERR' : f.status || '—')} ${esc(f.statusText || '')}</span>
        <span>耗时 <b>${fmtTime(f.duration)}</b></span>
        <span>请求 <b>${fmtSize(f.reqSize)}</b> / 响应 <b>${fmtSize(f.resSize)}</b></span>
        <span>${fmtClock(f.ts)}</span>
        ${f.mocked ? '<span class="tag mock">MOCK</span>' : ''}
        ${f.replayOf ? '<span class="tag replay">REPLAY</span>' : ''}
        <span class="dactions">
          <button class="btn" id="actReplay">重放</button>
          <button class="btn" id="actMock">Mock 此请求</button>
          <button class="btn ghost" id="actStar">☆ 收藏</button>
          <button class="btn ghost" id="actCurl">复制 cURL</button>
        </span>
      </div>
      <div class="tabs" id="tabs">
        ${tabs
          .map(
            ([k, label]) =>
              `<button data-tab="${k}" class="${S.detailTab === k ? 'on' : ''}">${label}</button>`
          )
          .join('')}
        <span class="spacer"></span>
        <button data-tab="copy-body" class="hint">复制响应体</button>
      </div>
    </div>
    <div class="dbody">${bodyHtml}</div>`;

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    if (btn.dataset.tab === 'copy-body') {
      navigator.clipboard
        .writeText(f.resBody || '')
        .then(() => toast('响应体已复制'))
        .catch(() => toast('复制失败'));
      return;
    }
    S.detailTab = btn.dataset.tab;
    renderDetail();
  });

  $('#actReplay')?.addEventListener('click', openReplay);
  $('#actMock')?.addEventListener('click', () => openRuleForm(fromFlowRule(f)));
  $('#actStar')?.addEventListener('click', () => bookmarkFlow(f));
  $('#actCurl')?.addEventListener('click', () => {
    navigator.clipboard
      .writeText(toCurl(f))
      .then(() => toast('cURL 已复制'))
      .catch(() => toast('复制失败'));
  });

  if (f.replayOf) {
    $$('[data-goto]').forEach((el) =>
      el.addEventListener('click', () => selectFlow(el.dataset.goto))
    );
  }
}

function urlHtml(f) {
  const raw = String(f.url || '');
  const i = raw.indexOf('://');
  const scheme = i > 0 ? raw.slice(0, i + 3) : '';
  const rest = i > 0 ? raw.slice(i + 3) : raw;
  const qi = rest.indexOf('?');
  const path = qi >= 0 ? rest.slice(0, qi) : rest;
  const query = qi >= 0 ? rest.slice(qi) : '';
  return `<span class="scheme">${esc(scheme)}</span>${esc(path)}<span class="q">${esc(query)}</span>`;
}

function tabOverview(f) {
  // 本机流量统一叫「本机」，后面仍带上原始 IP 便于排查；远程设备不再显示「未知 xx」
  const dev = f.deviceLabel || [f.platform, f.clientIp].filter(Boolean).join(' · ') || '未知设备';
  const devText =
    f.clientIp && !String(dev).includes(f.clientIp) ? `${dev} · ${f.clientIp}` : dev;
  const rows = [
    ['主机', f.host],
    ['路径', f.path],
    ['接口结构', f.route],
    ['设备', devText ? { html: ICONS().deviceHtml(devText, f.deviceKey) + `<span>${esc(devText)}</span>` } : ''],
    ['应用', f.app ? { html: ICONS().iconHtml(f.app, 'md') + `<span>${esc(f.app)}</span>` } : ''],
    [
      '应用来源',
      f.appSource === 'process'
        ? '本机进程（按连接精确匹配）'
        : f.appSource === 'alias'
        ? 'UA 别名（手动映射）'
        : 'User-Agent 推断（远程设备可用 UA 别名标注）',
    ],
    ...(f.process
      ? [
          ['进程', `${f.process.name} · PID ${f.process.pid}`],
          ['可执行文件', f.process.path || f.process.command],
        ]
      : []),
    [
      '协议',
      f.tunneled
        ? 'HTTPS（安全透传，未解密）'
        : f.scheme === 'https'
        ? 'HTTPS（已解密）'
        : f.scheme === 'http'
        ? 'HTTP'
        : f.scheme,
    ],
    ['状态', f.status ? `${f.status} ${f.statusText || ''}` : '请求失败'],
    ['耗时', fmtTime(f.duration)],
    ['请求大小', fmtSize(f.reqSize)],
    ['响应大小', fmtSize(f.resSize)],
    ['响应类型', f.resContentType],
    ['请求头数量', Object.keys(f.reqHeaders || {}).length],
    ['来源', f.mocked ? 'Mock 规则：' + (f.mockRule || '') : f.replayOf ? '重放' : '代理转发'],
  ];
  let notice = '';
  if (f.error) notice += `<div class="notice err">${esc(f.error)}</div>`;
  if (f.mocked) notice += `<div class="notice">该请求被本地 Mock 拦截，没有打到上游。</div>`;
  if (f.reqBodyTruncated || f.resBodyTruncated)
    notice += `<div class="notice">body 超过 2MB，仅记录了前面部分。</div>`;
  if (f.replayOf)
    notice += `<div class="notice">重放自 <a href="#" data-goto="${f.replayOf}">原请求</a>。</div>`;
  if (f.note) notice += `<div class="notice">${esc(f.note)}</div>`;
  return notice + `<div class="sec">${kv(rows)}</div>`;
}

/** 从 base64 头部嗅探真实类型（Content-Type 可能缺失或撒谎） */
function sniffMime(b64) {
  let head = '';
  try {
    head = atob(b64.slice(0, 24));
  } catch {
    return '';
  }
  const b = [...head].map((c) => c.charCodeAt(0));
  const eq = (off, sig) => sig.every((v, i) => b[off + i] === v);
  if (eq(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (eq(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (eq(0, [0x47, 0x49, 0x46])) return 'image/gif';
  if (eq(0, [0x52, 0x49, 0x46, 0x46]) && eq(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (eq(0, [0x42, 0x4d])) return 'image/bmp';
  if (eq(0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (eq(0, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (eq(0, [0x1f, 0x8b])) return 'application/gzip';
  return '';
}

/** 二进制 body 的展示信息：mime / 是否图片 / 下载文件名 */
function binInfoOf(f, kind) {
  const b64 = kind === 'request' ? f.reqBodyBase64 : f.resBodyBase64;
  if (!b64) return null;
  const truncated = kind === 'request' ? f.reqBodyTruncated : f.resBodyTruncated;
  const ct = String(kind === 'request' ? (f.reqHeaders || {})['content-type'] : f.resContentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mime = sniffMime(b64) || ct || 'application/octet-stream';
  const pathPart = String(f.path || f.url || '').split('?')[0];
  let name = String(pathPart.split('/').pop() || '').slice(0, 80);
  const extByMime = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/x-icon': 'ico', 'application/zip': 'zip', 'application/gzip': 'gz',
  };
  const ext = extByMime[mime];
  if (ext && !new RegExp(`\\.${ext}$`, 'i').test(name)) name += `.${ext}`;
  return { base64: b64, mime, isImage: /^image\//.test(mime), truncated: !!truncated, name: name || 'body' };
}

/** base64 → hex dump（offset + hex + ascii），默认只看前 4KB */
function hexDump(b64, limit = 4096) {
  const b64Head = b64.slice(0, Math.ceil(limit / 3) * 4);
  let bytes;
  try {
    bytes = Uint8Array.from(atob(b64Head), (c) => c.charCodeAt(0));
  } catch {
    return '';
  }
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = [...bytes.slice(i, i + 16)];
    const hex = chunk.map((v) => v.toString(16).padStart(2, '0'));
    while (hex.length < 16) hex.push('  ');
    const ascii = chunk.map((v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '·')).join('');
    rows.push(`${i.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  ${ascii}`);
  }
  return rows.join('\n');
}

/** 详情面板的请求/响应体：结构化（格式化 + 可折叠树 + 行号）/ 原始 / 二进制（预览/Base64/Hex）/ 全屏 / 复制 */
function bodySection(title, sizeLabel, body, contentType, kind, bin) {
  const raw = String(body == null ? '' : body);
  const prettyText = pretty(raw, contentType);
  const json = JE() ? JE().looksLikeJSON(prettyText) : false;
  if (!S.bodyView[kind]) S.bodyView[kind] = { mode: bin && bin.isImage ? 'preview' : 'pretty', fs: false };
  if (S.bodyView[kind].mode === 'tree') S.bodyView[kind].mode = 'pretty'; // 旧记忆兼容
  // 记忆的视图模式对当前 flow 可能不适用（如记忆了「预览」但这条不是图片）
  if (S.bodyView[kind].mode === 'preview' && !(bin && bin.isImage)) S.bodyView[kind].mode = bin ? 'base64' : 'pretty';
  if (bin && !['preview', 'base64', 'hex'].includes(S.bodyView[kind].mode)) S.bodyView[kind].mode = bin.isImage ? 'preview' : 'base64';
  const mode = S.bodyView[kind].mode;
  const fs = !!S.bodyView[kind].fs;
  const btn = (m, label, tip) =>
    `<button class="body-tool ${mode === m ? 'on' : ''}" data-body-mode="${m}" data-body-kind="${kind}" title="${tip || label}">${label}</button>`;
  const foldBtns =
    json && mode === 'pretty'
      ? `<button class="body-tool" data-body-fold="1" data-body-kind="${kind}" title="展开全部对象和数组">展开全部</button>
         <button class="body-tool" data-body-fold="0" data-body-kind="${kind}" title="收起全部对象和数组">折叠全部</button>`
      : '';
  const binBtns = bin
    ? `${bin.isImage ? btn('preview', '预览', '渲染图片预览') : ''}${btn('base64', 'Base64', '完整 base64 文本')}${btn('hex', 'Hex', '十六进制 dump（前 4KB）')}`
    : '';
  const dlBtn = bin
    ? `<a class="body-tool" href="data:${bin.mime};base64,${bin.base64}" download="${esc(bin.name)}" title="保存为本地文件">下载</a>`
    : '';
  const tools = `<span class="body-tools">
    ${bin ? binBtns : `${btn('pretty', '结构化', '格式化 JSON，每层可折叠')}${btn('raw', '原始', '未经处理的原文')}`}
    ${foldBtns}
    <button class="body-tool" data-body-fs="${kind}" title="全屏查看，Esc 退出">${fs ? '⤡ 退出全屏' : '⤢ 全屏'}</button>
    ${dlBtn}
    <button class="body-tool" data-body-copy="${kind}" title="复制当前视图内容">复制</button>
  </span>`;
  let view;
  if (bin) {
    if (mode === 'preview') {
      view = `<div class="body-view bin-preview"><img src="data:${bin.mime};base64,${bin.base64}" alt="${esc(bin.name)}" draggable="false"></div>`;
    } else if (mode === 'hex') {
      const dump = hexDump(bin.base64);
      view = `<pre class="code-block body-view hex-view" data-json="0">${esc(dump)}</pre>${
        bin.base64.length * 0.75 > 4096 ? `<p class="hint bin-note">Hex 只显示前 4KB，完整内容用上方「下载」或 Base64 视图。</p>` : ''
      }`;
    } else {
      view = `<pre class="code-block body-view wrap" data-json="0">${esc(bin.base64)}</pre>`;
    }
  } else if (!raw) view = '<p class="hint">（无内容）</p>';
  else if (mode === 'pretty' && json && JE()) {
    // 结构化 = 格式化 + 树一体：展开时是着色的格式化文本，点 ▸ 收起该层
    const fold = JE().foldHtml(prettyText);
    view = fold
      ? `<div class="body-view json-fold" data-json="1">${fold}</div>`
      : `<pre class="code-block body-view" data-json="1">${JE().colorize(prettyText)}</pre>`;
  } else {
    const text = mode === 'raw' ? raw : prettyText;
    const inner = json && mode === 'pretty' && JE() ? JE().colorize(text) : esc(text);
    view = `<pre class="code-block body-view" data-json="${json ? 1 : 0}">${inner}</pre>`;
  }
  const lineCount = !bin && raw ? (mode === 'raw' ? raw : prettyText).split('\n').length : 0;
  const head = `${esc(title)} <span class="hint">${esc(sizeLabel)}${lineCount ? ` · ${lineCount} 行` : ''}</span>${tools}<span class="fill"></span>`;
  return `<div class="sec${fs ? ' body-fs' : ''}"><div class="sec-head">${head}</div>${view}</div>`;
}

function tabRequest(f) {
  const bin = binInfoOf(f, 'request');
  return `
    ${headerSec('请求头', f.reqHeaders, 'req')}
    ${bodySection('请求体', fmtSize(f.reqSize), f.reqBody || '', (f.reqHeaders || {})['content-type'], 'request', bin)}`;
}

function tabResponse(f) {
  const bin = binInfoOf(f, 'response');
  return `
    ${headerSec('响应头', f.resHeaders, 'res')}
    ${bodySection('响应体', fmtSize(f.resSize), f.resBody || '', f.resContentType, 'response', bin)}`;
}

function tabRaw(f) {
  const sec = (title, side, binSize) => {
    const lines = rawTextOf(f, side);
    const binNote = binSize ? `<p class="hint bin-note">（${side === 'req' ? '请求' : '响应'}体为二进制 ${fmtSize(binSize)}，原文中省略；完整内容见 ${side === 'req' ? '请求' : '响应'}页签的 Base64 / 下载）</p>` : '';
    const tools = `<span class="body-tools">
      <button class="body-tool" data-raw-copy="${side}" title="复制整段报文（含 body）">复制全部</button>
      <button class="body-tool" data-raw-copy-heads="${side}" title="只复制状态行和头，不含 body">仅状态行和头</button>
    </span>`;
    return `<div class="sec">
      <div class="sec-head">${esc(title)} <span class="hint">${lines.length} 行</span>${tools}<span class="fill"></span></div>
      <pre class="code-block raw-view" data-json="0">${lines
        .map((l, i) => `<div class="raw-line" data-raw-line="${side}:${i}" title="点击复制此行"><span>${esc(l)}</span></div>`)
        .join('')}</pre>${binNote}
    </div>`;
  };
  const reqBin = f.reqBodyBase64 && !f.reqBody ? f.reqSize : 0;
  const resBin = f.resBodyBase64 && !f.resBody ? f.resSize : 0;
  return `${sec('请求原文', 'req', reqBin)}${sec('响应原文', 'res', resBin)}`;
}

function toCurl(f) {
  const skip = ['host', 'content-length', 'connection', 'accept-encoding', 'proxy-connection'];
  const parts = [`curl -X ${f.method} '${f.url}'`];
  for (const [k, v] of Object.entries(f.reqHeaders || {})) {
    if (skip.includes(k.toLowerCase())) continue;
    if (k.startsWith(':')) continue;
    parts.push(`  -H '${k}: ${Array.isArray(v) ? v.join(', ') : v}'`);
  }
  if (f.reqBody) parts.push(`  --data-raw '${String(f.reqBody).replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n');
}

/* ---------------------------------------------------------------- 操作 */

function openModal(id) {
  $(id).hidden = false;
  if (window.ReqLiteJSON) setTimeout(() => window.ReqLiteJSON.relayout(), 30);
}
function closeModals() {
  $$('.modal').forEach((m) => (m.hidden = true));
}

function headersToLines(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
}

function openReplay() {
  const f = S.selected;
  if (!f) return;
  $('#rpMethod').value = f.method;
  $('#rpUrl').value = f.url;
  $('#rpHeaders').value = headersToLines(f.reqHeaders).replace(/^host: .*$/im, '').trim();
  setReplayBody(f.reqBody || '');
  $('#rpBodyLang').value = 'auto';
  if (RU.replayBody) RU.replayBody.setLanguage('auto');
  updateReplayStatus();
  $('#rpHint').textContent = '重放会直接打上游，不经过 Mock 规则';
  openModal('#modalReplay');
  setTimeout(() => $('#rpUrl').focus(), 30);
}

async function sendReplay() {
  const f = S.selected;
  if (!f) return;
  const headers = {};
  for (const line of $('#rpHeaders').value.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const btn = $('#rpSend');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const result = await api(`/api/flows/${f.id}/replay`, {
      method: 'POST',
      body: {
        method: $('#rpMethod').value,
        url: $('#rpUrl').value.trim(),
        headers,
        body: replayBodyValue(),
      },
    });
    closeModals();
    if (result.flow) {
      await loadFlows();
      selectFlow(result.flow.id);
      toast(`重放完成：${result.flow.status || 'ERR'}`);
    } else {
      toast('重放失败: ' + (result.error || '未知错误'));
    }
  } catch (err) {
    toast('重放失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

function fromFlowRule(f) {
  const path = (() => {
    try {
      const u = new URL(f.url);
      return u.pathname;
    } catch (_) {
      return f.path || '';
    }
  })();
  const resHeaders = f.resHeaders || {};
  return {
    name: `${f.method} ${path}`,
    method: f.method,
    host: f.host,
    urlMatch: path,
    matchMode: 'contains',
    status: f.status || 200,
    delayMs: 0,
    headers: { 'content-type': resHeaders['content-type'] || 'application/json; charset=utf-8' },
    body: f.resBody ? pretty(f.resBody, resHeaders['content-type']) : '',
  };
}

/* ---------------------------------------------- 富版 Mock 规则编辑器 / JSON */

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable',
};
const LANG_LABEL = { json: 'JSON', plaintext: '纯文本', html: 'HTML', xml: 'XML', javascript: 'JS' };
const MODE_HINT = {
  contains: '包含：请求的完整 URL 里出现这段文字就命中，大小写不敏感。例：/api/user',
  wildcard: '通配符：* 匹配任意字符，整段 URL 参与匹配。例：*/api/user/*',
  regex: '正则：用 JavaScript 正则匹配完整 URL（忽略大小写）。例：^https://api\\.example\\.com/user/\\d+$',
};

const RU = { body: null, replayBody: null, ioBody: null, tab: 'match', ioMode: 'export', ioArmed: false };
const JE = () => window.ReqLiteJSON;

function ruleBodyValue() {
  return RU.body ? RU.body.getValue() : ($('#ruBody') ? $('#ruBody').value : '');
}
function setRuleBody(v) {
  const text = v == null ? '' : String(v);
  if (RU.body) RU.body.setValue(text);
  if ($('#ruBody')) $('#ruBody').value = text;
}
function replayBodyValue() {
  return RU.replayBody ? RU.replayBody.getValue() : ($('#rpBody') ? $('#rpBody').value : '');
}
function setReplayBody(v) {
  const text = v == null ? '' : String(v);
  if (RU.replayBody) RU.replayBody.setValue(text);
  if ($('#rpBody')) $('#rpBody').value = text;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label || '已复制');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label || '已复制');
    } catch (_) {
      toast('复制失败');
    }
    ta.remove();
  }
}

function pickFile(cb) {
  const input = $('#fileInput');
  if (!input) return;
  input.value = '';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => cb(String(reader.result || ''));
    reader.readAsText(f);
  };
  input.click();
}

/** 三个编辑器都是常驻 DOM，只 mount 一次，开弹窗时换内容 + 重新布局 */
function mountEditorsOnce() {
  const je = JE();
  if (!je) return;
  if (!RU.body && $('#ruBodyEditor')) {
    RU.body = je.mount($('#ruBodyEditor'), {
      source: $('#ruBody'), language: 'auto', ariaLabel: 'Mock 响应体编辑器',
      onChange: () => updateAllRuleUI(),
      onCursor: (p) => {
        const el = $('#ruBodyCursor');
        if (el) el.textContent = `行 ${p.lineNumber} · 列 ${p.column}`;
      },
    });
  }
  if (!RU.replayBody && $('#rpBodyEditor')) {
    RU.replayBody = je.mount($('#rpBodyEditor'), {
      source: $('#rpBody'), language: 'auto', ariaLabel: '重放请求体编辑器',
      onChange: () => updateReplayStatus(),
    });
  }
  if (!RU.ioBody && $('#jsonIoEditor')) {
    RU.ioBody = je.mount($('#jsonIoEditor'), {
      source: $('#jsonIoSource'), language: 'json', ariaLabel: '规则 JSON 导入导出',
      onChange: () => updateJsonIoStatus(),
    });
  }
}

/* ---------------------------------------------------------- 响应头表格 */

function parseHeaderLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i > 0) out.push({ k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() });
    else out.push({ k: line.trim(), v: '' });
  }
  return out;
}
function setHeaderRows(rows) {
  $('#ruHeaders').value = rows
    .filter((r) => r.k && r.k.trim())
    .map((r) => `${r.k.trim()}: ${r.v || ''}`)
    .join('\n');
  renderHeaderRows();
  updateAllRuleUI();
}
function renderHeaderRows() {
  const box = $('#ruHeaderRows');
  if (!box) return;
  const rows = parseHeaderLines($('#ruHeaders').value);
  box.innerHTML = rows.length
    ? rows
        .map(
          (r, i) => `<div class="re-hdr-row">
        <input class="input mono" data-hk="${i}" value="${esc(r.k)}" placeholder="Header" spellcheck="false" />
        <input class="input mono" data-hv="${i}" value="${esc(r.v)}" placeholder="Value" spellcheck="false" />
        <button type="button" class="re-hdr-del" data-hdel="${i}" title="删除这一行">✕</button>
      </div>`
        )
        .join('')
    : '<p class="hint">（无响应头，点右上「+ 添加一行」）</p>';
}
function syncContentTypeFromHeaders() {
  const ct = parseHeaderLines($('#ruHeaders').value).find((r) => r.k.toLowerCase() === 'content-type');
  const sel = $('#ruContentType');
  if (!sel) return;
  const val = ct ? ct.v : '';
  sel.value = Array.from(sel.options).some((o) => o.value === val) ? val : '';
}
function setContentType(v) {
  const rows = parseHeaderLines($('#ruHeaders').value);
  const idx = rows.findIndex((r) => r.k.toLowerCase() === 'content-type');
  if (!v) {
    if (idx >= 0) rows.splice(idx, 1);
  } else if (idx >= 0) rows[idx].v = v;
  else rows.unshift({ k: 'content-type', v });
  setHeaderRows(rows);
}
function addCors() {
  const rows = parseHeaderLines($('#ruHeaders').value);
  for (const [k, v] of Object.entries({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
  })) {
    const i = rows.findIndex((r) => r.k.toLowerCase() === k);
    if (i >= 0) rows[i].v = v;
    else rows.push({ k, v });
  }
  setHeaderRows(rows);
  toast('已加入 CORS 响应头');
}

/* ------------------------------------------------------------- 模板 / Tab */

const TMPL_KEY = 'reqlite-templates';
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(TMPL_KEY) || '[]'); } catch (_) { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem(TMPL_KEY, JSON.stringify(list)); } catch (_) { /* 忽略隐私模式 */ }
  renderTemplates();
}
function tmplDesc(t) {
  const first = String(t.body || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const head = first.length > 42 ? `${first.slice(0, 42)}…` : first;
  return `HTTP ${t.status || 200} · ${head}`;
}
function renderTemplates() {
  const list = loadTemplates();
  const html = list.length
    ? list.map((t, i) => `<div class="tmpl-wrap">
        <button type="button" class="tmpl" data-tmpl="${i}" title="插入：${esc(t.name)}">
          <b>${esc(t.name)}</b><small>${esc(tmplDesc(t))}</small></button>
        <button type="button" class="tmpl-del" data-tmpl-del="${i}" title="删除模板">×</button>
      </div>`).join('')
    : '<div class="tmpl-empty">还没有自定义模板。<br>写好响应体后「＋ 存为模板」保存。</div>';
  $$('[data-template-box]').forEach((box) => (box.innerHTML = html));
}
function setTmplPicker(open) {
  const p = $('#ruTmplPicker');
  if (!p) return;
  p.hidden = !open;
  const btn = $('#ruTmplPick');
  if (btn) btn.textContent = open ? '▴ 我的模板' : '▾ 我的模板';
  if (!open) {
    const row = $('#ruTmplSave');
    if (row) row.hidden = true;
  }
}
function startSaveTemplate() {
  const body = ruleBodyValue();
  if (!body.trim()) { toast('响应体是空的，先写点内容再存'); return; }
  setTmplPicker(true);
  const row = $('#ruTmplSave');
  row.hidden = false;
  const name = $('#ruTmplName');
  name.value = '';
  name.focus();
}
function confirmSaveTemplate() {
  const list = loadTemplates();
  const name = $('#ruTmplName').value.trim() || `模板 ${list.length + 1}`;
  const t = {
    name,
    status: Number($('#ruStatus') && $('#ruStatus').value) || 200,
    lang: ($('#ruBodyLang') && $('#ruBodyLang').value) || 'json',
    body: ruleBodyValue(),
    at: Date.now(),
  };
  const i = list.findIndex((x) => x.name === t.name);
  const replaced = i >= 0;
  if (replaced) list[i] = t; else list.push(t);
  saveTemplates(list);
  setTmplPicker(false);
  toast(replaced ? `已覆盖模板「${t.name}」` : `已存为模板「${t.name}」`);
}
function applyTemplate(i) {
  const t = loadTemplates()[i];
  if (!t) return;
  let body = t.body || '';
  // 存的时候可能是压缩的一行 JSON，插入时顺手格式化成可读形态
  if (JE() && JE().looksLikeJSON(body)) {
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) { /* 非 JSON 原样 */ }
  }
  setRuleBody(body);
  const st = $('#ruStatus');
  if (st) st.value = t.status || 200;
  if (t.lang && t.lang !== 'auto' && $('#ruBodyLang')) {
    $('#ruBodyLang').value = t.lang;
    applyBodyLang(t.lang);
  }
  switchRuleTab('body');
  setTmplPicker(false);
  toast(`已插入「${t.name}」模板`);
  updateAllRuleUI();
}
function switchRuleTab(name) {
  RU.tab = name;
  $$('#ruTabs button[data-rutab]').forEach((b) => b.classList.toggle('on', b.dataset.rutab === name));
  $$('.re-pane[data-rupane]').forEach((p) => p.classList.toggle('on', p.dataset.rupane === name));
  if (name === 'preview') renderRulePreview();
  if (JE()) setTimeout(() => JE().relayout(), 20);
}

/* ------------------------------------------------------------ 表单收集 */

function collectRule() {
  const headers = {};
  for (const r of parseHeaderLines($('#ruHeaders').value)) {
    if (r.k.trim()) headers[r.k.trim().toLowerCase()] = r.v;
  }
  return {
    name: $('#ruName').value.trim() || '未命名规则',
    note: $('#ruNote').value.trim(),
    enabled: $('#ruEnabled').checked,
    method: $('#ruMethod').value,
    host: $('#ruHost').value.trim(),
    urlMatch: $('#ruMatch').value.trim(),
    matchMode: $('#ruMode').value,
    status: Number($('#ruStatus').value) || 200,
    delayMs: Math.max(0, Number($('#ruDelay').value) || 0),
    headers,
    body: ruleBodyValue(),
    bodyType: $('#ruBodyLang').value,
  };
}

/** 复刻后端 RuleEngine.match 的判定，前端零延迟给反馈 */
function testRuleMatch(rule, method, url, host) {
  if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== String(method).toUpperCase()) {
    return { hit: false, why: `方法不匹配：规则限定 ${rule.method}，测试用的是 ${method}` };
  }
  if (rule.host && String(host || '').toLowerCase() !== rule.host.toLowerCase()) {
    return { hit: false, why: `域名不匹配：规则限定 ${rule.host}，测试解析到 ${host || '(空)'}` };
  }
  const p = rule.urlMatch || '';
  if (!p) return rule.host ? { hit: true, why: '只按域名匹配，域名一致即命中' } : { hit: false, why: '规则没填 URL 匹配表达式，也没限定域名' };
  try {
    let hit = false;
    if (rule.matchMode === 'regex') hit = new RegExp(p, 'i').test(url);
    else if (rule.matchMode === 'wildcard') {
      const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      hit = re.test(url);
    } else hit = String(url).toLowerCase().includes(p.toLowerCase());
    return hit ? { hit: true, why: `URL 命中（${rule.matchMode} 模式）` } : { hit: false, why: 'URL 没有匹配上规则表达式' };
  } catch (err) {
    return { hit: false, why: '正则表达式写错了：' + err.message };
  }
}

function updateRuleModeHint() {
  const el = $('#ruModeHint');
  if (el) el.textContent = MODE_HINT[$('#ruMode').value] || MODE_HINT.contains;
}

function currentBodyIsJson() {
  const sel = $('#ruBodyLang').value;
  if (sel === 'json') return true;
  if (sel !== 'auto') return false;
  if (RU.body && RU.body.language) return RU.body.language === 'json';
  return JE() ? JE().looksLikeJSON(ruleBodyValue()) : /^\s*[[{]/.test(ruleBodyValue());
}

function updateRuleStatus() {
  const text = ruleBodyValue();
  const bytes = new Blob([text]).size;
  const st = RU.body ? RU.body.validate() : { ok: true, bytes };
  const statusEl = $('#ruBodyStatus');
  const sizeEl = $('#ruBodySize');
  const badge = $('#ruValidBadge');
  const state = $('#ruBodyState');
  const json = currentBodyIsJson();

  if (sizeEl) sizeEl.textContent = fmtSize(bytes);
  if (state) state.textContent = $('#ruBodyLang').value === 'auto' ? `自动 · ${json ? 'JSON' : '文本'}` : LANG_LABEL[$('#ruBodyLang').value] || $('#ruBodyLang').value;

  if (statusEl) {
    statusEl.className = '';
    if (!text.trim()) {
      statusEl.textContent = '空响应体（客户端会收到 0 字节）';
      statusEl.className = '';
    } else if (st.ok === null) {
      statusEl.textContent = '纯文本模式 · 不做 JSON 校验';
    } else if (st.ok === false) {
      statusEl.textContent = `✕ ${st.error}${st.line ? ` · 第 ${st.line} 行` : ''}（点校验可定位）`;
      statusEl.className = 'bad';
    } else {
      statusEl.textContent = `✓ JSON 有效 · ${st.keys || 0} 个顶层字段 · ${text.split('\n').length} 行`;
      statusEl.className = 'ok';
    }
  }
  if (badge) {
    badge.className = 're-valid' + (st.ok === false ? ' bad' : st.ok && text.trim() ? ' ok' : '');
    badge.textContent = st.ok === false ? '✕ JSON 有误' : !text.trim() ? '空响应体' : json ? '✓ JSON 有效' : '文本响应';
  }
}

function updateMatchTest() {
  const el = $('#ruTestResult');
  if (!el) return;
  const url = $('#ruTestUrl').value.trim();
  if (!url) {
    el.className = 're-test-result';
    el.textContent = '填一个 URL，实时看命中结果';
    return;
  }
  let host = $('#ruTestHost').value.trim();
  if (!host) {
    try { host = new URL(url).hostname; } catch (_) { host = ''; }
  }
  const res = testRuleMatch(collectRule(), $('#ruTestMethod').value, url, host);
  el.className = 're-test-result ' + (res.hit ? 'hit' : 'miss');
  el.textContent = (res.hit ? '✓ 命中 · ' : '✕ 不命中 · ') + res.why;
}

function updateRuleSummary() { /* 规则速览已随右栏移除，保留空函数兼容旧调用 */ }
function renderRulePreview() {
  const r = collectRule();
  const pre = $('#ruPreview');
  const tree = $('#ruTree');
  if (pre) {
    const head = [
      `<span class="jt-lit">HTTP/1.1 ${r.status} ${esc(STATUS_TEXT[r.status] || '')}</span>`,
      ...Object.entries(r.headers).map(([k, v]) => `<span class="jt-key">${esc(k)}</span><span class="jt-punct">: </span><span class="jt-plain">${esc(v)}</span>`),
      `<span class="jt-key">content-length</span><span class="jt-punct">: </span><span class="jt-num">${new Blob([r.body]).size}</span>`,
    ].join('\n');
    const bodyHtml = currentBodyIsJson() && JE()
      ? JE().colorize(r.body)
      : esc(r.body);
    pre.innerHTML = `${head}\n\n${bodyHtml}` + (r.body.length > 20000 ? '\n…（已截断预览）' : '');
  }
  if (tree) {
    const html = JE() ? JE().foldHtml(r.body) : '';
    tree.innerHTML = html || '<p class="hint">（响应体不是合法 JSON，无法生成结构树）</p>';
  }
}

function markChips() {
  $$('#ruStatusChips .chip-btn').forEach((b) => b.classList.toggle('on', b.dataset.status === $('#ruStatus').value));
  $$('#ruDelayChips .chip-btn').forEach((b) => b.classList.toggle('on', Number(b.dataset.delay) === (Number($('#ruDelay').value) || 0)));
  const range = $('#ruDelayRange');
  if (range) range.value = Math.min(5000, Number($('#ruDelay').value) || 0);
}

function updateAllRuleUI() {
  updateRuleModeHint();
  updateRuleStatus();
  updateMatchTest();
  updateRuleSummary();
  markChips();
  if (RU.tab === 'preview') renderRulePreview();
}

function applyBodyLang(v) {
  if (RU.body) RU.body.setLanguage(v);
  updateAllRuleUI();
}
function formatRuleBody() {
  if (RU.body && RU.body.format()) toast('已格式化');
  else toast('内容不是合法 JSON，先修正语法');
}
function minifyRuleBody() {
  if (RU.body && RU.body.minify()) toast('已压缩成一行');
  else toast('内容不是合法 JSON，先修正语法');
}
function validateRuleBody() {
  const st = RU.body ? RU.body.validate() : null;
  if (!st) return;
  if (st.ok === false) {
    toast('JSON 有误：' + st.error);
    if (st.line && RU.body) RU.body.revealLine(st.line);
  } else if (st.ok === null) toast('当前是纯文本模式，不校验 JSON');
  else toast('JSON 语法没问题 ✓');
  switchRuleTab('body');
}
function toggleFullscreen(force) {
  const wrap = $('#ruBodyWrap');
  if (!wrap) return;
  const on = force === undefined ? !wrap.classList.contains('fullscreen') : force;
  wrap.classList.toggle('fullscreen', on);
  $('#ruFullscreen').textContent = on ? '⤡ 退出全屏' : '⤢ 全屏';
  if (JE()) setTimeout(() => JE().relayout(), 30);
}

function updateReplayStatus() {
  const text = replayBodyValue();
  const el = $('#rpBodyStatus');
  const size = $('#rpBodySize');
  if (size) size.textContent = fmtSize(new Blob([text]).size);
  if (!el) return;
  if (!text.trim()) el.textContent = '空请求体';
  else {
    const st = RU.replayBody ? RU.replayBody.validate() : { ok: true };
    el.textContent = st.ok === false ? `✕ ${st.error}` : st.ok === null ? '纯文本 · 不校验' : '✓ JSON 有效';
    el.className = st.ok === false ? 'bad' : st.ok === null ? '' : 'ok';
  }
  const state = $('#rpBodyState');
  if (state) {
    const sel = $('#rpBodyLang').value;
    state.textContent = sel === 'auto'
      ? `自动 · ${JE() && JE().looksLikeJSON(text) ? 'JSON' : '文本'}`
      : LANG_LABEL[sel] || sel;
  }
}
function updateJsonIoStatus() {
  const text = RU.ioBody ? RU.ioBody.getValue() : '';
  const el = $('#jsonIoStatus');
  const size = $('#jsonIoSize');
  if (size) size.textContent = fmtSize(new Blob([text]).size);
  if (!el) return;
  try {
    const v = JSON.parse(text);
    const n = Array.isArray(v) ? v.length : Array.isArray(v && v.rules) ? v.rules.length : null;
    el.textContent = n === null ? '✓ JSON 有效，但顶层不是规则数组' : `✓ JSON 有效 · ${n} 条规则`;
    el.className = n === null ? '' : 'ok';
  } catch (err) {
    el.textContent = '✕ ' + err.message;
    el.className = 'bad';
  }
}

/* ---------------------------------------------------- 规则 JSON 导入导出 */

function openJsonIO(mode) {
  mountEditorsOnce();
  RU.ioMode = mode;
  RU.ioArmed = false;
  const exportMode = mode === 'export';
  $('#jsonIoTitle').textContent = exportMode ? '导出规则 JSON' : '导入规则 JSON';
  $('#jsonIoHint').textContent = exportMode
    ? `共 ${S.rules.length} 条规则。可以整段复制、下载成文件，贴到别的机器上一键导入。`
    : '粘贴规则数组（或 { "rules": [...] }）。导入会覆盖现有全部规则，需要点两次确认。';
  const sample = [{
    name: '示例：用户详情', enabled: true, method: 'GET', host: '', urlMatch: '/api/user',
    matchMode: 'contains', status: 200, delayMs: 0,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: '{"code":0,"data":{"id":1}}',
  }];
  const text = exportMode ? JSON.stringify(S.rules, null, 2) : JSON.stringify(sample, null, 2);
  if (RU.ioBody) RU.ioBody.setValue(text);
  $('#jsonIoSource').value = text;
  $('#jsonIoApply').hidden = exportMode;
  $('#jsonIoApply').textContent = '导入并覆盖';
  $('#jsonIoApply').classList.remove('armed');
  $('#jsonIoFoot').textContent = exportMode ? '导出是只读的，不会改动规则' : '示例已填好，改成你的规则再导入';
  updateJsonIoStatus();
  openModal('#modalJsonIO');
  setTimeout(() => JE() && JE().relayout(), 30);
}

async function applyJsonIO() {
  let parsed;
  try {
    parsed = JSON.parse(RU.ioBody ? RU.ioBody.getValue() : $('#jsonIoSource').value);
  } catch (err) {
    toast('JSON 解析失败：' + err.message);
    return;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.rules) ? parsed.rules : null;
  if (!list) {
    toast('顶层需要是规则数组，或 { "rules": [...] }');
    return;
  }
  const btn = $('#jsonIoApply');
  if (!RU.ioArmed) {
    RU.ioArmed = true;
    btn.textContent = `确认覆盖 ${S.rules.length} 条？（导入 ${list.length} 条）`;
    btn.classList.add('armed');
    $('#jsonIoFoot').textContent = '再点一次就会删除现有规则并写入新规则，不可撤销';
    return;
  }
  btn.disabled = true;
  try {
    for (const r of S.rules) await api('/api/rules/' + r.id, { method: 'DELETE' });
    for (const r of list) {
      const { id, createdAt, ...rest } = r || {};
      await api('/api/rules', { method: 'POST', body: rest });
    }
    closeModals();
    await Promise.all([loadRules(), loadStatus()]);
    toast(`已导入 ${list.length} 条规则`);
  } catch (err) {
    toast('导入失败：' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function ioDownload() {
  const text = RU.ioBody ? RU.ioBody.getValue() : $('#jsonIoSource').value;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reqlite-rules-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已下载规则 JSON');
}

function openRuleForm(rule) {
  mountEditorsOnce();
  const r = rule || {};
  S.editingRule = r.id ? r : null;
  $('#ruleTitle').textContent = S.editingRule ? '编辑 Mock 规则' : '新建 Mock 规则';
  $('#ruSubtitle').textContent = S.editingRule
    ? `ID ${String(r.id).slice(0, 8)}… · 规则按顺序匹配，靠前优先`
    : '命中即本地直返，不打上游 · 支持 JSON / 文本 / HTML 任意响应体';
  $('#ruName').value = r.name || '';
  $('#ruNote').value = r.note || '';
  $('#ruEnabled').checked = r.enabled !== false;
  const method = (r.method || '*').toUpperCase();
  $('#ruMethod').value = Array.from($('#ruMethod').options).some((o) => o.value === method) ? method : '*';
  $('#ruMode').value = r.matchMode || 'contains';
  $('#ruMatch').value = r.urlMatch || '';
  $('#ruHost').value = r.host || '';
  $('#ruStatus').value = r.status || 200;
  $('#ruDelay').value = r.delayMs || 0;
  $('#ruHeaders').value = r.headers
    ? typeof r.headers === 'string'
      ? r.headers
      : headersToLines(r.headers)
    : 'content-type: application/json; charset=utf-8';
  renderHeaderRows();
  syncContentTypeFromHeaders();

  const bodyText = typeof r.body === 'string' ? r.body : r.body ? JSON.stringify(r.body, null, 2) : '';
  setRuleBody(bodyText);
  const wanted = r.bodyType || 'auto';
  $('#ruBodyLang').value = Array.from($('#ruBodyLang').options).some((o) => o.value === wanted) ? wanted : 'auto';
  applyBodyLang($('#ruBodyLang').value);

  $('#ruTestUrl').value = /^\//.test(r.urlMatch || '')
    ? `https://${r.host || 'example.com'}${r.urlMatch}`
    : r.urlMatch && /^https?:/.test(r.urlMatch) ? r.urlMatch : '';
  $('#ruTestMethod').value = r.method && r.method !== '*' ? r.method : 'GET';
  $('#ruTestHost').value = r.host || '';
  $('#ruDelete').hidden = !S.editingRule;
  $('#ruSaveCopy').hidden = !S.editingRule;
  $('#ruSave').textContent = S.editingRule ? '保存修改' : '保存并启用';
  $('#ruHint').textContent = r.host ? `只拦截 ${r.host} 的请求` : '';
  renderTemplates();
  setTmplPicker(false);
  switchRuleTab('match');
  updateAllRuleUI();
  openModal('#modalRule');
  setTimeout(() => {
    if (JE()) JE().relayout();
    $('#ruMatch').focus();
  }, 40);
}

async function saveRule(asCopy) {
  const payload = collectRule();
  if (!payload.urlMatch && !payload.host) {
    toast('至少要填 URL 匹配或域名');
    switchRuleTab('match');
    $('#ruMatch').focus();
    return;
  }
  // 纯文本 / HTML 模式允许任意内容；JSON 模式下语法错就拦下来，避免存一条坏规则
  if (currentBodyIsJson() && payload.body.trim()) {
    const st = RU.body ? RU.body.validate() : null;
    if (st && st.ok === false) {
      toast('JSON 有误：' + st.error + '（或把内容类型切成「纯文本」）');
      switchRuleTab('body');
      if (st.line && RU.body) RU.body.revealLine(st.line);
      return;
    }
  }
  if (asCopy) payload.name = (payload.name || '未命名规则') + ' 副本';
  try {
    if (S.editingRule && !asCopy) {
      await api('/api/rules/' + S.editingRule.id, { method: 'PUT', body: payload });
    } else {
      await api('/api/rules', { method: 'POST', body: payload });
    }
    closeModals();
    await Promise.all([loadRules(), loadStatus()]);
    toast(asCopy ? '已另存为副本' : '规则已保存，立即生效');
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

async function loadRules() {
  S.rules = await api('/api/rules');
  $('#ruleCount').textContent = S.rules.length;
  $('#rulesCount').textContent = S.rules.length ? `(${S.rules.length})` : '';
  renderRules();
}

function renderRules() {
  const box = $('#rulesList');
  if (!box) return;
  if (!S.rules.length) {
    box.innerHTML = '<div class="rules-empty">还没有规则。抓一条请求，点「Mock 此请求」最快；或者点右上「+ 新建规则」。</div>';
    return;
  }
  const q = ($('#rulesSearch') ? $('#rulesSearch').value : '').trim().toLowerCase();
  const list = S.rules.filter((r) =>
    !q || [r.name, r.note, r.urlMatch, r.host, r.method, String(r.status), r.body].join(' ').toLowerCase().includes(q)
  );
  if (!list.length) {
    box.innerHTML = `<div class="rules-empty">没有匹配「${esc(q)}」的规则</div>`;
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const idx = S.rules.indexOf(r);
      const preview = String(r.body || '').replace(/\s+/g, ' ').slice(0, 150);
      return `<div class="rule ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
      <div class="rule-top">
        <label class="mini-switch"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''} title="启用 / 停用" /><span></span></label>
        <span class="rule-name">${esc(r.name || '未命名规则')}</span>
        <span class="rule-actions">
          <button class="btn ghost" data-act="up" title="上移（提高优先级）" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost" data-act="down" title="下移" ${idx === S.rules.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn ghost" data-act="dup" title="复制一份">复制</button>
          <button class="btn ghost" data-act="edit">编辑</button>
          <button class="btn ghost" data-act="del">删除</button>
        </span>
      </div>
      <div class="rule-match">#${idx + 1} · ${esc(r.method)} · ${esc(r.matchMode)} · ${esc(r.urlMatch || '(任意)')}${r.host ? ' @ ' + esc(r.host) : ''}</div>
      <div class="rule-tags">
        <span class="rule-tag st">${esc(r.status)} ${esc(STATUS_TEXT[r.status] || '')}</span>
        <span class="rule-tag delay">延迟 ${Number(r.delayMs) || 0}ms</span>
        <span class="rule-tag">${Object.keys(r.headers || {}).length} 个响应头</span>
        <span class="rule-tag">${fmtSize((r.body || '').length)} body</span>
        ${r.note ? `<span class="rule-tag note">${esc(r.note)}</span>` : ''}
        ${r.enabled ? '' : '<span class="rule-tag">已停用</span>'}
      </div>
      ${preview ? `<div class="rule-preview">${esc(preview)}</div>` : ''}
    </div>`;
    })
    .join('');

  box.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = e.target.closest('.rule').dataset.id;
    const rule = S.rules.find((r) => r.id === id);
    const act = btn.dataset.act;
    if (act === 'edit') {
      closeModals();
      openRuleForm(rule);
    } else if (act === 'del') {
      await api('/api/rules/' + id, { method: 'DELETE' });
      await Promise.all([loadRules(), loadStatus()]);
      toast('规则已删除');
    } else if (act === 'dup') {
      const { id: _id, createdAt, ...rest } = rule;
      await api('/api/rules', { method: 'POST', body: { ...rest, name: (rule.name || '未命名规则') + ' 副本' } });
      await Promise.all([loadRules(), loadStatus()]);
      toast('已复制规则');
    } else if (act === 'up' || act === 'down') {
      const ids = S.rules.map((r) => r.id);
      const j = ids.indexOf(id);
      const k = act === 'up' ? j - 1 : j + 1;
      if (k < 0 || k >= ids.length) return;
      [ids[j], ids[k]] = [ids[k], ids[j]];
      await api('/api/rules/reorder', { method: 'POST', body: { ids } });
      await loadRules();
      toast('优先级已调整');
    }
  };
  box.onchange = async (e) => {
    const cb = e.target.closest('[data-toggle]');
    if (!cb) return;
    const id = e.target.closest('.rule').dataset.id;
    await api('/api/rules/' + id, { method: 'PUT', body: { enabled: cb.checked } });
    await loadRules();
  };
}

/* -------------------------------------------------- 本机系统代理接管 */

async function loadLocalProxy() {
  try {
    S.localProxy = await api('/api/system-proxy');
  } catch (err) {
    S.localProxy = {
      supported: false,
      ours: false,
      error: err.message,
      services: [],
      commands: { on: '', off: '' },
    };
  }
  renderLocalProxy();
}

function renderLocalProxy() {
  const st = S.localProxy || {};
  const chip = $('#localChip');
  if (!chip) return;
  chip.hidden = !st.supported;
  chip.textContent = st.ours ? (st.safeMode ? '本机已接管 · 安全模式' : '本机已接管') : '本机未接管';
  chip.className = 'lp-chip ' + (st.ours ? 'on' : 'off');

  const badge = $('#lpBadge');
  badge.textContent = st.error ? '不可用' : st.ours ? '已接管' : st.on ? '被其它代理占用' : '未开启';
  badge.className = 'lp-badge ' + (st.ours ? 'on' : st.error || st.on ? 'off' : '');

  const trust = st.caTrust || (S.status && S.status.caTrust) || null;
  const trustBadge = $('#lpTrustBadge');
  if (trustBadge) {
    trustBadge.hidden = !trust || !trust.supported;
    trustBadge.textContent =
      !trust || !trust.supported ? '' : trust.trusted ? '根证书已信任' : '根证书未信任';
    trustBadge.className = 'lp-badge trust ' + (trust && trust.trusted ? 'on' : 'off');
  }
  const warn = $('#lpCaWarn');
  if (warn) {
    const show = Boolean(trust && trust.supported && trust.trusted === false);
    warn.hidden = !show;
    if (show) {
      $('#lpCaReason').textContent =
        trust.reason + (trust.verifyOutput ? `（${trust.verifyOutput}）` : '');
      $('#lpCaCmd').textContent = (trust.commands && trust.commands.user) || '—';
    }
  }

  $('#lpState').textContent = st.error
    ? st.error
    : [
        `网络服务  : ${st.service || '—'}`,
        `Web 代理  : ${st.web ? (st.web.enabled ? `${st.web.host}:${st.web.port}` : '关') : '—'}`,
        `安全 Web  : ${st.secure ? (st.secure.enabled ? `${st.secure.host}:${st.secure.port}` : '关') : '—'}`,
        `绕过域名  : ${(st.bypass || []).join(', ') || '（无）'}`,
        `根证书    : ${trust ? (trust.trusted ? '已信任，HTTPS 正常解密' : trust.reason) : '—'}`,
        `解密模式  : ${st.safeMode ? '安全模式（本机 HTTPS 透传）' : '正常'}`,
      ].join('\n');

  const sel = $('#lpService');
  sel.innerHTML = (st.services || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if (st.service) sel.value = st.service;

  const btn = $('#lpToggle');
  btn.textContent = st.ours ? '释放本机代理' : '接管本机';
  btn.disabled = !st.supported;
  $('#lpCmdOn').textContent = (st.commands && st.commands.on) || '—';
  $('#lpCmdOff').textContent = (st.commands && st.commands.off) || '—';
}

async function toggleLocalProxy() {
  const btn = $('#lpToggle');
  const enable = !(S.localProxy && S.localProxy.ours);
  const service = $('#lpService').value;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const r = await api('/api/system-proxy', { method: 'POST', body: { enabled: enable, service } });
    if (!r.ok) throw new Error(r.error || '操作失败');
    await loadLocalProxy();
    if (!enable) toast('已释放本机系统代理，原始配置已恢复');
    else if (r.safeMode)
      toast('已接管本机；根证书未信任，本机 HTTPS 已自动透传（不会报证书错误，但看不到明文），见设置里的信任命令');
    else toast('已接管本机系统代理，刷新一下浏览器页面就能看到请求了');
  } catch (err) {
    toast('操作失败: ' + err.message + '（可复制下面的命令到终端手动执行）');
    await loadLocalProxy();
  } finally {
    btn.disabled = !(S.localProxy && S.localProxy.supported);
  }
}

async function copyTrustCmd() {
  const t = (S.localProxy && S.localProxy.caTrust) || (S.status && S.status.caTrust) || null;
  const text = t && t.commands && t.commands.user;
  if (!text) return toast('当前平台没有可用的自动命令');
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制：粘贴到终端执行，再回来点「重新检测」');
  } catch (_) {
    toast('复制失败，请手动选中上面的命令');
  }
}

async function recheckTrust() {
  const btn = $('#lpRecheckTrust');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检测中…';
  }
  try {
    const t = await api('/api/ca-trust', { method: 'POST', body: { action: 'check' } });
    S.localProxy = { ...(S.localProxy || {}), caTrust: t, safeMode: t.safeMode };
    S.status = { ...(S.status || {}), caTrust: t, safeMode: t.safeMode };
    renderLocalProxy();
    toast(
      t.trusted
        ? '根证书已信任，HTTPS 解密已恢复，刷新页面即可看到内容'
        : '仍未检测到信任：' + t.reason
    );
  } catch (err) {
    toast('检测失败: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重新检测';
    }
  }
}

async function copyLocalCmd(which) {
  const text = ((S.localProxy || {}).commands || {})[which] || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('命令已复制，粘贴到终端执行');
  } catch (_) {
    toast('复制失败，请手动选中下面的命令');
  }
}

/* ---------------------------------------------------------------- 设置 */

async function openSettings() {
  const st = await loadStatus();
  // 更新卡片：打开设置时拿最新状态（自动检查可能刚在后台跑完）
  try {
    renderUpdate(await api('/api/update'));
  } catch {
    renderUpdate(st.update);
  }
  $('#stPassthrough').value = (st.passthrough || []).join('\n');
  $('#stMitmPorts').value = (st.mitmPorts || [443]).join(', ');
  $('#stUaAppMap').value = (st.uaAppMap || []).map((a) => `${a.match}=${a.name}`).join('\n');
  const pm = st.processMap || {};
  $('#appIdBadge').textContent = pm.enabled ? '本机进程识别已启用' : pm.supported ? '已关闭，仅 UA 推断' : '仅 UA 推断';
  const ps = pm.stats || {};
  $('#stProcessMap').checked = pm.enabled !== false;
  $('#appIdStat').textContent = pm.supported
    ? `lsof 快照 ${ps.refreshes || 0} 次 · 解析到 ${ps.resolved || 0} 个连接 · 未命中 ${ps.missed || 0}`
    : '当前系统不提供本机进程关联（仅 macOS 支持），远程设备请用上方 UA 别名标注。';
  loadDiagnostics();
  loadLocalProxy();
  $('#stMax').value = st.store ? st.store.maxFlows : 2000;
  const infoAddr = currentAddr();
  $('#stInfo').textContent = [
    `代理地址    : ${addrFull(infoAddr)}（${infoAddr.label}）`,
    `代理端口    : ${st.proxyPort}`,
    `控制台端口  : ${st.uiPort}`,
    `已记录      : ${st.store ? st.store.total : 0} 条`,
    `累计转发    : ${st.stats ? st.stats.total : 0} 次（Mock ${st.stats ? st.stats.mocked : 0} / 失败 ${st.stats ? st.stats.errors : 0}）`,
    `根证书      : ${st.caPath || '—'}`,
    `版本        : iReq ${st.version || ''}`,
  ].join('\n');
  applyAddr();
  openModal('#modalSettings');
}

async function loadDiagnostics() {
  try {
    const d = await api('/api/diagnostics');
    const wrap = $('#stDiagWrap');
    const box = $('#stDiag');
    if (!wrap || !box) return;
    // 只展示"反复失败"的域名：单次失败多半是预连接被中断，不是真问题
    const list = (d.tlsFailures || []).filter((f) => f.count >= 2);
    wrap.hidden = list.length === 0;
    box.innerHTML = list
      .map(
        (f) => `<div class="diag-item">
          <span class="mono">${esc(f.host)}</span>
          <span class="hint">${f.count} 次握手失败</span>
          <button class="btn ghost" data-block-host="${esc(f.host)}">加入跳过解密</button>
        </div>`
      )
      .join('');
  } catch (_) {
    /* 诊断不可用就算了 */
  }
}

async function saveSettings() {
  const passthrough = $('#stPassthrough')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const mitmPorts = $('#stMitmPorts')
    .value.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  try {
    await api('/api/config', {
      method: 'PUT',
      body: {
        passthrough,
        mitmPorts,
        maxFlows: Number($('#stMax').value) || 2000,
        uaAppMapText: $('#stUaAppMap').value,
        processMap: $('#stProcessMap').checked,
      },
    });
    closeModals();
    toast('设置已保存');
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

/* ---------------------------------------------------------------- 事件 */

function bind() {
  // 顶栏代理地址：IP / 端口分开复制，⧉ 复制完整，▾ 切换多网卡 / 本机回环
  $('#addrIp').addEventListener('click', () => copyAddr('ip'));
  $('#addrPort').addEventListener('click', () => copyAddr('port'));
  $('#addrCopyAll').addEventListener('click', () => copyAddr('all'));
  $('#stCopyIp').addEventListener('click', () => copyAddr('ip'));
  $('#stCopyPort').addEventListener('click', () => copyAddr('port'));
  $('#stCopyAll').addEventListener('click', () => copyAddr('all'));
  $('#addrPick').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddrMenu();
  });
  $('#addrMenu').addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      copyAddr(cp.dataset.copy);
      toggleAddrMenu(false);
      return;
    }
    const btn = e.target.closest('[data-addr]');
    if (!btn) return;
    try {
      localStorage.setItem(ADDR_KEY, btn.dataset.addr);
    } catch (_) {
      /* 隐私模式下不持久化，本次会话内仍生效需另存内存 —— 直接同步到状态 */
      S.status = { ...S.status, _addrPicked: btn.dataset.addr };
    }
    toggleAddrMenu(false);
    applyAddr();
    if (S.flows.length === 0) renderList();
    toast('已切换代理地址为 ' + btn.dataset.addr);
  });
  document.addEventListener('click', (e) => {
    const wrap = $('#addrWrap');
    if (wrap && !wrap.contains(e.target)) toggleAddrMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleAddrMenu(false);
  });

  $('#list').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) selectFlow(row.dataset.id);
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    S.filter.q = e.target.value.trim();
    renderChips();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadFlows, 220);
  });

  // 分组边栏
  $('#sideBody').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-bookmark]');
    if (del) {
      e.stopPropagation();
      await api('/api/bookmarks/' + del.dataset.delBookmark, { method: 'DELETE' });
      await loadBookmarks();
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (S.closedGroups.has(key)) S.closedGroups.delete(key);
      else S.closedGroups.add(key);
      localStorage.setItem('reqlite-side-closed', JSON.stringify([...S.closedGroups]));
      const group = toggle.closest('.sgroup');
      if (group) group.classList.toggle('closed');
      return;
    }
    const rt = e.target.closest('[data-rtoggle]');
    if (rt) {
      const key = rt.dataset.rtoggle;
      if (S.routeToggled.has(key)) S.routeToggled.delete(key);
      else S.routeToggled.add(key);
      localStorage.setItem('reqlite-route-toggled', JSON.stringify([...S.routeToggled]));
      renderSide();
      return;
    }
    if (e.target.closest('[data-save-bookmark]')) {
      await saveCurrentFilter();
      return;
    }
    const bookmark = e.target.closest('[data-bookmark]');
    if (bookmark) {
      const item = S.bookmarks.find((b) => b.id === bookmark.dataset.bookmark);
      if (!item) return;
      for (const key of ['ip', 'app', 'host', 'route', 'q']) delete S.filter[key];
      Object.assign(S.filter, item.filter);
      if (S.filter.q) {
        const input = $('#search');
        if (input) input.value = S.filter.q;
      }
      syncFilters();
      toast('已应用书签：' + item.label);
      return;
    }
    const facet = e.target.closest('[data-facet]');
    if (facet) setFacet(facet.dataset.facet, facet.dataset.value);
  });

  $('#chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear]');
    if (btn) clearFacet(btn.dataset.clear);
  });

  $('#sideHide').addEventListener('click', () => setSideVisible(false));
  $('#sideShow').addEventListener('click', () => setSideVisible(true));
  $('#sideBackdrop').addEventListener('click', () => setSideVisible(false));
  bindSplitter('side');
  bindSplitter('list');

  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('#filters button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    S.filter.status = btn.dataset.status || '';
    S.filter.mocked = btn.dataset.mocked === '1';
    loadFlows();
  });

  $('#capture').addEventListener('change', async (e) => {
    await api('/api/config', { method: 'PUT', body: { capture: e.target.checked } });
    toast(e.target.checked ? '已开始抓包' : '已暂停抓包（代理仍在运行）');
  });

  $('#btnClear').addEventListener('click', async () => {
    await api('/api/flows', { method: 'DELETE' });
    S.selectedId = null;
    S.selected = null;
    $('#detail').innerHTML = detailEmptyHtml;
    S.flows = [];
    renderList();
    toast('已清空');
  });

  $('#btnRules').addEventListener('click', async () => {
    await loadRules();
    openModal('#modalRules');
  });
  $('#ruNew').addEventListener('click', () => {
    closeModals();
    openRuleForm({});
  });
  $('#ruSave').addEventListener('click', () => saveRule(false));
  $('#btnCa').addEventListener('click', async () => {
    const st = await loadStatus();
    const a = currentAddr();
    $('#caMobileProxy').textContent = addrFull(a);
    // 用安装页而不是直接甩 .pem：页面里有下载按钮 + 分平台步骤，手机上好操作
    $('#caUrl').textContent = `http://${addrFull(a)}/`;
    $('#caLocalPath').textContent = st.caPath || 'data/ca/reqlite-ca.pem';
    let userCmd = '';
    try {
      userCmd = ((await api('/api/ca-trust')).commands || {}).user || '';
    } catch (_) {
      /* 老版本服务端没有这个 API，用兜底命令 */
    }
    const p = st.caPath || 'data/ca/reqlite-ca.pem';
    $('#caCmdMac').textContent =
      '# 推荐：用户域信任，通常免 sudo，一次完成安装 + 始终信任\n' +
      (userCmd ||
        `security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "${p}"`) +
      '\n\n# 备用：系统域，需要 sudo\n' +
      `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${p}"` +
      '\n\n# 注意：别加 -p ssl，那会变成「仅 SSL 策略」的受限信任，浏览器仍不认';
    openModal('#modalCa');
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#updAuto').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoUpdate: on }) });
      renderUpdate({ ...(S.update || {}), enabled: on });
      toast(on ? '已开启自动检查更新' : '已关闭自动检查更新');
    } catch (err) {
      toast('保存失败: ' + err.message);
      e.target.checked = !on;
    }
  });
  $('#updCheckNow').addEventListener('click', async () => {
    const btn = $('#updCheckNow');
    btn.disabled = true;
    renderUpdate({ ...(S.update || {}), checking: true });
    try {
      renderUpdate(await api('/api/update/check', { method: 'POST' }));
      if (S.update && S.update.hasUpdate) toast(`发现新版本 v${S.update.latest.version}`);
      else toast('已是最新版本');
    } catch (err) {
      toast('检查失败: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('#localChip').addEventListener('click', openSettings);
  $('#lpToggle').addEventListener('click', toggleLocalProxy);
  $('#lpCopyOn').addEventListener('click', () => copyLocalCmd('on'));
  $('#lpCopyOff').addEventListener('click', () => copyLocalCmd('off'));
  $('#lpCopyTrust').addEventListener('click', copyTrustCmd);
  $('#lpRecheckTrust').addEventListener('click', recheckTrust);
  $('#stSave').addEventListener('click', saveSettings);
  $('#modalSettings').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-block-host]');
    if (!btn) return;
    const host = btn.dataset.blockHost;
    const lines = $('#stPassthrough')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.includes(host)) lines.push(host);
    $('#stPassthrough').value = lines.join('\n');
    await saveSettings();
    toast(`已让 ${host} 走透传，重新打开 App 试试`);
    loadDiagnostics();
  });
  $('#rpSend').addEventListener('click', sendReplay);

  /* ------------------------------------------- 富版规则编辑器 / JSON 工具条 */

  const syncHeaderRowsToText = () => {
    const rows = $$('.re-hdr-row', $('#ruHeaderRows')).map((row) => ({
      k: row.querySelector('[data-hk]') ? row.querySelector('[data-hk]').value : '',
      v: row.querySelector('[data-hv]') ? row.querySelector('[data-hv]').value : '',
    }));
    $('#ruHeaders').value = rows.filter((r) => r.k.trim()).map((r) => `${r.k.trim()}: ${r.v}`).join('\n');
    syncContentTypeFromHeaders();
    updateAllRuleUI();
  };

  $('#ruTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rutab]');
    if (b) switchRuleTab(b.dataset.rutab);
  });
  $('#ruSaveCopy').addEventListener('click', () => saveRule(true));
  $('#ruDelete').addEventListener('click', async () => {
    if (!S.editingRule) return;
    await api('/api/rules/' + S.editingRule.id, { method: 'DELETE' });
    closeModals();
    await Promise.all([loadRules(), loadStatus()]);
    toast('规则已删除');
  });

  for (const sel of ['#ruName', '#ruNote', '#ruMethod', '#ruMode', '#ruMatch', '#ruHost', '#ruStatus', '#ruDelay', '#ruTestUrl', '#ruTestHost', '#ruTestMethod']) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('input', updateAllRuleUI);
    el.addEventListener('change', updateAllRuleUI);
  }
  $('#ruDelayRange').addEventListener('input', (e) => {
    $('#ruDelay').value = e.target.value;
    updateAllRuleUI();
  });
  $('#ruStatusChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    $('#ruStatus').value = b.dataset.status;
    updateAllRuleUI();
  });
  $('#ruDelayChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-delay]');
    if (!b) return;
    $('#ruDelay').value = b.dataset.delay;
    updateAllRuleUI();
  });
  $$('[data-match-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.matchPreset;
      const m = $('#ruMatch');
      if (p === 'clear') m.value = '';
      else if (p === 'wildcard') {
        $('#ruMode').value = 'wildcard';
        m.value = m.value ? m.value.replace(/\*+$/, '') + '*' : '*';
      } else if (p === 'regex-id') {
        $('#ruMode').value = 'regex';
        m.value = '^.*/\\d+(?:\\?.*)?$';
      } else {
        $('#ruMode').value = 'regex';
        m.value = '.*';
      }
      updateAllRuleUI();
    })
  );

  $('#ruContentType').addEventListener('change', (e) => setContentType(e.target.value));
  $('#ruCors').addEventListener('click', addCors);
  $('#ruAddHeader').addEventListener('click', () => {
    const box = $('#ruHeaderRows');
    if (box.querySelector('.rules-empty, .hint')) box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 're-hdr-row';
    row.innerHTML = '<input class="input mono" data-hk="" placeholder="Header" value="" spellcheck="false" /><input class="input mono" data-hv="" placeholder="Value" value="" spellcheck="false" /><button type="button" class="re-hdr-del" data-hdel="" title="删除这一行">✕</button>';
    box.appendChild(row);
    row.querySelector('[data-hk]').focus();
  });
  $('#ruHeaderRows').addEventListener('input', syncHeaderRowsToText);
  $('#ruHeaderRows').addEventListener('click', (e) => {
    if (!e.target.closest('[data-hdel]')) return;
    const row = e.target.closest('.re-hdr-row');
    if (row) row.remove();
    syncHeaderRowsToText();
  });
  $('#ruHeaders').addEventListener('input', () => {
    renderHeaderRows();
    syncContentTypeFromHeaders();
    updateAllRuleUI();
  });

  $('#ruBodyLang').addEventListener('change', (e) => applyBodyLang(e.target.value));
  $('#ruFormat').addEventListener('click', formatRuleBody);
  $('#ruMinify').addEventListener('click', minifyRuleBody);
  $('#ruValidate').addEventListener('click', validateRuleBody);
  $('#ruCopyBody').addEventListener('click', () => copyText(ruleBodyValue(), '响应体已复制'));
  $('#ruClearBody').addEventListener('click', () => { setRuleBody(''); toast('响应体已清空'); });
  $('#ruImportBody').addEventListener('click', () =>
    pickFile((text) => { setRuleBody(text); toast('已导入文件内容'); })
  );
  $('#ruFullscreen').addEventListener('click', () => toggleFullscreen());
  $('#ruTreeExpand').addEventListener('click', () => $$('#ruTree details').forEach((d) => (d.open = true)));
  $('#ruTreeCollapse').addEventListener('click', () => $$('#ruTree details').forEach((d) => (d.open = false)));
  $('#modalRule').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tmpl]');
    if (t) { applyTemplate(Number(t.dataset.tmpl)); return; }
    const del = e.target.closest('[data-tmpl-del]');
    if (del) {
      const list = loadTemplates();
      const gone = list.splice(Number(del.dataset.tmplDel), 1)[0];
      saveTemplates(list);
      if (gone) toast(`已删除模板「${gone.name}」`);
    }
  });
  $('#ruSaveTmpl').addEventListener('click', startSaveTemplate);
  $('#ruTmplPick').addEventListener('click', () => setTmplPicker($('#ruTmplPicker').hidden));
  $('#ruTmplOk').addEventListener('click', confirmSaveTemplate);
  $('#ruTmplCancel').addEventListener('click', () => setTmplPicker(false));
  $('#ruTmplName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveTemplate();
    if (e.key === 'Escape') setTmplPicker(false);
  });
  document.addEventListener('click', (e) => {
    const p = $('#ruTmplPicker');
    if (!p || p.hidden) return;
    if (e.target.closest('#ruTmplPicker') || e.target.closest('#ruTmplPick') || e.target.closest('#ruSaveTmpl')) return;
    setTmplPicker(false);
  });

  $('#rulesSearch').addEventListener('input', renderRules);
  $('#rulesImport').addEventListener('click', () => openJsonIO('import'));
  $('#rulesExport').addEventListener('click', () => openJsonIO('export'));
  $('#ioFormat').addEventListener('click', () => { if (RU.ioBody && RU.ioBody.format()) toast('已格式化'); });
  $('#ioCopy').addEventListener('click', () => copyText(RU.ioBody ? RU.ioBody.getValue() : $('#jsonIoSource').value, '规则 JSON 已复制'));
  $('#ioDownload').addEventListener('click', ioDownload);
  $('#ioPickFile').addEventListener('click', () => pickFile((text) => { if (RU.ioBody) RU.ioBody.setValue(text); toast('已从文件读取'); }));
  $('#jsonIoApply').addEventListener('click', applyJsonIO);

  $('#rpBodyLang').addEventListener('change', (e) => {
    if (RU.replayBody) RU.replayBody.setLanguage(e.target.value);
    updateReplayStatus();
  });
  $('#rpFormat').addEventListener('click', () => { if (RU.replayBody && RU.replayBody.format()) toast('已格式化'); else toast('内容不是合法 JSON'); });
  $('#rpMinify').addEventListener('click', () => { if (RU.replayBody && RU.replayBody.minify()) toast('已压缩'); else toast('内容不是合法 JSON'); });
  $('#rpCopyBody').addEventListener('click', () => copyText(replayBodyValue(), '请求体已复制'));

  // 详情里的「结构化 / 原始 / 展开折叠 / 全屏 / 复制」：#detail 常驻，委托一次即可
  $('#detail').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-body-mode]');
    if (mode) {
      const kind = mode.dataset.bodyKind;
      const prev = S.bodyView[kind] || {};
      S.bodyView[kind] = { mode: mode.dataset.bodyMode, fs: !!prev.fs };
      renderDetail();
      return;
    }
    const fold = e.target.closest('[data-body-fold]');
    if (fold) {
      const open = fold.dataset.bodyFold === '1';
      $$('#detail .json-fold details').forEach((d) => (d.open = open));
      return;
    }
    const fsBtn = e.target.closest('[data-body-fs]');
    if (fsBtn) {
      const kind = fsBtn.dataset.bodyFs;
      const prev = S.bodyView[kind] || {};
      S.bodyView[kind] = { mode: prev.mode || 'pretty', fs: !prev.fs };
      renderDetail();
      return;
    }
    // 头区行：点击复制 name: value
    const hdRow = e.target.closest('[data-hd-row]');
    if (hdRow && S.selected) {
      const [side, idx] = hdRow.dataset.hdRow.split(':');
      const headers = side === 'req' ? S.selected.reqHeaders : S.selected.resHeaders;
      const entry = Object.entries(headers || {})[Number(idx)];
      if (entry) copyText(`${entry[0]}: ${Array.isArray(entry[1]) ? entry[1].join('\n') : entry[1]}`, `已复制 ${entry[0]}`);
      return;
    }
    // 头区工具条：复制全部（每行 name: value）/ 复制为 JSON
    const hdCopy = e.target.closest('[data-hd-copy]');
    if (hdCopy && S.selected) {
      const headers = hdCopy.dataset.hdCopy === 'req' ? S.selected.reqHeaders : S.selected.resHeaders;
      const text = Object.entries(headers || {})
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('\n') : v}`)
        .join('\n');
      copyText(text, `已复制 ${Object.keys(headers || {}).length} 个头`);
      return;
    }
    const hdJson = e.target.closest('[data-hd-json]');
    if (hdJson && S.selected) {
      const headers = hdJson.dataset.hdJson === 'req' ? S.selected.reqHeaders : S.selected.resHeaders;
      copyText(JSON.stringify(headers || {}, null, 2), 'Headers JSON 已复制');
      return;
    }
    // 原文页签：整段复制 / 仅状态行和头
    const rawCopy = e.target.closest('[data-raw-copy], [data-raw-copy-heads]');
    if (rawCopy && S.selected) {
      const side = rawCopy.dataset.rawCopy || rawCopy.dataset.rawCopyHeads;
      const headsOnly = !!rawCopy.dataset.rawCopyHeads;
      const lines = rawTextOf(S.selected, side);
      // body 前有一个空行分隔，headsOnly 只取到空行之前
      const cut = headsOnly ? lines.findIndex((l) => l === '') : -1;
      copyText((cut >= 0 ? lines.slice(0, cut) : lines).join('\n'), headsOnly ? '状态行和头已复制' : '报文已复制');
      return;
    }
    // 原文行：点击复制该行
    const rawLine = e.target.closest('[data-raw-line]');
    if (rawLine && S.selected) {
      const [side, idx] = rawLine.dataset.rawLine.split(':');
      const line = rawTextOf(S.selected, side)[Number(idx)];
      if (line !== undefined && line !== '') copyText(line, '该行已复制');
      return;
    }
    const cp = e.target.closest('[data-body-copy]');
    if (!cp || !S.selected) return;
    const kind = cp.dataset.bodyCopy;
    const f = S.selected;
    const view = (S.bodyView[kind] || {}).mode;
    if (view === 'base64' || view === 'hex' || view === 'preview') {
      const bin = binInfoOf(f, kind);
      if (bin) copyText(bin.base64, 'Base64 已复制（完整）');
      return;
    }
    const raw = kind === 'request' ? f.reqBody || '' : f.resBody || '';
    const ct = kind === 'request' ? (f.reqHeaders || {})['content-type'] : f.resContentType;
    copyText(view === 'raw' ? raw : pretty(raw, ct), '内容已复制');
  });

  // ⌘⇧F / Ctrl+Shift+F 格式化响应体；全屏时 Esc 先退出全屏
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f' && !$('#modalRule').hidden) {
      e.preventDefault();
      formatRuleBody();
    } else if (e.key === 'Escape' && $('#ruBodyWrap').classList.contains('fullscreen')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleFullscreen(false);
    } else if (e.key === 'Escape' && Object.values(S.bodyView).some((v) => v && v.fs)) {
      // 详情 body 全屏：Esc 退出
      e.preventDefault();
      e.stopImmediatePropagation();
      for (const k of Object.keys(S.bodyView)) if (S.bodyView[k]) S.bodyView[k].fs = false;
      renderDetail();
    }
  });

  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) {
        // 导入/导出是从规则列表上叠出来的，关它要回到规则列表；
        // 其它弹窗都是先 closeModals 再打开的单层弹窗，保持全关语义。
        if (m.id === 'modalJsonIO') m.hidden = true;
        else closeModals();
      }
    });
  });

  $('#btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('reqlite-theme', next);
    if (window.ReqLiteJSON) window.ReqLiteJSON.setTheme(next);
  });

  $('#fontUp').addEventListener('click', () => applyScale(currentScale() + SCALE_STEP));
  $('#fontDown').addEventListener('click', () => applyScale(currentScale() - SCALE_STEP));
  $('#fontVal').addEventListener('click', () => {
    applyScale(1);
    toast('字号已恢复 100%');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#search').focus();
      $('#search').select();
    } else if (e.key === 'Escape') {
      closeModals();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (document.activeElement === $('#search')) return;
      const idx = S.flows.findIndex((f) => f.id === S.selectedId);
      const next =
        e.key === 'ArrowDown'
          ? Math.min(S.flows.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      if (S.flows[next]) {
        e.preventDefault();
        selectFlow(S.flows[next].id);
        const row = $(`.row[data-id="${S.flows[next].id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  // 实时流
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'flow') {
      const f = msg.flow;
      const m = {
        id: f.id,
        ts: f.ts,
        method: f.method,
        url: f.url,
        host: f.host,
        path: f.path,
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
        clientIp: f.clientIp,
        deviceKey: f.deviceKey,
        deviceLabel: f.deviceLabel,
        app: f.app,
        appSource: f.appSource,
        process: f.process || null,
        platform: f.platform,
        route: f.route,
      };
      const ipFilter = S.filter.ip;
      // 实时流也要遵守侧栏筛选：以前只判断状态 / Mock / 搜索，
      // 选中「本机」后远程设备新来的请求照样插进列表，看起来像筛选失效。
      const devMatch =
        !ipFilter ||
        (ipFilter === LOCAL_DEVICE_KEY
          ? m.deviceKey === LOCAL_DEVICE_KEY || isLocalClientIpUi(m.clientIp)
          : m.clientIp === ipFilter);
      const hay = `${m.method} ${m.url} ${m.status} ${m.app || ''} ${m.clientIp || ''} ${
        m.deviceLabel || ''
      } ${(m.process && `${m.process.name} ${m.process.command} ${m.process.pid}`) || ''}`.toLowerCase();
      const match =
        (!S.filter.status || (S.filter.status === 'error' ? m.error || m.status >= 400 : S.filter.status === 'json' ? /json/i.test(m.resContentType || '') : true)) &&
        (!S.filter.mocked || m.mocked) &&
        (!S.filter.host || m.host === S.filter.host) &&
        (!S.filter.app || m.app === S.filter.app) &&
        (!S.filter.route || m.route === S.filter.route) &&
        devMatch &&
        (!S.filter.q || hay.includes(S.filter.q.toLowerCase()));
      if (match) {
        S.flows.unshift(m);
        if (S.flows.length > 800) S.flows.pop();
        scheduleRender();
        scheduleFacets();
      }
    } else if (msg.type === 'flow-update') {
      // 本机进程名是 lsof 异步查到的，比记录本身晚一点到：就地更新列表 / 详情 / 侧栏
      const f = msg.flow;
      const row = S.flows.find((x) => x.id === f.id);
      if (row) {
        row.app = f.app;
        row.appSource = f.appSource;
        row.process = f.process;
        if (f.deviceKey) row.deviceKey = f.deviceKey;
        if (f.deviceLabel) row.deviceLabel = f.deviceLabel;
        scheduleRender();
      }
      if (S.selectedId === f.id && S.selected) {
        S.selected.app = f.app;
        S.selected.appSource = f.appSource;
        S.selected.process = f.process;
        if (f.deviceKey) S.selected.deviceKey = f.deviceKey;
        if (f.deviceLabel) S.selected.deviceLabel = f.deviceLabel;
        renderDetail();
      }
      scheduleFacets();
    } else if (msg.type === 'clear') {
      S.flows = [];
      renderList();
      scheduleFacets();
    }
  };
  es.onerror = () => {
    $('#dot').className = 'dot off';
    $('#connText').textContent = '重连中…';
  };
  es.onopen = () => {
    $('#dot').className = 'dot on';
    $('#connText').textContent = '监听中';
  };
}

async function init() {
  detailEmptyHtml = $('#detail').innerHTML;
  const savedTheme = localStorage.getItem('reqlite-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  applyScale(Number(localStorage.getItem(SCALE_KEY)) || 1, false);
  ICONS().mount();
  if (window.ReqLiteJSON) {
    window.ReqLiteJSON.setTheme(savedTheme === 'dark' ? 'dark' : 'light');
    mountEditorsOnce();
    // 本地 4.6MB，预热一下，打开规则弹窗时不用等
    window.ReqLiteJSON.ready().catch(() => {});
  }
  syncSideForViewport();
  applyPaneWidths();
  bind();
  await loadStatus();
  loadLocalProxy(); // 只读探测，不阻塞首屏
  await loadFlows();
  await loadRules();
  await Promise.all([loadFacets(), loadBookmarks()]);
  renderChips();
  NARROW.addEventListener('change', () => {
    syncSideForViewport();
    applyPaneWidths();
  });
  window.addEventListener('resize', applyPaneWidths);
  setInterval(loadStatus, 5000);
}

init();
