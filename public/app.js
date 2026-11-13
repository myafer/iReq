'use strict';

/* iReq 控制台 —— 无框架，原生 DOM */

const S = {
  flows: [],
  /* 握手失败的域名（按 host 聚合）：直接出现在主列表，不再藏在设置页 */
  tlsFailures: [],
  /* 跳过解密白名单（服务端持久化）：规则 + 来源 + 透传命中数 */
  passthrough: [],
  ptTotalHits: 0,
  ptSearch: '',
  ptEditing: '',
  ptHighlight: '',
  ptLastKilled: 0,
  selectedId: null,
  selected: null,
  detailTab: 'overview',
  filter: { q: '', status: '', mocked: false, host: '', ip: '', app: [], route: '' },
  rules: [],
  rulesDir: localStorage.getItem('reqlite-rule-dir') || '', /* 文件树当前选中的目录（'' = 根），跨开关保留 */
  rulesTreeOpen: new Set(JSON.parse(localStorage.getItem('reqlite-rule-dirs') || '[]')),
  rulesTreeError: '',
  rulesActivePath: '', /* 当前打开的规则在树里的路径 */
  /* 行内命名：桌面端没有 window.prompt（Electron 不支持），新建/改名一律在树里就地输入
   * treeRenaming = { path, value }，treeDraft = { dir, type:'dir'|'rule', value } */
  treeRenaming: null,
  treeDraft: null,
  /* 文件树剪贴板：{ mode:'copy'|'cut', path }，粘贴时按 mode 走复制或移动 */
  rulesClip: null,
  ruleFromTree: false, /* 编辑器是否从规则工作区打开（关闭时回到工作区） */
  /* MCP 接入面板：/api/mcp 的视图（含令牌列表与最近审计，绝不含凭据） */
  mcp: null,
  mcpSnippet: '',
  /* VSCode 式多标签编辑区：{ key, id, name, dir, data, pane, dirty, fromWorkspace } */
  ruleTabs: [],
  activeRuleTab: null,
  ruleTabSeq: 0,
  loadingRuleTab: false, /* 载入标签时抑制「未保存」标记 */
  showRuleBody: localStorage.getItem('reqlite-rule-show-body') === '1',
  status: {},
  /* 网络模拟规则（会话级，服务端不落盘） */
  networkSim: { enabled: true, latencyMs: 800, kbps: 64, timeoutMs: 30000, rules: [] },
  /* Mock 总开关（会话级）：false 时所有规则整体旁路 */
  mockEnabled: true,
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
const SCALE_MIGRATED = 'reqlite-scale-v2'; // 旧基准(1.3)→新基准(1.04)的一次性迁移标记
/* 缩放基准：CSS 变量 1.04 对应界面显示的 100%（= 旧版默认 1.3 的 80%） */
const SCALE_BASE = 1.04;
const SCALE_MIN = 0.73; // ≈70%
const SCALE_MAX = 1.56; // 150%
const SCALE_STEP = 0.05;

function currentScale() {
  const v = Number(document.documentElement.style.getPropertyValue('--ui-scale'));
  return Number.isFinite(v) && v > 0 ? v : SCALE_BASE;
}

function applyScale(value, persist = true) {
  const raw = Math.round(Number(value) * 100) / 100;
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(raw) ? raw : 1));
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  const label = Math.round((scale / SCALE_BASE) * 100) + '%';
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
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
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
    S.mockEnabled = st.mockEnabled !== false;
    S.networkSim = normalizeNetSim(st.networkSim);
    syncNetBadge();
    applyAddr();
    renderDock();
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
    else text.textContent = '自动检查 GitHub Releases';
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
  for (const key of ['host', 'ip', 'route']) {
    if (S.filter[key]) params.set(key, S.filter[key]);
  }
  // 应用是多选（侧栏勾选），逗号分隔传给服务端
  if (S.filter.app.length) params.set('app', S.filter.app.join(','));
  const list = await api('/api/flows?' + params.toString());
  S.flows = list;
  renderList();
  if (S.selectedId && !list.some((f) => f.id === S.selectedId)) {
    // 过滤后不在这批里，保留详情但不高亮
    $$('.row').forEach((r) => r.classList.remove('sel'));
  }
}

/* 列表渲染：结构性变化（筛选/搜索/清空）整表重绘；SSE 来的新记录/补丁只动对应行。
 * 以前每条流量都 innerHTML 整表 800 行，高频抓包会掉帧、滚动位置和 hover 状态一起抖。 */
let renderPending = false;
let renderFullQueued = false;
const pendingAdds = [];
const pendingPatches = [];

function queueRenderFrame() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (renderFullQueued) {
      renderFullQueued = false;
      pendingAdds.length = 0;
      pendingPatches.length = 0;
      renderList();
    } else {
      applyFlowDelta();
    }
  });
}

function scheduleRender() {
  renderFullQueued = true;
  pendingAdds.length = 0;
  pendingPatches.length = 0;
  queueRenderFrame();
}

function scheduleFlowAdd(flow) {
  if (renderFullQueued) return; // 本帧会整表重绘，S.flows 里已经包含它
  pendingAdds.push(flow);
  queueRenderFrame();
}

function scheduleFlowPatch(flow) {
  if (renderFullQueued) return;
  pendingPatches.push(flow);
  queueRenderFrame();
}

function applyFlowDelta() {
  const list = $('#list');
  const adds = pendingAdds.splice(0);
  const patches = pendingPatches.splice(0);
  if (!adds.length && !patches.length) return;
  const prevTop = list.scrollTop;
  const prevHeight = list.scrollHeight;

  if (adds.length) {
    // 到达顺序是旧→新，逐个 prepend 后正好和 S.flows（新→旧）对齐。
    // 顶部若有握手失败诊断行，要插在它们后面，别把诊断行挤下去。
    let html = '';
    for (const f of adds) html = rowHtml(f) + html;
    const tlsRows = $$('.row.tls', list);
    const anchor = tlsRows.length ? tlsRows[tlsRows.length - 1] : null;
    if (anchor) anchor.insertAdjacentHTML('afterend', html);
    else list.insertAdjacentHTML('afterbegin', html);
    const extra = list.children.length - 800;
    for (let i = 0; i < extra; i++) list.lastElementChild.remove();
  }
  for (const f of patches) {
    const row = list.querySelector(`.row[data-id="${f.id}"]`);
    if (!row) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = rowHtml(f);
    const next = tmp.firstElementChild;
    if (!next) continue;
    if (row.classList.contains('sel')) next.classList.add('sel');
    row.replaceWith(next);
  }
  $('#count').textContent = `${list.children.length} 条`;
  $('#listEmpty').hidden = list.children.length > 0;
  // 顶部插入会把旧内容往下推：不在顶部时补偿高度，视觉上不跳
  if (prevTop > 0) list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
}

/** 筛选条单选判断：与服务端 store.filter 的 status 语义保持一致（新增协议/内容/状态码分组） */
function matchStatusUi(f, status) {
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
      return true;
  }
}

function renderList() {
  const list = $('#list');
  const prevTop = list.scrollTop;
  const tlsOnly = S.filter.status === 'tls';
  // 默认「全部」视图把诊断行置顶；一旦用了搜索 / 侧栏 / 错误 / JSON / Mock 筛选，
  // 就只按条件渲染真实流量，免得诊断行混进筛选结果里说不清。
  const tlsRows = tlsOnly || tlsInDefaultView() ? tlsVisible() : [];
  list.innerHTML =
    tlsRows.map(tlsRowHtml).join('') + (tlsOnly ? '' : S.flows.map(rowHtml).join(''));
  list.scrollTop = prevTop;
  $('#count').textContent = `${list.children.length} 条`;
  const empty = $('#listEmpty');
  empty.hidden = list.children.length > 0;
  if (!list.children.length) {
    const filtering =
      activeFilterKeys().length > 0 || !!S.filter.status || !!S.filter.mocked || !!S.filter.q;
    const title = empty.querySelector('.empty-title');
    const hint = empty.querySelector('.empty-hint');
    if (title)
      title.textContent = tlsOnly
        ? '没有握手失败的域名'
        : filtering
        ? '没有匹配的请求'
        : '还没有流量';
    if (hint) {
      const a = currentAddr();
      hint.innerHTML = tlsOnly
        ? '客户端不信任根证书、或端口跑的不是 HTTP 时，连不上的域名会实时出现在这里。'
        : filtering
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
  const trSim = (s) =>
    window.ReqLiteI18N && window.ReqLiteI18N.isEn() ? window.ReqLiteI18N.t(s, true) : s;
  const badges = [
    f.mocked ? '<span class="tag mock">MOCK</span>' : '',
    f.replayOf ? '<span class="tag replay">REPLAY</span>' : '',
    f.ws ? '<span class="tag">WS</span>' : '',
    f.tunneled ? '<span class="tag tunnel">透传</span>' : '',
    f.simMode
      ? `<span class="tag sim ${esc(f.simMode)}">${esc(trSim(NET_MODES[f.simMode] || f.simMode))}</span>`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  // 请求刚发出、上游还没回：状态列显示「…」而不是 0/—，行带 pending 呼吸态
  const stText = f.error ? 'ERR' : f.pending ? '…' : f.status || '—';
  const appName = f.app && f.app !== f.host ? f.app : '';
  const hostPart = esc(f.host);
  const appPart = appName ? ` · ${ICONS().iconHtml(appName, 'xs')}${esc(appName)}` : '';
  const sub = `<span class="hl">${hostPart}${appPart}</span>`;
  return `<div class="row${f.pending ? ' pending' : ''}" data-id="${f.id}">
    <span class="m ${esc(f.method)}">${esc(f.method)}</span>
    <span class="cellurl">
      <div class="p">${esc(p)}</div>
      <div class="h">${sub}${badges}</div>
    </span>
    <span class="st ${statusClass(f.status)}">${esc(stText)}</span>
    <span class="tm ${f.duration > 800 ? 'slow' : ''}">${f.pending || f.duration === undefined ? '' : fmtTime(f.duration)}</span>
  </div>`;
}

/* -------------------------------------------------- 握手失败（连接层诊断行）
 * 这类事件发生在 TLS 握手阶段，连 HTTP 请求都没发出来，不能算一条 flow：
 * 不进 store、不进 HAR 导出、也不参与统计。按域名聚合成一行放进主列表，
 * 证书固定的 App 疯狂重试时只更新次数，不会把列表刷屏。 */
const TLS_ROW_PREFIX = 'tls:';

/* 握手失败原因：后端按底层 TLS 报错分类，这里把「客户端不认证书」这种万能说法拆开。
 * 实测 Apple 账号类域名经常是「只接受 h2、代理只给 http/1.1」，跟证书装没装无关。 */
const TLS_REASONS = {
  alpn: {
    short: '客户端只接受 HTTP/2',
    detail: '客户端（常见于系统服务）只接受 HTTP/2，而解密通道只提供 HTTP/1.1，ALPN 协商不上会被直接拒绝。这类域名无法解密，建议加入跳过解密。',
  },
  untrusted: {
    short: '客户端不信任代理签发的证书',
    detail: '客户端校验代理签发的证书失败：证书固定 / App 自带校验，或根证书没被信任。系统服务即使装了根证书也常不认，建议加入跳过解密。',
  },
  reset: {
    short: '客户端在握手阶段直接断开',
    detail: '连接在 TLS 握手完成前被客户端重置，通常是它收到代理证书后立即拒绝（证书固定），或要求双向 TLS 客户端证书。',
  },
  'non-http': {
    short: '端口跑的不是 HTTP',
    detail: '客户端发来的不是 HTTP/1.1 报文（私有协议 / HTTP/2 帧），代理无法解析。',
  },
  'no-request': {
    short: '握手未完成，也没有 HTTP 请求',
    detail: '客户端在 TLS 握手阶段就断开了，一个 HTTP 请求都没发出来。最常见是它不信任代理签发的证书（证书固定 / 系统服务自带校验）；加入跳过解密后改为原样透传。',
  },
  other: {
    short: '客户端不认证书，或端口不是 HTTP',
    detail: '连接层就失败了，没产生任何 HTTP 请求。加入「跳过解密」后改为原样透传，App 能连上，但看不到明文。',
  },
};

function tlsReason(code) {
  return TLS_REASONS[code] || TLS_REASONS.other;
}

function tlsVisible() {
  return S.tlsFailures.slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function tlsInDefaultView() {
  return !S.filter.status && !S.filter.mocked && activeFilterKeys().length === 0;
}

function syncTlsBadge() {
  const b = $('#tlsCount');
  if (!b) return;
  b.hidden = S.tlsFailures.length === 0;
  b.textContent = String(S.tlsFailures.length);
}

function tlsRowHtml(f) {
  return `<div class="row tls" data-id="${esc(TLS_ROW_PREFIX + f.host)}">
    <span class="m tls">TLS</span>
    <span class="cellurl">
      <div class="p">${esc(f.host)}</div>
      <div class="h"><span class="hl">${Number(f.count) || 1} 次握手失败</span><span class="hint">${esc(netTr(tlsReason(f.reason).short))}</span><button class="tls-dismiss" data-tls-dismiss="${esc(f.host)}" title="${esc(netTr('忽略这条提醒'))}" aria-label="${esc(netTr('忽略这条提醒'))}">✕</button></div>
    </span>
    <span class="st fail">FAIL</span>
    <span class="tm">${fmtClock(f.lastAt)}</span>
  </div>`;
}

function upsertTlsFailure(rec) {
  if (!rec || !rec.host) return;
  const i = S.tlsFailures.findIndex((f) => f.host === rec.host);
  if (i >= 0) S.tlsFailures[i] = rec;
  else S.tlsFailures.unshift(rec);
  syncTlsBadge();
  // 诊断行数很少、变化也不频繁，整表重绘比再维护一套增量逻辑可靠
  scheduleRender();
}

/**
 * 撤掉「已解决」的握手失败诊断行：加入跳过解密 / 握手恢复 / 手动忽略都走这里。
 * rules 可以是具体域名，也可以是 *.example.com 这样的规则（一并清掉子域）。
 */
function removeTlsFailures(rules) {
  const list = (Array.isArray(rules) ? rules : [rules])
    .map((s) => String(s || '').trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(Boolean);
  if (!list.length) return 0;
  const hit = (host) => {
    const h = String(host || '').toLowerCase();
    return list.some((r) => h === r || h.endsWith('.' + r));
  };
  const gone = S.tlsFailures.filter((f) => hit(f.host));
  if (!gone.length) return 0;
  S.tlsFailures = S.tlsFailures.filter((f) => !hit(f.host));
  syncTlsBadge();
  if (gone.some((f) => S.selectedId === TLS_ROW_PREFIX + f.host)) {
    S.selectedId = null;
    S.selected = null;
    $('#detail').innerHTML = detailEmptyHtml;
  }
  scheduleRender();
  return gone.length;
}

/** 诊断行右侧 ✕：忽略这一条（服务端一并删除，刷新页面也不会回来） */
async function dismissTlsFailure(host) {
  removeTlsFailures(host);
  try {
    await api('/api/diagnostics?host=' + encodeURIComponent(host), { method: 'DELETE' });
  } catch (_) {
    /* 本地已撤掉即可，服务端清不掉不影响本次会话 */
  }
}

async function loadTlsFailures() {
  try {
    const d = await api('/api/diagnostics');
    S.tlsFailures = Array.isArray(d.tlsFailures) ? d.tlsFailures.slice() : [];
    syncTlsBadge();
  } catch (_) {
    /* 诊断不可用就算了 */
  }
}

/* ------------------------------------------------ 跳过解密白名单 · 管理 */

const PT_SOURCE_LABEL = {
  diagnostic: '诊断一键加入',
  manager: '手动添加',
  settings: '设置页填写',
  suggestion: '从建议添加',
  startup: '原有配置',
};

/* 系统账号 / 推送类服务通常自带证书校验或要求 h2，MITM 解不开，只能透传。
 * 只给少量常见项，避免过度透传把要抓的业务域名也一起屏蔽掉。 */
const PT_SUGGESTIONS = [
  { rule: 'gsa-gpk.apple.com', note: 'Apple 账号认证' },
  { rule: 'gsa.apple.com', note: 'Apple 账号认证' },
  { rule: 'idmsa.apple.com', note: 'Apple ID 认证' },
  { rule: 'push.apple.com', note: 'APNs 推送' },
];

/** 与后端 passthroughMatches 同语义：规则命中自身与所有子域 */
function ptMatches(host, rules) {
  const h = String(host || '').toLowerCase();
  return (rules || []).some((r) => {
    const k = String(r || '').trim().toLowerCase().replace(/^\*?\./, '');
    return !!k && (h === k || h.endsWith('.' + k));
  });
}

/** 输入框可能一次粘一堆：空格 / 逗号 / 分号 / 换行都算分隔，顺手剥协议、端口、路径 */
function normalizePtInput(text) {
  return String(Array.isArray(text) ? text.join(' ') : text || '')
    .split(/[\s,;，、]+/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .replace(/^\*?\./, '')
        .replace(/[^\w.\-]/g, '')
    )
    .filter((s) => s && s.length <= 253 && (s.includes('.') || s === 'localhost'));
}

function ptRules() {
  return (S.passthrough || []).map((x) => x.rule);
}

/** 设置页那个纯文本框与管理列表是同一份数据；正在手填时不覆盖光标下的内容 */
function syncPtTextarea() {
  const field = $('#stPassthrough');
  if (!field || document.activeElement === field) return;
  field.value = ptRules().join('\n');
}

function syncPtBadge() {
  const n = (S.passthrough || []).length;
  for (const id of ['#ptCount', '#ptHeadCount']) {
    const b = $(id);
    if (!b) continue;
    b.hidden = n === 0;
    b.textContent = String(n);
  }
}

async function loadPassthrough() {
  try {
    const d = await api('/api/passthrough');
    S.passthrough = Array.isArray(d.rules) ? d.rules : [];
    S.ptTotalHits = Number(d.totalHits) || 0;
    syncPtBadge();
    syncPtTextarea();
    renderPassthrough();
    renderPtChips();
    return d;
  } catch (_) {
    return null;
  }
}

function renderPassthrough() {
  const box = $('#ptList');
  if (!box) return;
  syncPtBadge();
  const q = String(S.ptSearch || '').trim().toLowerCase();
  const all = S.passthrough || [];
  const items = q ? all.filter((x) => x.rule.toLowerCase().includes(q)) : all;
  $('#ptLiveText').textContent = netTr('已加入 ' + all.length + ' 条规则');
  $('#ptHitText').textContent = S.ptTotalHits
    ? netTr('已透传 ' + S.ptTotalHits + ' 次连接')
    : netTr('尚未透传任何连接');
  const kt = $('#ptKilledText');
  kt.hidden = !S.ptLastKilled;
  kt.textContent = S.ptLastKilled
    ? netTr('最近变更已切断 ' + S.ptLastKilled + ' 条解密连接')
    : '';
  $('#ptShown').textContent = q ? netTr('匹配 ' + items.length + ' / ' + all.length + ' 条') : '';
  box.innerHTML = items.length
    ? items
        .map((x) => {
          const editing = S.ptEditing === x.rule;
          const label = PT_SOURCE_LABEL[x.source] || PT_SOURCE_LABEL.startup;
          const domain = editing
            ? `<input class="input mono pt-edit-input" data-pt-value value="${esc(x.rule)}" spellcheck="false" />`
            : `<span class="pt-domain">${esc(x.rule)}</span>`;
          const ops = editing
            ? `<button data-pt-save>${esc(netTr('保存'))}</button><button data-pt-cancel>${esc(netTr('取消'))}</button>`
            : `<button data-pt-edit>${esc(netTr('编辑'))}</button><button data-pt-copy>${esc(netTr('复制'))}</button><button data-pt-del title="${esc(netTr('移除这条规则'))}">${esc(netTr('移除'))}</button>`;
          const added = x.addedAt ? esc(fmtClock(x.addedAt)) : esc(netTr('原有配置'));
          const hosts = x.hosts && x.hosts.length ? x.hosts.slice(0, 3).join(', ') : '';
          return `<div class="pt-row${S.ptHighlight === x.rule ? ' hl' : ''}" data-pt-rule="${esc(x.rule)}">
            <div class="pt-main">${domain}
              <span class="pt-badge src-${esc(x.source)}">${esc(netTr(label))}</span>
              <span class="pt-scope">${esc(netTr('匹配自身与所有子域'))}</span>
            </div>
            <div class="pt-ops">${ops}</div>
            <div class="pt-meta">
              <span>${esc(netTr('加入'))}</span><span>${added}</span>
              <span class="pt-hit${x.hits ? ' on' : ''}">${esc(netTr('已透传 ' + x.hits + ' 次'))}</span>
              ${hosts ? `<span>${esc(netTr('最近命中'))}</span><span>${esc(hosts)}</span>` : ''}
            </div>
          </div>`;
        })
        .join('')
    : `<div class="pt-empty">${esc(
        netTr(q ? '没有匹配的域名' : '还没有跳过解密的域名。可以从上面的待处理 / 常见系统服务里添加。')
      )}</div>`;
}

function renderPtChips() {
  const rules = ptRules();
  const pending = $('#ptPending');
  if (pending) {
    const failed = (S.tlsFailures || []).filter((f) => !ptMatches(f.host, rules));
    pending.innerHTML = failed.length
      ? failed
          .map(
            (f) =>
              `<button class="pt-chip" data-pt-add="${esc(f.host)}" data-pt-source="diagnostic" title="${esc(netTr('一键加入跳过解密'))}">+ ${esc(f.host)} <span class="pt-chip-note">${esc(netTr(tlsReason(f.reason).short))}</span></button>`
          )
          .join('')
      : `<span class="pt-chip-note">${esc(netTr('当前没有待处理的握手失败域名'))}</span>`;
  }
  const suggest = $('#ptSuggest');
  if (suggest) {
    suggest.innerHTML = PT_SUGGESTIONS.map((x) => {
      const added = ptMatches(x.rule, rules);
      const attr = added
        ? 'disabled'
        : `data-pt-add="${esc(x.rule)}" data-pt-source="suggestion"`;
      return `<button class="pt-chip${added ? ' added' : ''}" ${attr} title="${esc(netTr(added ? '已加入' : '一键加入跳过解密'))}">${added ? '✓' : '+'} ${esc(x.rule)} <span class="pt-chip-note">${esc(netTr(x.note))}</span></button>`;
    }).join('');
  }
}

function ptFail(err) {
  toast(netTr('操作失败：' + ((err && err.message) || err)));
}

async function ptAdd(raw, source = 'manager') {
  const list = normalizePtInput(raw);
  if (!list.length) return toast(netTr('请输入有效的域名'));
  const before = (S.passthrough || []).length;
  try {
    await api('/api/passthrough', { method: 'POST', body: { rules: list, source } });
    await loadPassthrough();
    const added = (S.passthrough || []).length - before;
    toast(netTr('已加入 ' + added + ' 条，跳过 ' + (list.length - added) + ' 条重复'));
  } catch (err) {
    ptFail(err);
  }
}

async function ptRemove(rule) {
  try {
    await api('/api/passthrough?rule=' + encodeURIComponent(rule), { method: 'DELETE' });
    await loadPassthrough();
    toast(netTr('已移除 ' + rule));
  } catch (err) {
    ptFail(err);
  }
}

async function ptReplace(oldRule, newRule) {
  const rules = ptRules().map((r) => (r === oldRule ? newRule : r));
  try {
    await api('/api/passthrough', { method: 'PUT', body: { rules, source: 'manager' } });
    S.ptEditing = '';
    await loadPassthrough();
    toast(netTr('规则已更新'));
  } catch (err) {
    ptFail(err);
  }
}

async function ptClearAll() {
  const n = (S.passthrough || []).length;
  if (!n) return;
  if (!confirm(netTr('确定清空全部 ' + n + ' 条跳过解密规则？'))) return;
  try {
    await api('/api/passthrough', { method: 'DELETE' });
    S.ptEditing = '';
    await loadPassthrough();
    toast(netTr('已清空跳过解密列表'));
  } catch (err) {
    ptFail(err);
  }
}

async function ptCopy(text, n) {
  try {
    await navigator.clipboard.writeText(text);
    toast(netTr('已复制 ' + n + ' 条域名'));
  } catch (_) {
    toast(netTr('复制失败，请手动选中'));
  }
}

async function openPassthrough({ highlight = '' } = {}) {
  S.ptHighlight = highlight;
  S.ptSearch = '';
  const field = $('#ptSearch');
  if (field) field.value = '';
  await loadPassthrough();
  openModal('#modalPassthrough');
}

/** 诊断行的「加入跳过解密」：加完直接进管理列表，不让域名加完就看不见 */
async function addPassthroughHost(host, { open = true } = {}) {
  try {
    const clean = normalizePtInput(host)[0] || String(host || '').trim();
    await api('/api/passthrough', { method: 'POST', body: { rules: [clean], source: 'diagnostic' } });
    await loadPassthrough();
    // 不等 SSE：同帧把这条已处理的诊断行从列表顶部撤掉
    removeTlsFailures(clean);
    toast(`已让 ${clean} 走透传，握手失败记录已清除`);
    if (open) await openPassthrough({ highlight: clean });
  } catch (err) {
    toast('加入白名单失败: ' + err.message);
  }
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
  if (key === 'ip' && value === LOCAL_DEVICE_KEY) return '本机';
  if (Array.isArray(value)) return value.join('、');
  return String(value);
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

/* 清空会作废旧世代：清空前发出去的 facets 请求即使晚到，也不能把
 * 已经消失的「设备 / 应用」分组重新填回去（高频抓包时很容易撞上）。 */
let facetsEpoch = 0;
let facetsSeq = 0;

async function loadFacets() {
  const epoch = facetsEpoch;
  const seq = ++facetsSeq;
  const fresh = () => epoch === facetsEpoch && seq === facetsSeq;
  try {
    // 勾选应用后域名 / 接口结构级联：把当前筛选传给服务端，
    // hosts 按「应用(+设备+搜索)」聚合，routes 再叠加已选域名。
    const p = new URLSearchParams();
    if (S.filter.app.length) p.set('app', S.filter.app.join(','));
    if (S.filter.ip) p.set('ip', S.filter.ip);
    if (S.filter.host) p.set('host', S.filter.host);
    if (S.filter.q) p.set('q', S.filter.q);
    const qs = p.toString();
    const data = await api('/api/facets' + (qs ? '?' + qs : ''));
    if (!fresh()) return; // 清空已发生，或已有更新的请求在路上
    S.facets = data;
  } catch (_) {
    if (!fresh()) return;
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
let facetsLastAt = 0;
/** 侧栏聚合跟着实时流走：80ms 合并突发；持续高频时至少每 300ms 推一次，
 *  避免每条新流量都重置定时器导致侧栏反而一直不刷新。 */
function scheduleFacets() {
  clearTimeout(facetTimer);
  const run = () => {
    facetsLastAt = Date.now();
    loadFacets();
  };
  if (Date.now() - facetsLastAt >= 300) run();
  else facetTimer = setTimeout(run, 80);
}

/** 清空：UI 先同步抹平，再向服务端取一次权威空值 */
function resetFacetsNow() {
  facetsEpoch += 1;
  clearTimeout(facetTimer);
  S.facets = { hosts: [], apps: [], devices: [], routes: [] };
  renderSide();
  loadFacets();
}

/** 列表、待渲染队列、侧栏在同一帧一起清掉，避免「列表空了、分组还挂着」 */
function clearFlowsUi({ resetDetail = false } = {}) {
  pendingAdds.length = 0;
  pendingPatches.length = 0;
  S.flows = [];
  renderList();
  if (resetDetail) {
    S.selectedId = null;
    S.selected = null;
    $('#detail').innerHTML = detailEmptyHtml;
  }
  resetFacetsNow();
}

function activeFilterKeys() {
  return ['ip', 'app', 'host', 'route', 'q'].filter((k) =>
    k === 'app' ? S.filter.app.length > 0 : !!S.filter[k]
  );
}

function renderSide() {
  const body = $('#sideBody');
  if (!body) return;

  // 勾选应用后只保留「应用 × 域名 × 接口」组合筛选：
  // 上面的收藏 / 设备分组不再展示，应用分组本身始终显示全部应用
  const appChecked = S.filter.app.length > 0;
  const groups = [];
  if (!appChecked) groups.push(bookmarkGroupHtml());
  for (const section of FACET_SECTIONS) {
    if (appChecked && section.key === 'devices') continue;
    groups.push(facetGroupHtml(section));
  }
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
          const netHit = section.key === 'apps' ? netRuleFor(it.key) : null;
          const netDot =
            section.key === 'apps'
              ? `<span class="net-dot ${netHit ? 'on' : ''}" data-net-app="${esc(it.key)}" title="${esc(netTr('断网开关'))}" role="button" tabindex="-1"></span>`
              : '';
          // 应用是勾选式多选：勾中的行右侧显示绿色对钩（替代原来的高亮）
          const checked = section.key === 'apps' && S.filter.app.includes(it.key);
          const on =
            section.key === 'apps' ? '' : S.filter[section.filterKey] === it.key ? 'on' : '';
          const mark =
            section.key === 'apps' ? `<span class="ck" aria-hidden="true">✓</span>` : '';
          const cnt = checked ? '' : `<span class="cnt">${it.count}</span>`;
          return `<button class="sitem ${on} ${checked ? 'checked' : ''}"
          data-facet="${section.filterKey}" data-value="${esc(it.key)}" title="${esc(it.label + tip)}">
        <span class="lbl">${wrap}${esc(it.label)}</span>${netDot}${cnt}${mark}
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
  // 应用维度是数组（书签里老数据是字符串），统一成逗号串再比
  const norm = (v) => (Array.isArray(v) ? v.join(',') : String(v || ''));
  return keys.every((k) => norm(S.filter[k]) === norm(filter[k]));
}

function setFacet(key, value) {
  if (!value) return;
  if (key === 'app') {
    // 应用是勾选式多选：点已勾的取消勾，点未勾的追加
    const i = S.filter.app.indexOf(value);
    if (i >= 0) S.filter.app.splice(i, 1);
    else S.filter.app.push(value);
  } else if (S.filter[key] === value) delete S.filter[key];
  else S.filter[key] = value;
  syncFilters();
}

function clearFacet(key) {
  if (key === 'app') S.filter.app = [];
  else delete S.filter[key];
  if (key === 'q') {
    S.filter.q = '';
    const input = $('#search');
    if (input) input.value = '';
  }
  syncFilters();
}

function syncFilters() {
  syncFilterMore();
  renderChips();
  renderSide();
  loadFlows();
  // 勾选应用后域名 / 接口结构是级联聚合，不等 SSE 的 1.2s 定时器，立即刷新
  loadFacets();
}

function renderChips() {
  const el = $('#chips');
  if (!el) return;
  const parts = [];
  for (const key of ['ip', 'app', 'host', 'route']) {
    // 应用是多选数组：空数组不算激活
    if (key === 'app' ? !S.filter.app.length : !S.filter[key]) continue;
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
  // 握手失败行不是 flow，详情数据就在前端的聚合记录里，不必请求 /api/flows/:id
  if (id.startsWith(TLS_ROW_PREFIX)) {
    const host = id.slice(TLS_ROW_PREFIX.length);
    const rec = S.tlsFailures.find((f) => f.host === host);
    if (!rec) return;
    S.selected = { kind: 'tls', ...rec };
    S.detailTab = 'overview';
    renderDetail();
    return;
  }
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

/** 握手失败行的详情：给出原因和一键透传，不用再绕到设置页 */
function renderTlsDetail(pane, f) {
  const why = tlsReason(f.reason);
  const d = f.detail || {};
  pane.innerHTML = `
    <div class="dhead tls-dhead">
      <div class="dline">
        <span class="dmethod tls">TLS</span>
        <span class="durl">${esc(f.host)}</span>
      </div>
      <div class="dmeta">
        <span class="st fail">连接失败</span>
        <span>端口 <b>${esc(f.port || 443)}</b></span>
        <span>次数 <b>${Number(f.count) || 1}</b></span>
        <span>${fmtClock(f.lastAt)}</span>
        <span class="dactions">
          <button class="btn primary" data-block-host="${esc(f.host)}">加入跳过解密</button>
          <button class="btn ghost" data-pt-open>查看管理列表</button>
        </span>
      </div>
    </div>
    <div class="dbody tls-dbody">
      <div class="sec"><div class="sec-head">失败原因 <span class="hint">判定</span></div>
        <p class="hint tls-reason-title">${esc(netTr(why.short))}</p>
        <p class="hint">${esc(netTr(why.detail))}</p>
        <p class="hint tls-error">${esc(f.error || '—')}</p>
      </div>
      <div class="sec"><div class="sec-head">连接信息</div>
        ${kv([
          ['SNI', d.sni || '—'],
          ['ALPN', d.alpn || 'not negotiated'],
          ['Handshake', d.established ? 'completed' : 'failed'],
        ])}
      </div>
      <div class="sec"><div class="sec-head">说明</div>
        <p class="hint">客户端不认 iReq 的根证书（证书固定 / 自带校验），或这个端口跑的不是 HTTP。加入「跳过解密的域名」后改为原样透传，App 能连上，但看不到明文。</p>
      </div>
    </div>`;
}

function renderDetail() {
  const f = S.selected;
  const pane = $('#detail');
  if (!f) return;
  if (f.kind === 'tls') return renderTlsDetail(pane, f);

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
          <button class="btn ghost" id="actNet">网络 ▾</button>
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
  $('#actMock')?.addEventListener('click', () => openQuickMock(f));
  $('#actNet')?.addEventListener('click', (e) => openFlowNetMenu(e, f));
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
    // 只有非 HTTP/1.1 才单独列一行：解密出来的 h2 流量要能一眼看出协议版本
    ...(/^HTTP\/2/i.test(f.httpVersion || '') ? [['协议版本', 'HTTP/2']] : []),
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

let lastModalFocus = null;

function focusableIn(modal) {
  return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modal).filter(
    (el) => !el.disabled && el.offsetParent !== null
  );
}

function openModal(id) {
  const modal = $(id);
  lastModalFocus = document.activeElement;
  modal.hidden = false;
  if (window.ReqLiteJSON) setTimeout(() => window.ReqLiteJSON.relayout(), 30);
  // 纯展示型弹窗（如首启引导）不抢焦点：自动 focus 会带出浏览器默认的焦点环，
  // 在深色下是一圈白框，比弹窗本身还扎眼。Tab 仍然能进，键盘可达性不受影响。
  if (modal.hasAttribute('data-no-autofocus')) return;
  const first = modal.querySelector('[data-autofocus]') || focusableIn(modal)[0];
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 0);
}

function closeModals() {
  // 引导弹窗不管从哪条路关掉（✕ / 遮罩 / Esc / 开始使用）都算看过，只弹一次
  if (!$('#modalWelcome').hidden) markOnboarded();
  // 设置是自动保存的：关窗前把还没到 debounce 时间的改动落下去，避免「点了 ✕ 就等于没改」
  if (!$('#modalSettings').hidden && settingsDirty) flushSettingsSave();
  // 网络面板同理；只在真的编辑过时 flush，避免从没打开过的空面板把规则清空
  if (!$('#modalNetwork').hidden && netDirty) {
    clearTimeout(netTimer);
    putNetSim(netFromPanel(), true);
  }
  $$('.modal').forEach((m) => (m.hidden = true));
  closeAllPopups();
  if (lastModalFocus && lastModalFocus.isConnected) {
    try {
      lastModalFocus.focus({ preventScroll: true });
    } catch (_) {
      /* 元素已不可聚焦就算了 */
    }
  }
  lastModalFocus = null;
}

/* ------------------------------------------------------------ 首启引导 */

let onboardedSent = false;

/**
 * 标记「引导看过了」。
 * 只往 true 写、且只发一次：多点几下 ✕ 不会打一串请求。
 * 存服务端（data/config.json）而不是 localStorage —— 换个浏览器不该再弹一遍。
 */
function markOnboarded() {
  if (onboardedSent) return;
  onboardedSent = true;
  if (S.status) S.status.onboarded = true;
  api('/api/config', { method: 'PUT', body: { onboarded: true } }).catch(() => {});
}

/** 首启才弹；等首屏数据渲染完再弹，避免先闪一下空列表再被盖住 */
function maybeShowWelcome() {
  if (!S.status || S.status.onboarded === true) return;
  openModal('#modalWelcome');
}

/* ------------------------------------------------------------ 网络模拟 */

const NET_MODES = { offline: '断网', weak: '弱网', timeout: '超时' };
const NET_DEFAULTS = { enabled: true, latencyMs: 800, kbps: 64, timeoutMs: 30000, rules: [] };
const DOCK_SIM_ID = 'dock-global';
/* 写全句而不是拼字符串：英文字典按中文原文查表，拼出来的句子会漏翻 */
const NET_LIVE_LABELS = {
  offline: '全部流量：断网',
  weak: '全部流量：弱网',
  timeout: '全部流量：超时',
};
let netTimer = null;
let netDirty = false;

/** 动态插入的 option / placeholder / 候选 chip 不会被静态扫描覆盖，显式走字典 */
function netTr(s) {
  return window.ReqLiteI18N && window.ReqLiteI18N.isEn() ? window.ReqLiteI18N.t(s, true) : s;
}

function netNum(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 空 match 的「正在输入」行要留在 UI 里，所以这里不过滤 */
function normalizeNetSim(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const rules = (Array.isArray(s.rules) ? s.rules : []).map((r, i) => ({
    id: String((r && r.id) || 'r' + (i + 1)),
    match: String((r && r.match) || '').trim(),
    mode: NET_MODES[r && r.mode] ? r.mode : 'offline',
  }));
  return {
    enabled: s.enabled !== false,
    latencyMs: netNum(s.latencyMs, NET_DEFAULTS.latencyMs),
    kbps: netNum(s.kbps, NET_DEFAULTS.kbps),
    timeoutMs: netNum(s.timeoutMs, NET_DEFAULTS.timeoutMs),
    rules,
  };
}

function currentNetSim() {
  return normalizeNetSim(S.networkSim);
}

function netRuleFor(name) {
  const t = String(name || '').toLowerCase();
  return currentNetSim().rules.find((r) => {
    const m = r.match.toLowerCase();
    return !!r.match && (m === t || m === 'app:' + t);
  });
}

function syncNetBadge() {
  const sim = currentNetSim();
  const n = sim.enabled ? sim.rules.filter((r) => r.match).length : 0;
  const b = $('#netCount');
  if (b) {
    b.hidden = n === 0;
    b.textContent = String(n);
  }
  const btn = $('#btnNetwork');
  if (btn) btn.classList.toggle('net-on', n > 0);
  renderDock();
  renderNetLive();
}

async function putNetSim(sim, immediate = false) {
  S.networkSim = normalizeNetSim(sim);
  syncNetBadge();
  renderSide();
  clearTimeout(netTimer);
  const send = async () => {
    netDirty = false;
    try {
      await api('/api/config', { method: 'PUT', body: { networkSim: S.networkSim } });
    } catch (_) {
      /* 服务暂时不可用就保留本地状态，下次改动再试 */
    }
  };
  if (immediate) return send();
  netTimer = setTimeout(send, 400);
}

/**
 * 控制坞一键模式。
 *
 * 以前那个开关只翻 enabled 布尔值，而默认规则是空的 —— 用户点来点去没有任何
 * 请求被拦，看着就像功能坏了。这里直接给全部流量落一条 * 规则，点第二次撤销；
 * 其余按域名 / 应用的规则保留，全局规则排在最前（规则按顺序匹配，靠前优先）。
 */
async function toggleDockSim(mode) {
  const sim = currentNetSim();
  const globalIdx = sim.rules.findIndex((r) => r.match === '*');
  const cur = sim.enabled && globalIdx >= 0 ? sim.rules[globalIdx] : null;
  if (cur && cur.mode === mode) {
    sim.rules = sim.rules.filter((_, i) => i !== globalIdx);
    await putNetSim(sim, true);
    toast('已恢复全部流量');
  } else {
    sim.rules = [
      { id: DOCK_SIM_ID, match: '*', mode },
      ...sim.rules.filter((r) => r.match !== '*'),
    ];
    sim.enabled = true;
    await putNetSim(sim, true);
    const local = !(S.localProxy && S.localProxy.ours);
    toast(
      mode === 'weak'
        ? local
          ? '已对全部流量开启弱网（右键可调参数）；本机未接管代理，仅对已连设备生效'
          : '已对全部流量开启弱网（右键可调参数）'
        : local
          ? '已对全部流量开启断网（右键可调参数）；本机未接管代理，仅对已连设备生效'
          : '已对全部流量开启断网（右键可调参数）'
    );
  }
  renderNetLive();
}

/** 面板顶部状态条：当前到底在模拟什么、已经模拟了多少条、改动有没有真的生效 */
function renderNetLive() {
  const box = $('#netLive');
  if (!box) return;
  const sim = currentNetSim();
  const n = sim.enabled ? sim.rules.filter((r) => r.match).length : 0;
  const g = sim.enabled ? sim.rules.find((r) => r.match === '*') : null;
  $('#netLiveText').textContent = g
    ? netTr(NET_LIVE_LABELS[g.mode] || '已按规则模拟')
    : n
      ? netTr('已按规则模拟')
      : netTr('未开启网络模拟');
  const hits = (S.status && S.status.stats && S.status.stats.simulated) || 0;
  $('#netHit').textContent = `已模拟 ${hits} 条请求`;
  $('#netLiveDot').className =
    'net-live-dot' + (n ? g && g.mode === 'offline' ? ' offline' : ' on' : '');
  const killed = Number(S.lastSimKilled || 0);
  const live = $('#netLiveKilled');
  if (live) {
    live.hidden = killed === 0;
    live.textContent = `最近变更已切断 ${killed} 条已有连接`;
  }
}

function netFromPanel() {
  const sim = currentNetSim();
  sim.enabled = $('#netEnabled').checked;
  sim.latencyMs = netNum($('#netLatency').value, NET_DEFAULTS.latencyMs);
  sim.kbps = netNum($('#netKbps').value, NET_DEFAULTS.kbps);
  sim.timeoutMs = netNum($('#netTimeout').value, NET_DEFAULTS.timeoutMs);
  sim.rules = $$('#netRules .net-rule')
    .map((row, i) => ({
      id: row.dataset.netId || 'r' + (i + 1),
      match: row.querySelector('.net-match').value.trim(),
      mode: row.querySelector('.net-mode').value,
    }))
    .filter((r) => r.match);
  return sim;
}

function netRuleHtml(r) {
  return `<div class="net-rule" data-net-id="${esc(r.id)}">
    <input class="input mono net-match" value="${esc(r.match)}" placeholder="${esc(netTr('应用名 / 域名 / IP / *'))}" spellcheck="false" />
    <select class="input net-mode">
      <option value="offline"${r.mode === 'offline' ? ' selected' : ''}>${netTr('断网')}</option>
      <option value="weak"${r.mode === 'weak' ? ' selected' : ''}>${netTr('弱网')}</option>
      <option value="timeout"${r.mode === 'timeout' ? ' selected' : ''}>${netTr('超时')}</option>
    </select>
    <button class="btn ghost icon" data-net-del="${esc(r.id)}" title="${esc(netTr('删除规则'))}">✕</button>
  </div>`;
}

function renderNetPanel() {
  const sim = currentNetSim();
  $('#netEnabled').checked = sim.enabled;
  $('#netLatency').value = sim.latencyMs;
  $('#netKbps').value = sim.kbps;
  $('#netTimeout').value = sim.timeoutMs;
  $('#netRules').innerHTML = sim.rules.length
    ? sim.rules.map(netRuleHtml).join('')
    : `<div class="net-empty">${netTr('还没有规则。点上面的应用 / 域名，或「添加规则」。')}</div>`;
  const apps = (S.facets.apps || []).slice(0, 8).map((x) => ({
    match: 'app:' + x.key,
    label: x.label || x.key,
    kind: netTr('应用'),
  }));
  const hosts = (S.facets.hosts || []).slice(0, 8).map((x) => ({
    match: 'host:' + x.key,
    label: x.key,
    kind: netTr('域名'),
  }));
  const chips = [{ match: '*', label: netTr('全部流量'), kind: '' }, ...apps, ...hosts];
  $('#netChips').innerHTML = chips
    .map(
      (x) =>
        `<button class="net-chip" data-net-quick="${esc(x.match)}" title="${esc(netTr('加一条断网规则'))}">${x.kind ? `<i>${x.kind}</i>` : ''}${esc(x.label)}</button>`
    )
    .join('');
  syncNetBadge();
  renderSide();
}

async function openNetwork() {
  try {
    const [cfg, st] = await Promise.all([api('/api/config'), api('/api/status')]);
    S.networkSim = normalizeNetSim(cfg.networkSim);
    S.status = st;
  } catch (_) {
    /* 保留本地状态 */
  }
  renderNetPanel();
  openModal('#modalNetwork');
}

async function netQuickAdd(match, mode = 'offline') {
  const sim = netFromPanel();
  if (!sim.rules.some((r) => r.match === match)) {
    sim.rules.push({ id: 'r' + Date.now().toString(36), match, mode });
  }
  sim.enabled = true;
  await putNetSim(sim, true);
  renderNetPanel();
}

/** 侧栏应用行的一键开关：面板没打开过时不能读面板 DOM，否则会读到空规则 */
async function toggleNetApp(name) {
  const sim = $('#modalNetwork').hidden ? currentNetSim() : netFromPanel();
  const t = String(name).toLowerCase();
  const hit = sim.rules.find((r) => r.match.toLowerCase() === t || r.match.toLowerCase() === 'app:' + t);
  sim.rules = hit ? sim.rules.filter((r) => r !== hit) : sim.rules;
  if (!hit) sim.rules.push({ id: 'r' + Date.now().toString(36), match: 'app:' + name, mode: 'offline' });
  sim.enabled = true;
  await putNetSim(sim, true);
  renderNetPanel();
}

function bindNetwork() {
  $('#btnNetwork').addEventListener('click', openNetwork);
  $('#modalNetwork').addEventListener('input', () => {
    netDirty = true;
    putNetSim(netFromPanel());
  });
  $('#netRules').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-net-del]');
    if (!del) return;
    const sim = netFromPanel();
    sim.rules = sim.rules.filter((r) => r.id !== del.dataset.netDel);
    await putNetSim(sim, true);
    renderNetPanel();
  });
  $('#netChips').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-net-quick]');
    if (!chip) return;
    await netQuickAdd(chip.dataset.netQuick);
    toast('已添加断网规则：' + chip.dataset.netQuick);
  });
  $('#netAdd').addEventListener('click', () => {
    const sim = netFromPanel();
    sim.rules.push({ id: 'r' + Date.now().toString(36), match: '', mode: 'offline' });
    S.networkSim = normalizeNetSim(sim);
    renderNetPanel();
    const last = $('#netRules .net-rule:last-child .net-match');
    if (last) last.focus();
  });
  $('#netAllOff').addEventListener('click', async () => {
    await netQuickAdd('*');
    toast('已对全部流量开启断网');
  });
  $('#netClear').addEventListener('click', async () => {
    const sim = netFromPanel();
    sim.rules = [];
    await putNetSim(sim, true);
    renderNetPanel();
  });
}

/* 导出：跟随当前筛选条件，后端生成 HAR 1.2（含完整 headers / body） */
async function exportFlows(format = 'har') {
  const params = new URLSearchParams();
  if (S.filter.q) params.set('q', S.filter.q);
  if (S.filter.status) params.set('status', S.filter.status);
  if (S.filter.mocked) params.set('mocked', '1');
  for (const key of ['host', 'ip', 'route']) {
    if (S.filter[key]) params.set(key, S.filter[key]);
  }
  if (S.filter.app.length) params.set('app', S.filter.app.join(','));
  try {
    const r = await fetch(`/api/export/${format}?${params.toString()}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const count = Number(r.headers.get('X-Flow-Count') || 0);
    const ext = format === 'json' ? 'json' : 'har';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ireq-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${count} 条`);
  } catch (err) {
    toast('导出失败: ' + err.message);
  }
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

function openRuleForm(rule, fromTree, opts) {
  S.loadingRuleTab = true;
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
  switchRuleTab((opts && opts.pane) || 'match');
  updateAllRuleUI();
  S.ruleFromTree = !!fromTree;
  const back = $('#ruBackRules');
  if (back) back.hidden = !S.ruleFromTree;
  openModal('#modalRule');
  setTimeout(() => {
    if (JE()) JE().relayout();
    $('#ruMatch').focus();
    S.loadingRuleTab = false;
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
  if (!S.editingRule && S.rulesDir) payload.dir = S.rulesDir; /* 从文件树某目录里新建 → 落到该目录 */
  try {
    if (S.editingRule && !asCopy) {
      await api('/api/rules/' + S.editingRule.id, { method: 'PUT', body: payload });
    } else {
      await api('/api/rules', { method: 'POST', body: payload });
    }
    if (S.ruleFromTree) await closeActiveRuleTab({ force: true });
    else { closeModals(); await loadRules(); }
    await loadStatus();
    toast(asCopy ? '已另存为副本' : '规则已保存，立即生效');
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

async function loadRules() {
  S.rules = await api('/api/rules');
  $('#ruleCount').textContent = S.rules.length;
  renderDock();
  $('#rulesCount').textContent = S.rules.length ? `(${S.rules.length})` : '';
  await loadTree(); /* 先拿树：选中的目录可能已被外部编辑器删掉 */
  if (S.rulesDir && !treeHasDir(S.rulesTreeData && S.rulesTreeData.tree, S.rulesDir)) {
    setRulesDir('');
    renderTree();
  }
  renderRules();
  updateWorkspaceChrome();
}

/* 目录前缀匹配：选中文件夹时递归显示子文件夹里的规则 */
function ruleInDir(r, dir) {
  if (!dir) return true;
  const d = String(r.dir || '');
  return d === dir || d.startsWith(dir + '/');
}

function ruleMatches(r, q) {
  if (!q) return true;
  return [r.name, r.note, r.urlMatch, r.host, r.method, String(r.status), r.body, r.dir]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function ruleQuery() {
  return ($('#rulesSearch') ? $('#rulesSearch').value : '').trim().toLowerCase();
}

function setRulesDir(dir) {
  S.rulesDir = dir || '';
  localStorage.setItem('reqlite-rule-dir', S.rulesDir);
}

function treeHasDir(nodes, dir) {
  if (!dir || !Array.isArray(nodes)) return false;
  for (const n of nodes) {
    if (n.type !== 'dir') continue;
    if (n.path === dir) return true;
    if (treeHasDir(n.children, dir)) return true;
  }
  return false;
}

function rulesEmptyHtml(q) {
  if (q) {
    return `<div class="rules-empty">没有匹配「${esc(q)}」的规则<br><button type="button" class="btn ghost" data-empty="clear">清除搜索</button></div>`;
  }
  if (!S.rules.length) {
    return `<div class="rules-empty">还没有规则<br>点「+ 新建规则」，或抓一条请求后点「Mock 此请求」最快<br><button type="button" class="btn primary" data-empty="new">+ 新建规则</button></div>`;
  }
  return `<div class="rules-empty">这个文件夹里还没有规则<br><button type="button" class="btn primary" data-empty="new">+ 在此新建规则</button> <button type="button" class="btn ghost" data-empty="all">查看全部</button></div>`;
}

function renderRules() {
  const box = $('#rulesList');
  if (!box) return;
  const crumb = $('#rulesDirCrumb');
  const q = ruleQuery();
  if (crumb) {
    if (S.rulesDir) {
      crumb.hidden = false;
      crumb.innerHTML = `<span class="rt-crumb-path">📁 ${esc(S.rulesDir)}</span><button type="button" class="btn ghost" id="rtCrumbBack">返回全部</button>`;
      const back = $('#rtCrumbBack');
      if (back) back.onclick = () => { setRulesDir(''); renderRules(); renderTree(); };
    } else {
      crumb.hidden = true;
    }
  }
  const list = S.rules.filter((r) => ruleInDir(r, S.rulesDir) && ruleMatches(r, q));
  const foot = $('#rulesFootHint');
  if (foot) {
    foot.textContent = S.rulesDir
      ? `当前文件夹 ${list.length} 条 / 共 ${S.rules.length} 条规则`
      : q ? `共 ${S.rules.length} 条规则，匹配 ${list.length} 条` : `共 ${S.rules.length} 条规则`;
  }
  if (!list.length) {
    box.innerHTML = rulesEmptyHtml(q);
    box.onclick = (e) => {
      const btn = e.target.closest('[data-empty]');
      if (!btn) return;
      const a = btn.dataset.empty;
      if (a === 'clear') $('#rulesSearch').value = ''; else if (a === 'all') setRulesDir('');
      else if (a === 'new') { newRuleInDir(S.rulesDir); return; }
      renderRules();
      renderTree();
    };
    box.onchange = null;
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const preview = String(r.body || '').replace(/\s+/g, ' ').slice(0, 150);
      const rel = S.rulesDir && String(r.dir || '').startsWith(S.rulesDir + '/')
        ? String(r.dir).slice(S.rulesDir.length + 1) + '/'
        : r.dir ? r.dir + '/' : '';
      return `<div class="rule ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
      <div class="rule-top">
        <label class="mini-switch"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''} title="启用 / 停用" /><span></span></label>
        <span class="rule-name">${esc(r.name || '未命名规则')}</span>
        <span class="rule-actions">
          <button class="btn ghost" data-act="dup" title="复制一份">复制</button>
          <button class="btn ghost" data-act="edit">编辑</button>
          <button class="btn ghost" data-act="del">删除</button>
        </span>
      </div>
      <div class="rule-match">${esc(r.method)} · ${esc(r.matchMode)} · ${esc(r.urlMatch || '(任意)')}${r.host ? ' @ ' + esc(r.host) : ''}${rel ? ` · <span class="rule-dir" title="${esc(r.dir || '')}">${esc(rel)}</span>` : ''}</div>
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
      openRuleFromTree(rule);
    } else if (act === 'del') {
      if (!confirm(`确定删除规则「${rule.name || '未命名规则'}」？不可恢复。`)) return;
      await api('/api/rules/' + id, { method: 'DELETE' });
      await Promise.all([loadRules(), loadStatus()]);
      toast('规则已删除');
    } else if (act === 'dup') {
      const { id: _id, createdAt, ...rest } = rule;
      await api('/api/rules', { method: 'POST', body: { ...rest, name: (rule.name || '未命名规则') + ' 副本' } });
      await Promise.all([loadRules(), loadStatus()]);
      toast('已复制规则');
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

/* -------------------------------------------------- 规则文件树（data/rules/ 真实文件） */

async function loadTree() {
  try {
    S.rulesTreeData = await api('/api/rules/tree');
    S.rulesTreeError = '';
  } catch (err) {
    S.rulesTreeData = { tree: [] };
    S.rulesTreeError = err.message || '读取失败';
  }
  renderTree();
}

/* 搜索时树与右侧列表同步收敛：命中的规则（或其祖先目录）才显示 */
function treeNodeMatches(n, q) {
  if (!q) return true;
  const hay = n.type === 'rule'
    ? [n.name, n.rule && n.rule.name, n.rule && n.rule.urlMatch, n.rule && n.rule.host].join(' ')
    : String(n.name || '');
  if (hay.toLowerCase().includes(q)) return true;
  return (n.children || []).some((c) => treeNodeMatches(c, q));
}

function renderTree() {
  const box = $('#rulesTree');
  if (!box) return;
  const scroll = box.scrollTop;
  box.classList.toggle('hide-body', !S.showRuleBody);
  const tree = S.rulesTreeData && S.rulesTreeData.tree;
  if (S.rulesTreeError) {
    box.innerHTML = `<div class="rt-empty rt-error">文件树读取失败：${esc(S.rulesTreeError)}</div>`;
  } else {
    const html = (renderTreeNode(tree || [], 0, ruleQuery()) || '') + draftRowHTML('', 0);
    if (html.trim()) box.innerHTML = html;
    else if (tree && tree.length) box.innerHTML = '<div class="rt-empty">没有匹配的规则</div>';
    else
      box.innerHTML =
        '<div class="rt-empty">rules 目录还是空的<br>用「+ 文件」或抓包页的「Mock 此请求」创建</div>';
  }
  bindTreeEvents(box);
  box.scrollTop = scroll; /* 展开 / 选中 / 刷新后保留滚动位置 */
  focusTreeEditor();
}

/** 行内命名输入框：新建与改名共用，避免依赖 window.prompt（Electron 里没有） */
function treeNameInputHTML(value, placeholder, extraCls) {
  return `<input class="rt-name-input${extraCls ? ' ' + extraCls : ''}" type="text" value="${esc(
    value || ''
  )}" placeholder="${esc(placeholder || '')}" spellcheck="false" autocomplete="off" data-tree-input>`;
}

/** 新建中的草稿行：出现在目标文件夹的末尾（根目录则在树底） */
function draftRowHTML(dir, depth) {
  const d = S.treeDraft;
  if (!d || (d.dir || '') !== (dir || '')) return '';
  const isDir = d.type === 'dir';
  return `<div class="rt-row rt-draft" data-type="draft" data-dir="${esc(dir || '')}" style="--d:${depth}">
    <span class="rt-icon">${isDir ? '▤' : '◉'}</span>
    ${treeNameInputHTML(d.value, isDir ? '新文件夹名称' : '新规则文件名', 'rt-draft-input')}
  </div>`;
}

/** 渲染后把光标放进正在编辑的输入框 */
function focusTreeEditor() {
  const box = $('#rulesTree');
  if (!box) return;
  const el = box.querySelector('[data-tree-input]');
  if (!el) return;
  el.focus();
  const v = el.value;
  const dot = v.lastIndexOf('.');
  if (dot > 0) el.setSelectionRange(0, dot); /* 文件名只选中主名，不选 .rule.json */
  else el.select();
}

function renderTreeNode(nodes, depth, q, parentPath) {
  return nodes
    .filter((n) => treeNodeMatches(n, q))
    .map((n) => {
      const renaming = S.treeRenaming && S.treeRenaming.path === n.path;
      const nameHTML = renaming
        ? treeNameInputHTML(S.treeRenaming.value, '', 'rt-rename-input')
        : `<span class="rt-name"><span class="rt-label">${esc(n.name)}</span></span>`;
      if (n.type === 'dir') {
        const open = q ? true : S.rulesTreeOpen.has(n.path);
        return `<div class="rt-node">
        <div class="rt-row rt-dir ${S.rulesDir === n.path ? 'active' : ''}${
          renaming ? ' renaming' : ''
        }" data-path="${esc(n.path)}" data-type="dir" data-name="${esc(n.name)}" title="${esc(
          n.path
        )}" tabindex="0" role="treeitem" aria-expanded="${open}" style="--d:${depth}" draggable="true">
          <span class="rt-caret" data-caret="${esc(n.path)}">${open ? '▾' : '▸'}</span>
          <span class="rt-icon">▤</span>
          ${nameHTML}
          <span class="rt-ops"><button type="button" data-op="menu" title="更多操作">⋯</button></span>
        </div>
        ${
          open
            ? `<div class="rt-kids">${renderTreeNode(n.children || [], depth + 1, q, n.path)}${draftRowHTML(
                n.path,
                depth + 1
              )}</div>`
            : ''
        }
      </div>`;
      }
      if (n.type === 'rule') {
        const active = S.rulesActivePath === n.path;
        return `<div class="rt-node">
        <div class="rt-row rt-rule ${active ? 'active' : ''}${
          renaming ? ' renaming' : ''
        }" data-path="${esc(n.path)}" data-type="rule" data-id="${esc(n.rule.id)}" data-name="${esc(
          n.name
        )}" title="${esc(n.path)}" tabindex="0" role="treeitem" aria-selected="${active}" style="--d:${depth}" draggable="true">
          <span class="rt-icon ${n.rule.enabled ? 'on' : 'off'}">${n.rule.enabled ? '◉' : '○'}</span>
          ${
            renaming
              ? nameHTML
              : `<span class="rt-name"><span class="rt-label">${esc(n.name)}</span>${
                  n.rule.enabled ? '' : ' <i class="rt-offtag">停用</i>'
                }</span>`
          }
          <span class="rt-ops"><button type="button" data-op="menu" title="更多操作">⋯</button></span>
        </div>
        ${(n.children || [])
          .map(
            (b) => `<div class="rt-row rt-bodyfile" data-path="${esc(b.path)}" data-type="body" data-rule-id="${esc(n.rule.id)}" data-name="${esc(b.name)}" title="${esc(b.path)}" tabindex="0" role="treeitem" style="--d:${depth + 1}">
          <span class="rt-icon">≡</span><span class="rt-name">${esc(b.name)}</span>
        </div>`
          )
          .join('')}
      </div>`;
      }
      return '';
    })
    .join('');
}

/* 单击文件名要等一个双击间隔再「打开」，否则双击改名时第一次单击已经把规则标签打开了 */
let treeClickTimer = null;
const TREE_DBLCLICK_MS = 220;

function bindTreeEvents(box) {
  let dragFrom = null;

  box.ondragstart = (e) => {
    const row = e.target.closest('.rt-row');
    if (!row || row.dataset.type === 'body') return;
    dragFrom = row.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragFrom); } catch (_) { /* ok */ }
  };

  box.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    box.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
    const dir = e.target.closest('.rt-dir');
    if (dir) dir.classList.add('drop-hover');
    else box.classList.add('drop-root'); /* 拖到空白处 = 移到根目录，高亮整棵树 */
  };
  box.ondragleave = (e) => {
    if (!box.contains(e.relatedTarget)) {
      box.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
      box.classList.remove('drop-root');
    }
  };
  box.ondrop = async (e) => {
    e.preventDefault();
    box.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
    box.classList.remove('drop-root');
    const dir = e.target.closest('.rt-dir');
    const toDir = dir ? dir.dataset.path : '';
    const from = dragFrom || e.dataTransfer.getData('text/plain');
    dragFrom = null;
    if (!from) return;
    try {
      const out = await api('/api/rules/move', { method: 'POST', body: { from, toDir } });
      if (S.rulesDir && out.path && !out.path.includes('/')) setRulesDir('');
      await loadRules();
      toast('已移动到 ' + (toDir || '根目录'));
    } catch (err) {
      toast('移动失败：' + err.message);
    }
  };

  box.onclick = async (e) => {
    if (e.target.closest('[data-tree-input]')) return; /* 输入框内的点击不触发选中 */
    const caret = e.target.closest('[data-caret]');
    if (caret) {
      const p = caret.getAttribute('data-caret');
      if (S.rulesTreeOpen.has(p)) S.rulesTreeOpen.delete(p);
      else S.rulesTreeOpen.add(p);
      localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
      renderTree();
      return;
    }
    const op = e.target.closest('[data-op]');
    const row = e.target.closest('.rt-row');
    if (op && row) {
      e.stopPropagation();
      if (op.dataset.op === 'menu') {
        const r = op.getBoundingClientRect();
        openTreeRowMenu(row, r.left, r.bottom);
      } else await treeOp(op.dataset.op, row);
      return;
    }
    if (!row) return;
    /* 双击文件名 = 改名，所以单击文件名先挂起一个双击间隔；点图标/缩进/空白仍然即时打开 */
    if (e.target.closest('.rt-label') && isTreeFileRow(row)) {
      clearTimeout(treeClickTimer);
      treeClickTimer = setTimeout(() => {
        treeClickTimer = null;
        activateTreeRow(row);
      }, TREE_DBLCLICK_MS);
      return;
    }
    activateTreeRow(row);
  };

  /* 双击文件名就地改名（文件管理器里最基本的动作）；双击图标/缩进/空白则是打开 */
  box.ondblclick = (e) => {
    if (e.target.closest('[data-tree-input]') || e.target.closest('[data-caret]')) return;
    const row = e.target.closest('.rt-row');
    if (!row || !isTreeFileRow(row)) return;
    e.preventDefault();
    clearTimeout(treeClickTimer);
    treeClickTimer = null;
    if (e.target.closest('.rt-label')) startTreeRename(row.dataset.path, row.dataset.name);
    else activateTreeRow(row);
  };

  /* 行内输入：边打字边同步状态，回车提交 / Esc 取消 / 失焦提交 */
  box.oninput = (e) => {
    const el = e.target.closest('[data-tree-input]');
    if (!el) return;
    if (S.treeDraft) S.treeDraft.value = el.value;
    else if (S.treeRenaming) S.treeRenaming.value = el.value;
  };

  box.onfocusout = (e) => {
    const el = e.target.closest('[data-tree-input]');
    if (!el) return;
    if (S.treeCommitting) return;
    /* 焦点移到树内的另一个元素（比如刚提交后重新聚焦行）不算「离开」 */
    const next = e.relatedTarget;
    if (next && box.contains(next) && next.closest('[data-tree-input]')) return;
    commitTreeEditor();
  };

  box.oncontextmenu = (e) => {
    const row = e.target.closest('.rt-row');
    e.preventDefault();
    if (!row) {
      /* 空白处右键 = 根目录：新建 / 粘贴到根目录 */
      openTreeRootMenu(e.clientX, e.clientY);
      return;
    }
    openTreeRowMenu(row, e.clientX, e.clientY);
  };

  /* 键盘可达：↑↓ 移动、→← 展开折叠、Enter 打开、F2 重命名、Delete 删除，
   * 以及文件管理器那套 ⌘/Ctrl + C / X / V */
  box.onkeydown = (e) => {
    const input = e.target.closest('[data-tree-input]');
    if (input) {
      if (e.key === 'Enter') { e.preventDefault(); commitTreeEditor(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelTreeEditor(); }
      return;
    }
    const rows = [...box.querySelectorAll('.rt-row')].filter((r) => r.offsetParent !== null);
    const cur = e.target.closest('.rt-row');
    const i = cur ? rows.indexOf(cur) : -1;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && cur) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); treeOp('copy', cur); return; }
      if (k === 'x') { e.preventDefault(); treeOp('cut', cur); return; }
      if (k === 'v') { e.preventDefault(); treeOp('paste', cur); return; }
      if (k === 'd') { e.preventDefault(); treeOp('duplicate', cur); return; }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) next.focus();
      return;
    }
    if (!cur) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateTreeRow(cur);
      return;
    }
    if (e.key === 'ArrowRight' && cur.dataset.type === 'dir') {
      e.preventDefault();
      if (!S.rulesTreeOpen.has(cur.dataset.path)) {
        S.rulesTreeOpen.add(cur.dataset.path);
        localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
        renderTree();
        focusTreePath(cur.dataset.path);
      }
      return;
    }
    if (e.key === 'ArrowLeft' && cur.dataset.type === 'dir') {
      e.preventDefault();
      if (S.rulesTreeOpen.has(cur.dataset.path)) {
        S.rulesTreeOpen.delete(cur.dataset.path);
        localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
        renderTree();
        focusTreePath(cur.dataset.path);
      } else {
        const parent = cur.dataset.path.split('/').slice(0, -1).join('/');
        if (parent) focusTreePath(parent);
      }
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); treeOp('rename', cur); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); treeOp('del', cur); }
  };
}

function focusTreePath(p) {
  const box = $('#rulesTree');
  if (!box) return;
  const el = [...box.querySelectorAll('.rt-row')].find((r) => r.dataset.path === p);
  if (el) el.focus();
}

/* ------------------------------------------------- 行内命名（新建 / 改名） */

/** 规则的绝对路径：复制路径、贴到终端或编辑器里直接用 */
function treeAbsPath(rel) {
  const rootAbs = (S.rulesTreeData && S.rulesTreeData.rootAbs) || '';
  const p = String(rel || '');
  if (!p) return rootAbs;
  return rootAbs ? rootAbs + '/' + p : p;
}

function startTreeRename(path, name) {
  S.treeDraft = null;
  S.treeRenaming = { path, value: name || path.split('/').pop() };
  renderTree();
  focusTreeEditor();
}

/** 新建：dir = 落点文件夹，type = 'dir' 文件夹 / 'rule' 文件（规则文件） */
function startTreeDraft(dir, type) {
  S.treeRenaming = null;
  const d = dir || '';
  if (d && !S.rulesTreeOpen.has(d)) {
    S.rulesTreeOpen.add(d);
    localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
  }
  S.treeDraft = { dir: d, type: type === 'dir' ? 'dir' : 'rule', value: '' };
  renderTree();
  focusTreeEditor();
}

function cancelTreeEditor() {
  if (!S.treeDraft && !S.treeRenaming) return;
  S.treeDraft = null;
  S.treeRenaming = null;
  renderTree();
}

/** 提交当前行内输入（新建或改名）；失焦、回车都走这里 */
async function commitTreeEditor() {
  if (S.treeCommitting) return;
  const draft = S.treeDraft;
  const ren = S.treeRenaming;
  if (!draft && !ren) return;
  /* 从 DOM 兜底取值：输入过程中可能没触发 input 事件（比如输入法直接上屏） */
  const box = $('#rulesTree');
  const el = box && box.querySelector('[data-tree-input]');
  const typed = (el ? el.value : (draft || ren).value || '').trim();

  S.treeCommitting = true;
  if (draft) {
    S.treeDraft = null;
  } else {
    S.treeRenaming = null;
  }
  try {
    if (draft) {
      if (!typed) { renderTree(); return; }
      if (draft.type === 'dir') {
        const out = await api('/api/rules/fs', {
          method: 'POST',
          body: { type: 'dir', dir: draft.dir, name: typed },
        });
        if (out && out.path) {
          S.rulesTreeOpen.add(out.path);
          localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
        }
        await loadRules();
        toast('已新建文件夹 ' + typed);
      } else {
        const rule = await api('/api/rules/fs', {
          method: 'POST',
          body: { type: 'rule', dir: draft.dir, name: typed, urlMatch: '' },
        });
        setRulesDir(draft.dir);
        await loadRules();
        toast('已新建规则文件 ' + typed + '.rule.json');
        if (rule && rule.id) {
          const fresh = S.rules.find((r) => r.id === rule.id);
          if (fresh) {
            S.rulesActivePath = fresh.file;
            openRuleFromTree(fresh);
          }
        }
      }
      return;
    }

    const cur = ren.path.split('/').pop();
    if (!typed || typed === cur) { renderTree(); return; }
    const out = await api('/api/rules/move', {
      method: 'POST',
      body: { from: ren.path, newName: typed },
    });
    /* 旧路径下的选中目录与展开态必须一起迁移，否则面包屑指向已不存在的目录 */
    if (S.rulesDir === ren.path || S.rulesDir.startsWith(ren.path + '/')) {
      setRulesDir((out.path || ren.path) + S.rulesDir.slice(ren.path.length));
    }
    const nextOpen = new Set();
    S.rulesTreeOpen.forEach((d) =>
      nextOpen.add(
        d === ren.path || d.startsWith(ren.path + '/')
          ? (out.path || ren.path) + d.slice(ren.path.length)
          : d
      )
    );
    S.rulesTreeOpen = nextOpen;
    localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...nextOpen]));
    if (S.rulesActivePath === ren.path) S.rulesActivePath = out.path || S.rulesActivePath;
    await loadRules();
    toast('已重命名为 ' + typed);
  } catch (err) {
    toast('操作失败：' + err.message);
    renderTree();
  } finally {
    S.treeCommitting = false;
  }
}

/** 树行的就近菜单：⋯ 按钮与右键共用，替代原来只在 hover 出现的 ＋/✎/✕ */
function openTreeRowMenu(row, x, y) {
  const p = row.dataset.path;
  const type = row.dataset.type;
  const name = row.dataset.name || p.split('/').pop();
  const items = [];
  if (type === 'dir') {
    items.push(['new-file', '＋ 新建文件']);
    items.push(['new-dir', '＋ 新建文件夹']);
    items.push(['open', '筛选到此文件夹']);
  } else if (type === 'rule') {
    items.push(['open', '编辑这条规则']);
    items.push(['open-body', '编辑响应体']);
  } else {
    items.push(['open', '编辑响应体']);
  }
  items.push(['sep', '']);
  items.push(['copy', '复制']);
  items.push(['cut', '剪切']);
  /* 粘贴落点：文件夹 = 自己；文件 = 所在文件夹 */
  items.push(['paste', '粘贴到此处']);
  if (type === 'rule' || type === 'dir') items.push(['duplicate', '创建副本']);
  items.push(['sep', '']);
  if (type === 'rule' || type === 'dir') items.push(['rename', '重命名']);
  items.push(['copy-path', '复制路径']);
  items.push(['reveal', revealLabel()]);
  if (type === 'rule' || type === 'dir') {
    items.push(['sep', '']);
    items.push(['del', '删除']);
  }
  showCtxMenu(
    x,
    y,
    `<div class="ctx-title">${esc(name)}</div>` +
      items
        .map(([op, label]) =>
          op === 'sep'
            ? '<div class="ctx-sep"></div>'
            : `<button class="ctx-item" data-rt="${op}" data-rt-path="${esc(p)}" data-rt-type="${type}" data-rt-rule-id="${esc(
                row.dataset.ruleId || row.dataset.id || ''
              )}">${esc(label)}</button>`
        )
        .join('')
  );
}

/** 树空白处（根目录）的就近菜单 */
function openTreeRootMenu(x, y) {
  const items = [
    ['new-file', '＋ 新建文件'],
    ['new-dir', '＋ 新建文件夹'],
    ['sep', ''],
    ['paste', '粘贴到此处'],
    ['sep', ''],
    ['reveal', revealLabel()],
  ];
  showCtxMenu(
    x,
    y,
    '<div class="ctx-title">rules 根目录</div>' +
      items
        .map(([op, label]) =>
          op === 'sep'
            ? '<div class="ctx-sep"></div>'
            : `<button class="ctx-item" data-rt="${op}" data-rt-path="" data-rt-type="root" data-rt-rule-id="">${esc(
                label
              )}</button>`
        )
        .join('')
  );
}

/** 文件管理器名字按平台走：macOS 访达 / Windows 资源管理器 / 其它叫文件管理器 */
function treePlatform() {
  return (S.status && S.status.platform) || '';
}

function revealLabel() {
  const plat = treePlatform();
  if (plat === 'darwin') return '在「访达」中显示';
  if (plat === 'win32') return '在「资源管理器」中显示';
  if (plat === 'linux') return '在文件管理器中显示';
  return '在文件管理器中打开所在位置';
}

function revealDoneText() {
  const plat = treePlatform();
  if (plat === 'darwin') return '已在访达中显示';
  if (plat === 'win32') return '已在资源管理器中定位';
  if (plat === 'linux') return '已在文件管理器中打开所在位置';
  return '已打开所在位置';
}

/** 可改名的树行（文件夹与规则文件）；响应体行和草稿行不参与双击改名 */
function isTreeFileRow(row) {
  const t = row.dataset.type;
  return t === 'dir' || t === 'rule';
}

function activateTreeRow(row) {
  if (row.dataset.type === 'dir') {
    setRulesDir(row.dataset.path);
    /* 单击文件夹顺手展开：不给反馈会让人以为「点不动」 */
    if (!S.rulesTreeOpen.has(S.rulesDir)) {
      S.rulesTreeOpen.add(S.rulesDir);
      localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
    }
    renderRules();
    renderTree();
  } else if (row.dataset.type === 'rule') {
    const rule = S.rules.find((r) => r.id === row.dataset.id);
    if (rule) {
      S.rulesActivePath = row.dataset.path;
      openRuleFromTree(rule);
    }
  } else if (row.dataset.type === 'body') {
    const rule = S.rules.find((r) => r.id === row.dataset.ruleId);
    if (rule) {
      openRuleFromTree(rule, 'body');
      toast('正在编辑响应体（保存后写入 ' + row.dataset.path + '）');
    }
  }
}

/* ------------------------------------------- VSCode 式多标签编辑区 */

function currentRuleTab() {
  return S.ruleTabs.find((t) => t.key === S.activeRuleTab) || null;
}

function ruleTabKey(rule) {
  return rule && rule.id ? 'r:' + rule.id : 'n:' + (++S.ruleTabSeq);
}

/** 打开（或激活）一条规则的标签页：工作区始终留在背景，不再弹第二个窗 */
function openRuleTab(rule, opts) {
  const o = opts || {};
  const r = rule || {};
  const key = ruleTabKey(r);
  let tab = S.ruleTabs.find((t) => t.key === key);
  const existed = !!tab;
  if (!tab) {
    tab = {
      key,
      id: r.id || null,
      data: r,
      name: r.name || '未命名规则',
      dir: r.dir || S.rulesDir || '',
      pane: o.pane || 'match',
      dirty: false,
      fromWorkspace: !!o.fromWorkspace,
    };
    S.ruleTabs.push(tab);
  }
  // 编辑器嵌在工作区里：工作区必须可见。不走 openModal 以免抢焦点。
  if ($('#modalRules').hidden) $('#modalRules').hidden = false;
  if (existed && S.activeRuleTab === key) {
    if (o.pane) { tab.pane = o.pane; switchRuleTab(o.pane); }
    updateWorkspaceChrome();
    return tab;
  }
  if (o.pane) tab.pane = o.pane;
  activateRuleTab(key);
  return tab;
}

/** 切换标签前把当前表单存回内存，未保存的内容不会丢 */
function snapshotActiveTab() {
  const tab = currentRuleTab();
  if (!tab || S.loadingRuleTab || $('#modalRule').hidden) return;
  try {
    tab.data = { ...collectRule(), id: tab.id, dir: tab.dir };
    tab.name = tab.data.name || '未命名规则';
    const on = $('#ruTabs .on');
    tab.pane = on ? on.dataset.rutab : 'match';
  } catch (_) { /* 表单还没挂载好就先不快照 */ }
}

function activateRuleTab(key) {
  if (S.activeRuleTab && S.activeRuleTab !== key && !$('#modalRule').hidden) snapshotActiveTab();
  const tab = S.ruleTabs.find((t) => t.key === key);
  if (!tab) { showRuleWelcome(); return; }
  S.activeRuleTab = key;
  S.loadingRuleTab = true;
  openRuleForm(tab.data, tab.fromWorkspace, { pane: tab.pane });
  // tab.dirty 必须保留：切回来的是「快照里的未保存内容」，不能假装已保存
  renderRuleTabs();
  updateWorkspaceChrome();
}

function markActiveTabDirty() {
  if (S.loadingRuleTab) return;
  const tab = currentRuleTab();
  if (!tab || tab.dirty) return;
  tab.dirty = true;
  renderRuleTabs();
  updateWorkspaceChrome();
}

function renderRuleTabs() {
  const box = $('#ruleTabs');
  if (!box) return;
  box.innerHTML =
    S.ruleTabs
      .map(
        (t) => `<button type="button" class="ws-tab ${t.key === S.activeRuleTab ? 'active' : ''}" data-rt-key="${esc(t.key)}" role="tab" title="${esc(t.name)}.rule.json">
      <span class="fico">◈</span><span class="fname">${esc(t.name)}</span>
      ${t.dirty ? '<span class="dirty" title="未保存"></span>' : ''}
      <span class="x" data-rt-close="${esc(t.key)}" title="关闭标签">✕</span>
    </button>`
      )
      .join('') +
    '<button type="button" class="ws-tab-add" data-rt-add title="新建规则标签">＋</button><span class="fill"></span>';
  const open = $('#wsOpenEditors');
  const list = $('#wsOpenList');
  if (open && list) {
    open.hidden = !S.ruleTabs.length;
    $('#wsOpenCount').textContent = S.ruleTabs.length;
    list.innerHTML = S.ruleTabs
      .map(
        (t) => `<div class="ws-open-item ${t.key === S.activeRuleTab ? 'active' : ''}" data-rt-key="${esc(t.key)}" title="${esc(t.name)}.rule.json">
      <span style="color:var(--mock)">◈</span>
      <span class="oname">${esc(t.name)}.rule.json</span>
      ${t.dirty ? '<span class="dot" title="未保存"></span>' : ''}
      <button type="button" class="x" data-rt-close="${esc(t.key)}" title="关闭标签">✕</button>
    </div>`
      )
      .join('');
  }
}

function showRuleWelcome() {
  S.activeRuleTab = null;
  $('#modalRule').hidden = true;
  const w = $('#ruleWelcome');
  if (w) w.hidden = false;
  renderRuleTabs();
  updateWorkspaceChrome();
}

function closeRuleTab(key, opts) {
  const o = opts || {};
  const idx = S.ruleTabs.findIndex((t) => t.key === key);
  if (idx < 0) return;
  const tab = S.ruleTabs[idx];
  if (tab.dirty && !o.force && !confirm(netTr('还没保存，确定关闭标签？'))) return;
  S.ruleTabs.splice(idx, 1);
  if (S.activeRuleTab === key) {
    S.activeRuleTab = null;
    const next = S.ruleTabs[Math.min(idx, S.ruleTabs.length - 1)];
    if (next) activateRuleTab(next.key);
    else showRuleWelcome();
  } else {
    renderRuleTabs();
  }
  updateWorkspaceChrome();
}

async function closeActiveRuleTab(opts) {
  if (S.activeRuleTab) closeRuleTab(S.activeRuleTab, opts);
  else showRuleWelcome();
  await loadRules();
}

/** 关闭整个编辑器视图（保留名字供旧路径 / 命令面板使用） */
async function closeRuleEditor() {
  S.ruleTabs = [];
  S.activeRuleTab = null;
  S.ruleFromTree = false;
  showRuleWelcome();
  await loadRules();
}

function updateWorkspaceChrome() {
  const tab = currentRuleTab();
  const file = tab ? tab.name + '.rule.json' : '';
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('#wsCurrentFile', file);
  const isEn = !!(window.ReqLiteI18N && window.ReqLiteI18N.isEn());
  const tabUnit = isEn ? (S.ruleTabs.length === 1 ? 'tab' : 'tabs') : '个标签';
  set('#wsStatusTabs', S.ruleTabs.length + ' ' + tabUnit);
  set('#wsStatusDir', S.rulesDir ? '📁 ' + S.rulesDir : netTr('全部规则'));
  set('#wsStatusSave', tab && tab.dirty ? netTr('● 未保存') : netTr('手动保存'));
  set('#wsSideCount', S.rules.length + ' ' + netTr('条规则'));
  const crumbs = $('#ruleBreadcrumb');
  if (crumbs) {
    const parts = [netTr('规则')].concat(tab && tab.dir ? tab.dir.split('/') : [], file ? [file] : []);
    crumbs.innerHTML = parts
      .map((p, i) => (i ? '<span class="sep">›</span>' : '') + (i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<span>${esc(p)}</span>`))
      .join('');
  }
  const w = $('#ruleWelcome');
  if (w) w.hidden = !!tab;
  if (!tab) $('#modalRule').hidden = true;
}

/** 打开规则工作区 */
async function openRuleWorkspace() {
  await loadRules();
  openModal('#modalRules');
  updateWorkspaceChrome();
}

/** 从规则工作区打开：直接在右侧开标签，工作区（树 / 目录 / 搜索）原样留在背景 */
function openRuleFromTree(rule, tab) {
  return openRuleTab(rule || {}, { fromWorkspace: true, pane: tab });
}

function newRuleInDir(dir) {
  setRulesDir(dir || '');
  if (dir && !S.rulesTreeOpen.has(dir)) {
    S.rulesTreeOpen.add(dir);
    localStorage.setItem('reqlite-rule-dirs', JSON.stringify([...S.rulesTreeOpen]));
  }
  openRuleFromTree(null);
}

/** 新建文件夹：行内输入名字（桌面端没有 window.prompt，不能再用弹窗） */
async function newDirIn(dir) {
  startTreeDraft(dir || '', 'dir');
}

/** 新建文件（规则文件，落盘为 *.rule.json）：行内输入名字 */
async function newFileIn(dir) {
  startTreeDraft(dir || '', 'rule');
}

async function treeOp(op, row) {
  const p = row.dataset.path;
  const type = row.dataset.type;
  /* 新建/粘贴的落点：文件夹就是自己，其它取所在文件夹 */
  const targetDir = type === 'dir' ? p : p.split('/').slice(0, -1).join('/');
  const name = row.dataset.name || p.split('/').pop();
  try {
    if (op === 'new-rule') {
      newRuleInDir(targetDir);
    } else if (op === 'new-file') {
      newFileIn(targetDir);
    } else if (op === 'new-dir') {
      await newDirIn(targetDir);
    } else if (op === 'open') {
      activateTreeRow(row);
    } else if (op === 'open-body') {
      const rule = S.rules.find((r) => r.id === (row.dataset.ruleId || row.dataset.id));
      if (rule) openRuleFromTree(rule, 'body');
    } else if (op === 'copy' || op === 'cut') {
      S.rulesClip = { mode: op, path: p };
      toast((op === 'copy' ? '已复制 ' : '已剪切 ') + name);
    } else if (op === 'duplicate') {
      /* 副本落在同级：文件 = 它所在的文件夹，文件夹 = 它的父目录（不能复制进自己） */
      const parentDir = p.split('/').slice(0, -1).join('/');
      await pasteTreeItem(p, type === 'dir' ? parentDir : targetDir, 'copy');
    } else if (op === 'paste') {
      if (!S.rulesClip) return toast('剪贴板是空的：先复制或剪切一个文件 / 文件夹');
      /* 剪切粘贴到原位置等于什么都没做，别白跑一趟 */
      if (S.rulesClip.mode === 'cut' && (S.rulesClip.path || '').split('/').slice(0, -1).join('/') === targetDir) {
        return toast('已经在「' + (targetDir || '根目录') + '」里了');
      }
      await pasteTreeItem(S.rulesClip.path, targetDir, S.rulesClip.mode);
    } else if (op === 'copy-path') {
      await copyText(treeAbsPath(p), '已复制路径：' + treeAbsPath(p));
    } else if (op === 'reveal') {
      await api('/api/rules/reveal', { method: 'POST', body: { path: p } });
      toast(revealDoneText());
    } else if (op === 'rename') {
      startTreeRename(p, name);
    } else if (op === 'del') {
      const kids = type === 'dir' ? '文件夹里的全部规则' : '这条规则';
      if (!confirm(`确定删除「${p}」？\n将删除${kids}，不可恢复。`)) return;
      await api('/api/rules/file?path=' + encodeURIComponent(p), { method: 'DELETE' });
      if (S.rulesDir && (S.rulesDir === p || S.rulesDir.startsWith(p + '/'))) setRulesDir('');
      await loadRules();
      toast('已删除');
    }
  } catch (err) {
    toast('操作失败：' + err.message);
  }
}

/** 把树里的某个文件/文件夹放到 targetDir 里：copy = 复制一份，cut = 移动 */
async function pasteTreeItem(from, targetDir, mode) {
  const name = from.split('/').pop();
  if (mode === 'cut') {
    await api('/api/rules/move', { method: 'POST', body: { from, toDir: targetDir } });
    await loadRules();
    toast('已移动到 ' + (targetDir || '根目录'));
    return;
  }
  const out = await api('/api/rules/copy', { method: 'POST', body: { from, toDir: targetDir } });
  await loadRules();
  const base = (out && out.path ? out.path.split('/').pop() : name);
  toast('已粘贴 ' + base);
  if (out && out.path) {
    S.rulesActivePath = out.type === 'rule' ? out.path : S.rulesActivePath;
    focusTreePath(out.path);
  }
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
  renderDock();
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

  const stateSummary = $('#lpStateSummary');
  if (stateSummary) {
    // 写整句而不是模板拼接：i18n 字典按整句精确匹配，切英文时才不会半翻译
    const summaryText = st.ours
      ? (trust && trust.trusted === false ? '已接管 · 根证书未信任' : '已接管 · 正常')
      : (trust && trust.trusted === false ? '未接管 · 根证书未信任' : '未接管 · 正常');
    stateSummary.textContent = st.error ? st.error : summaryText;
  }

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

/* ------------------------------------- 控制坞（系统代理 / Mock / 弱网 / 抓包） */

function dockLanAddr() {
  const st = S.status || {};
  const lan = Array.isArray(st.lan) && st.lan.length ? st.lan[0] : '127.0.0.1';
  return `${lan}:${st.proxyPort || '—'}`;
}

/** 控制坞只读 S 里已有的状态重绘，不自己发请求；数据变化点各自负责调用 */
function renderDock() {
  const st = S.status || {};
  const lp = S.localProxy || {};
  const ours = Boolean(lp.ours);
  const safeMode = ours && Boolean(lp.safeMode);
  const dot = $('#dockProxyDot');
  if (dot) dot.className = 'dock-dot' + (safeMode ? ' warn' : ours ? ' on' : '');
  const txt = $('#dockProxyText');
  if (txt) {
    txt.textContent = ours
      ? (safeMode ? `已接管 ${dockLanAddr()} · HTTPS 透传` : `已接管 ${dockLanAddr()}`)
      : '未接管本机代理';
  }
  $('#dockProxy').title = ours
    ? '点击释放本机系统代理'
    : '点击接管本机系统代理';

  // Mock 总开关：徽章 = 已启用规则数
  const mockOn = S.mockEnabled !== false;
  const mockEnabledRules = (S.rules || []).filter((r) => r.enabled !== false).length;
  $('#dockMock').classList.toggle('on', mockOn);
  const mb = $('#dockMockCount');
  mb.hidden = !mockOn || mockEnabledRules === 0;
  mb.textContent = String(mockEnabledRules);

  // 弱网模拟：徽章 = 生效规则数（关闭时归零，与顶栏 netCount 口径一致）
  const sim = currentNetSim();
  const netN = sim.enabled ? sim.rules.filter((r) => r.match).length : 0;
  $('#dockNet').classList.toggle('on', sim.enabled && netN > 0);
  // 一键全局模式：两个按钮各自只在自己那个模式生效时点亮，避免「点了断网却亮弱网」
  const globalRule = sim.enabled ? sim.rules.find((r) => r.match === '*') : null;
  $('#dockNet').classList.toggle('weak-on', !!globalRule && globalRule.mode === 'weak');
  const off = $('#dockOffline');
  if (off) off.classList.toggle('on', !!globalRule && globalRule.mode === 'offline');
  const nb = $('#dockNetCount');
  nb.hidden = netN === 0;
  nb.textContent = String(netN);

  // 抓包暂停 / 继续
  const paused = st.capture === false;
  $('#dockPause').classList.toggle('paused', paused);
  $('#dockPauseText').textContent = paused ? '继续' : '暂停';
}

function bindDock() {
  $('#dockProxy').addEventListener('click', (e) => {
    if (e.target.closest('#dockProxyEdit')) return;
    toggleLocalProxy();
  });
  $('#dockProxyEdit').addEventListener('click', (e) => {
    e.stopPropagation();
    openConnect(1);
  });
  $('#dockMock').addEventListener('click', async () => {
    const next = !(S.mockEnabled !== false);
    try {
      const cfg = await api('/api/config', { method: 'PUT', body: { mockEnabled: next } });
      S.mockEnabled = cfg.mockEnabled !== false;
      renderDock();
      toast(S.mockEnabled ? 'Mock 已开启' : 'Mock 已关闭：所有规则临时旁路，规则内容不受影响');
    } catch (err) {
      toast('操作失败: ' + err.message);
    }
  });
  // 右键（或触控板双指点击）直达设置面板
  $('#dockMock').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    $('#btnRules').click();
  });
  $('#dockNet').addEventListener('click', () => toggleDockSim('weak'));
  $('#dockOffline').addEventListener('click', () => toggleDockSim('offline'));
  for (const id of ['#dockNet', '#dockOffline']) {
    $(id).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openNetwork();
    });
  }
  $('#dockPause').addEventListener('click', () => $('#capture').click());
  $('#dockClear').addEventListener('click', () => $('#btnClear').click());
}

/* ------------------------------------- 根证书档案 / 一键信任 / .p12 备份
 * 状态自己检测、安装自己执行、档案固定不随覆盖安装重建。 */

function fmtCaFingerprint(fp) {
  const s = String(fp || '').replace(/[^0-9A-Fa-f]/g, '');
  return s ? (s.match(/.{1,4}/g) || []).join(' ').toUpperCase() : '—';
}

function renderCaStatus(arc, trust) {
  const shield = $('#caShield');
  if (!shield) return;
  const t = trust || {};
  const supported = t.supported !== false;
  const state = !supported ? 'unknown' : t.trusted === true ? 'on' : 'off';
  shield.className = 'ca-shield ' + state;
  shield.textContent = state === 'on'
    ? '● 根证书已信任'
    : state === 'unknown' ? '● 无法自动检测' : '● 根证书未信任';
  $('#caShieldHint').textContent = state === 'on'
    ? '本机已信任，覆盖安装不会换证书'
    : state === 'unknown' ? '当前平台请用下面的手动命令'
      : '点「一键安装并信任」，或展开下面的手动命令';
  $('#caFingerprint').textContent = fmtCaFingerprint((arc && arc.fingerprint) || t.sha1);
  $('#caArchivePath').textContent = (arc && arc.archivePath) || t.caPath || '—';
  const src = arc && arc.source;
  $('#caSource').textContent = src === 'generated'
    ? '首次生成'
    : src === 'migrated' ? '从旧目录迁移'
      : src === 'archive' || src === 'files' ? '复用已有档案' : '—';
  const stale = ((arc && arc.keychain && arc.keychain.stale) || []).length;
  const staleTip = $('#caStaleTip');
  if (staleTip) {
    staleTip.hidden = !(stale > 0);
    staleTip.textContent = stale > 0
      ? `钥匙串里还有 ${stale} 张旧根证书，本机当前用的是上面这份档案。`
      : '';
  }
  const install = $('#btnCaInstall');
  if (install) install.disabled = state === 'on';
}

/** 证书状态卡加载：archive 与 ca-trust 任何一侧失败都不能把卡片卡在「检查中」。
 *  覆盖安装后的首次打开，主进程可能被钥匙串 / 网络探测子进程阻塞较久，
 *  请求失败或超时（15s）都会自动重试，最终失败时给出明确提示而不是永远转圈。 */
let caStatusRetryTimer = null;
async function loadCaStatus(attempt = 0) {
  clearTimeout(caStatusRetryTimer);
  const opt = { signal: AbortSignal.timeout(15000) };
  const [arcR, trustR] = await Promise.allSettled([
    api('/api/ca/archive', opt),
    api('/api/ca-trust', opt),
  ]);
  const arc = arcR.status === 'fulfilled' ? arcR.value : null;
  const trust = trustR.status === 'fulfilled' ? trustR.value : null;
  // 任何一侧成功就先渲染 —— 缺的一侧由重试补齐
  if (arc || trust) renderCaStatus(arc, trust);
  if (arc && trust) return { arc, trust };
  if (attempt < 3) {
    caStatusRetryTimer = setTimeout(() => { loadCaStatus(attempt + 1); }, [1500, 3000, 6000][attempt]);
    return { arc, trust, pending: true };
  }
  const shield = $('#caShield');
  if (shield && !arc && !trust) {
    shield.className = 'ca-shield off';
    shield.textContent = '● 自动检测失败';
  }
  const hint = $('#caShieldHint');
  if (hint && (!arc || !trust)) hint.textContent = '自动检测失败，点「重新检测」重试；仍不行请重启 iReq';
  return { arc, trust };
}

/** 一键安装：服务端真的执行 add-trusted-cert，再 verify-cert 回读；失败降级到手动命令 */
async function installCaTrust() {
  const btns = [$('#btnCaInstall'), $('#lpInstallTrust')].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; b.textContent = '安装中…'; });
  try {
    const t = await api('/api/ca-trust', { method: 'POST', body: { action: 'install' } });
    S.localProxy = { ...(S.localProxy || {}), caTrust: t, safeMode: t.safeMode };
    S.status = { ...(S.status || {}), caTrust: t, safeMode: t.safeMode };
    renderLocalProxy();
    if (t.trusted) toast('根证书已信任，HTTPS 解密已恢复，刷新页面即可看到内容');
    else toast('自动安装未完成：' + ((t.install && t.install.error) || t.reason || '请展开手动命令执行'));
  } catch (err) {
    toast('安装失败: ' + err.message);
  } finally {
    btns.forEach((b) => { b.textContent = '一键安装并信任'; b.disabled = false; });
    await loadCaStatus();
  }
}

async function exportCaP12() {
  try {
    const r = await fetch('/api/ca/p12');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const password = r.headers.get('x-ireq-p12-password') || '';
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ireq-root-ca.p12';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 .p12，导入密码：' + password);
  } catch (err) {
    toast('导出失败: ' + err.message);
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function importCaP12(file) {
  if (!file) return;
  const btn = $('#btnCaImportP12');
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await api('/api/ca/import', {
      method: 'POST',
      body: { p12: bytesToBase64(bytes), password: ($('#caP12Password') || {}).value || '' },
    });
    S.localProxy = { ...(S.localProxy || {}), caTrust: r, safeMode: r.safeMode };
    S.status = { ...(S.status || {}), caTrust: r, safeMode: r.safeMode };
    renderLocalProxy();
    toast(r.trusted ? '已导入 .p12，根证书已恢复' : '已导入 .p12，请点「一键安装并信任」');
  } catch (err) {
    toast('导入失败: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导入 .p12'; }
    await loadCaStatus();
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
    await loadCaStatus();
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

/* 设置统一自动保存：输入停顿 400ms 即落库，关窗/点「完成」时兜底 flush。
 * 语言、主题、字号、自动更新本来就是即时生效的，这样整页语义才一致。 */
var settingsDirty = false;
var settingsSaveTimer = null;

function settingsPayload() {
  return {
    passthrough: $('#stPassthrough')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    mitmPorts: $('#stMitmPorts')
      .value.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
    maxFlows: Number($('#stMax').value) || 2000,
    uaAppMapText: $('#stUaAppMap').value,
    processMap: $('#stProcessMap').checked,
    h2Enabled: $('#stH2').checked,
  };
}

async function saveSettings({ silent = false, close = true } = {}) {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  settingsDirty = false;
  try {
    await api('/api/config', { method: 'PUT', body: settingsPayload() });
    if (close) closeModals();
    if (!silent) toast('设置已保存');
    return true;
  } catch (err) {
    settingsDirty = true; // 下次关窗再试一次，不让失败静默丢改动
    toast('保存失败: ' + err.message);
    return false;
  }
}

function queueSettingsSave() {
  settingsDirty = true;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => saveSettings({ silent: true, close: false }), 400);
}

function flushSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  if (!settingsDirty) return Promise.resolve(true);
  return saveSettings({ silent: true, close: false });
}

/* ---------------------------------------------------------------- MCP 接入 */

/** 拉服务端 MCP 状态：开关 / 端点 / 工具 / 令牌 / 审计（不含任何凭据） */
async function loadMcp() {
  try {
    S.mcp = await api('/api/mcp');
  } catch (err) {
    S.mcp = { enabled: false, tokens: [], tools: [], audit: [], error: err.message };
  }
  renderMcp();
}

function mcpEndpoint() {
  if (S.mcp && S.mcp.endpoint) return S.mcp.endpoint;
  const port = (S.status && S.status.uiPort) || 9091;
  return `http://127.0.0.1:${port}/mcp`;
}

function renderMcp() {
  const badge = $('#mcpBadge');
  if (!badge) return;
  const m = S.mcp || {};
  const tokens = m.tokens || [];
  badge.textContent = m.enabled ? `已开启 · ${tokens.length} 个令牌` : '未开启';
  badge.className = 'lp-badge ' + (m.enabled ? 'on' : '');
  $('#mcpEnabled').checked = m.enabled === true;
  $('#mcpEndpoint').textContent = mcpEndpoint();
  $('#mcpStdioCmd').textContent = `ireq mcp --url ${mcpEndpoint()} --token <TOKEN>`;
  $('#mcpTransport').textContent = m.transport === 'streamable-http' ? 'Streamable HTTP' : m.transport || '';
  $('#mcpTokenCount').textContent = `${tokens.length} 个令牌`;
  $('#mcpTokenCount').className = 'lp-badge ' + (tokens.length ? 'on' : '');
  renderMcpTokens(tokens);
  renderMcpAudit(m.audit || []);
  renderMcpTools(m.tools || []);
}

function renderMcpTokens(tokens) {
  const box = $('#mcpTokens');
  if (!box) return;
  if (!tokens.length) {
    box.innerHTML = '<div class="mcp-empty">还没有令牌。生成一个之后，AI 客户端才能调用</div>';
    return;
  }
  box.innerHTML = tokens
    .map((t) => {
      const scope = t.scopes.includes('write') ? '读写' : '只读';
      const used = t.lastUsedAt ? timeAgo(t.lastUsedAt) : '从未使用';
      return `<div class="mcp-token-row" data-id="${esc(t.id)}">
        <span class="mcp-token-name">${esc(t.name)}</span>
        <code class="mcp-token-key" data-no-i18n>${esc(t.masked)}</code>
        <span class="lp-badge ${t.scopes.includes('write') ? 'on' : ''}">${scope}</span>
        <span class="mcp-token-meta">${used} · 调用 ${t.calls || 0} 次</span>
        <button type="button" class="btn ghost mcp-revoke" data-revoke="${esc(t.id)}" title="让这个令牌立刻失效">撤销</button>
      </div>`;
    })
    .join('');
}

function renderMcpAudit(rows) {
  const box = $('#mcpAudit');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<div class="mcp-empty">还没有调用记录。AI 客户端第一次调工具后会出现在这里</div>';
    return;
  }
  box.innerHTML = rows
    .map(
      (r) => `<div class="mcp-audit-row ${r.ok ? '' : 'bad'}">
        <span class="mcp-audit-time">${esc(timeClock(r.at))}</span>
        <span class="mcp-audit-tool">${esc(r.tool || r.method || '—')}</span>
        <span class="mcp-audit-token">${esc(r.token || '（无效令牌）')}</span>
        <span class="mcp-audit-ms">${r.ok ? r.ms + 'ms' : '失败'}</span>
      </div>`
    )
    .join('');
}

function renderMcpTools(tools) {
  const box = $('#mcpTools');
  if (!box) return;
  const count = $('#mcpToolCount');
  if (count) count.textContent = `${tools.length} 个工具`;
  box.innerHTML = tools
    .map(
      (t) => `<div class="mcp-tool-row">
        <code data-no-i18n>${esc(t.name)}</code>
        <span class="mcp-tool-title">${esc(t.title || '')}</span>
        <span class="lp-badge ${t.scope === 'write' ? 'on' : ''}">${t.scope === 'write' ? '读写' : '只读'}</span>
      </div>`
    )
    .join('');
}

function timeClock(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}

async function createMcpToken() {
  const name = ($('#mcpTokenName').value || '').trim();
  const scopes = $('#mcpTokenScope').value === 'read' ? 'read' : 'readwrite';
  try {
    const out = await api('/api/mcp/tokens', { method: 'POST', body: { name, scopes } });
    S.mcp = out;
    S.mcpSnippet = JSON.stringify(out.snippet ? out.snippet.http : {}, null, 2);
    $('#mcpTokenName').value = '';
    renderMcp();
    /* 明文只在这个响应里出现一次，界面上必须立刻展示并提醒复制 */
    $('#mcpSecret').hidden = false;
    $('#mcpSecretValue').textContent = out.token || '—';
    $('#mcpSnippet').textContent = S.mcpSnippet;
    toast('令牌已生成，只显示这一次');
  } catch (err) {
    toast('生成失败：' + err.message);
  }
}

async function revokeMcpToken(id) {
  if (!id) return;
  try {
    const out = await api('/api/mcp/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
    S.mcp = out;
    renderMcp();
    toast('令牌已撤销');
  } catch (err) {
    toast('撤销失败：' + err.message);
  }
}

function bindMcp() {
  const on = (sel, ev, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(ev, fn);
  };
  on('#mcpEnabled', 'change', async (e) => {
    try {
      S.mcp = await api('/api/mcp', { method: 'PUT', body: { enabled: e.target.checked } });
      renderMcp();
      toast(e.target.checked ? 'MCP 已开启' : 'MCP 已关闭');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast('切换失败：' + err.message);
    }
  });
  on('#mcpNewToken', 'click', createMcpToken);
  on('#mcpTokenName', 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createMcpToken();
    }
  });
  on('#mcpCopyEndpoint', 'click', () => copyText(mcpEndpoint(), '已复制 MCP 地址'));
  on('#mcpCopyStdio', 'click', () =>
    copyText(`ireq mcp --url ${mcpEndpoint()} --token <TOKEN>`, '已复制 stdio 启动命令')
  );
  on('#mcpCopySecret', 'click', () => {
    const v = $('#mcpSecretValue').textContent;
    if (v && v !== '—') copyText(v, '已复制令牌（只此一次）');
  });
  on('#mcpCopySnippet', 'click', () => {
    if (S.mcpSnippet) copyText(S.mcpSnippet, '已复制客户端配置');
  });
  on('#mcpClearAudit', 'click', async () => {
    try {
      await api('/api/mcp/audit', { method: 'DELETE' });
      await loadMcp();
      toast('审计记录已清空');
    } catch (err) {
      toast('清空失败：' + err.message);
    }
  });
  const list = $('#mcpTokens');
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-revoke]');
      if (btn) revokeMcpToken(btn.getAttribute('data-revoke'));
    });
  }
}

/** 设置页显示 data 目录占用：flows 攒多了很占地方，用户不会自己去访达里数文件 */
async function renderDiskUsage() {
  const el = $('#stDiskUsage');
  if (!el) return;
  try {
    const cfg = await api('/api/config');
    const du = cfg && cfg.diskUsage;
    el.textContent = du ? `数据目录占用 ${fmtSize(du.bytes)} · ${du.files} 个文件` : '数据目录占用 —';
  } catch {
    el.textContent = '数据目录占用 —';
  }
}

async function openSettings() {
  // 打开时用服务端值覆盖输入框；直接赋值不触发 input，不会误判成用户改动
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  settingsDirty = false;
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
  loadLocalProxy();
  loadMcp();
  $('#stMax').value = st.store ? st.store.maxFlows : 2000;
  $('#stH2').checked = st.h2Enabled !== false;
  renderDiskUsage();
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

/* ---------------------------------------------------------------- 事件 */

function bind() {
  // 弹窗焦点陷阱：Tab 只在最上层弹窗里循环，关闭后焦点回到打开前的位置
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab') return;
      const open = $$('.modal').filter((m) => !m.hidden);
      if (!open.length) return;
      const modal = open[open.length - 1];
      const items = focusableIn(modal);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!modal.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    true
  );

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
    const dismiss = e.target.closest('[data-tls-dismiss]');
    if (dismiss) {
      dismissTlsFailure(dismiss.dataset.tlsDismiss);
      return; // 别顺手选中这条马上要消失的诊断行
    }
    const row = e.target.closest('.row');
    if (row) selectFlow(row.dataset.id);
  });
  $('#list').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    openRowMenu(e.clientX, e.clientY, row.dataset.id);
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
    const nd = e.target.closest('[data-net-app]');
    if (nd) {
      e.stopPropagation();
      openNetModeMenu(e, 'app:' + nd.dataset.netApp, nd.dataset.netApp);
      return;
    }
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
      // 应用维度现在是数组；老书签存的是单个字符串，归一一下
      if (typeof S.filter.app === 'string') S.filter.app = S.filter.app ? [S.filter.app] : [];
      if (!Array.isArray(S.filter.app)) S.filter.app = [];
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
    if (e.target.closest('#btnFilterMore')) {
      toggleMoreMenu('filter');
      return;
    }
    const btn = e.target.closest('button[data-status], button[data-mocked]');
    if (!btn) return;
    $$('#filters button[data-status], #filters button[data-mocked]').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    S.filter.status = btn.dataset.status || '';
    S.filter.mocked = btn.dataset.mocked === '1';
    syncFilterMore();
    if (S.filter.status === 'tls' || S.filter.status === 'error' || S.filter.mocked)
      toggleMoreMenu('filter', false);
    // 握手失败是连接层诊断，不在 flow store 里，后端不认这个筛选值
    if (S.filter.status === 'tls') {
      renderList();
      return;
    }
    loadFlows();
  });

  $('#capture').addEventListener('change', async (e) => {
    await api('/api/config', { method: 'PUT', body: { capture: e.target.checked } });
    if (S.status) S.status.capture = e.target.checked;
    renderDock();
    toast(e.target.checked ? '已开始抓包' : '已暂停抓包（代理仍在运行）');
  });

  $('#btnClear').addEventListener('click', async () => {
    // 乐观清空：列表、详情、侧栏（设备 / 应用 / 域名 / 接口）先在同一帧消失，
    // 不等 DELETE 往返，也不等 SSE 广播或 facet 定时器。
    S.tlsFailures = [];
    syncTlsBadge();
    clearFlowsUi({ resetDetail: true });
    try {
      await api('/api/flows', { method: 'DELETE' });
      // 诊断记录也一起清，否则点了「清空」列表里还留着几行
      await api('/api/diagnostics', { method: 'DELETE' }).catch(() => {});
      toast('已清空');
    } catch (err) {
      toast('清空失败: ' + err.message);
      await loadFlows(); // 服务端没清成功，把真实列表拉回来
    }
  });

  $('#btnRules').addEventListener('click', openRuleWorkspace);
  $('#ruNew').addEventListener('click', () => newRuleInDir(S.rulesDir));
  $('#ruSave').addEventListener('click', () => saveRule(false));
  $('#btnCa').addEventListener('click', async () => {
    // 状态卡先渲染，不等 loadStatus（首启时它可能被子进程探测拖慢）
    const caStatusPromise = loadCaStatus();
    const st = await loadStatus();
    const caStatus = await caStatusPromise;
    const a = currentAddr();
    $('#caMobileProxy').textContent = addrFull(a);
    // 用安装页而不是直接甩 .pem：页面里有下载按钮 + 分平台步骤，手机上好操作
    $('#caUrl').textContent = `http://${addrFull(a)}/`;
    $('#caLocalPath').textContent =
      (caStatus && caStatus.arc && caStatus.arc.caCertPath) || st.caPath || 'data/ca/reqlite-ca.pem';
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
    await openConnect(2);
  });
  $('#btnSettings').addEventListener('click', () => openConnect(0));
  $('#btnExport').addEventListener('click', () => exportFlows('har'));
  // 引导弹窗里的反馈入口是外链（系统浏览器打开），页面还留着 → 顺手收掉弹窗
  const wlFeedback = $('#wlFeedback');
  if (wlFeedback) wlFeedback.addEventListener('click', () => closeModals());
  bindNetwork();
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
  $('#lpInstallTrust').addEventListener('click', installCaTrust);
  $('#btnCaInstall').addEventListener('click', installCaTrust);
  $('#btnCaRecheck').addEventListener('click', recheckTrust);
  $('#btnCaExportP12').addEventListener('click', exportCaP12);
  $('#btnCaImportP12').addEventListener('click', () => $('#caP12File').click());
  $('#caP12File').addEventListener('change', (e) => {
    importCaP12(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  ['stPassthrough', 'stMitmPorts', 'stMax', 'stUaAppMap'].forEach((id) =>
    $(`#${id}`).addEventListener('input', queueSettingsSave)
  );
  $('#stProcessMap').addEventListener('change', queueSettingsSave);
  $('#stH2').addEventListener('change', queueSettingsSave);

  /* -------------------------------- 跳过解密管理列表 */
  $('#btnPassthrough').addEventListener('click', () => openPassthrough());
  $('#stManagePassthrough').addEventListener('click', () => openPassthrough());
  $('#ptRefresh').addEventListener('click', async () => {
    await loadPassthrough();
    toast(netTr('列表已刷新'));
  });
  const doPtAdd = async (input) => {
    const value = input.value;
    try {
      await ptAdd(value);
      input.value = '';
    } catch (_) {
      /* ptAdd 里已经提示过 */
    }
    input.focus();
  };
  $('#ptAddBtn').addEventListener('click', () => doPtAdd($('#ptAddInput')));
  $('#ptAddInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    doPtAdd(e.target);
  });
  $('#ptSearch').addEventListener('input', (e) => {
    S.ptSearch = e.target.value;
    renderPassthrough();
  });
  $('#ptCopyAll').addEventListener('click', () => ptCopy(ptRules().join('\n'), ptRules().length));
  $('#ptClearAll').addEventListener('click', ptClearAll);
  $('#ptList').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-pt-rule]');
    const btn = e.target.closest('button');
    if (!row || !btn) return;
    const rule = row.dataset.ptRule;
    if (btn.hasAttribute('data-pt-del')) return ptRemove(rule);
    if (btn.hasAttribute('data-pt-copy')) return ptCopy(rule, 1);
    if (btn.hasAttribute('data-pt-edit')) {
      S.ptEditing = rule;
      renderPassthrough();
      const next = $$('#ptList .pt-row').find((r) => r.dataset.ptRule === rule);
      const input = next && next.querySelector('[data-pt-value]');
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }
    if (btn.hasAttribute('data-pt-cancel')) {
      S.ptEditing = '';
      return renderPassthrough();
    }
    if (btn.hasAttribute('data-pt-save')) {
      const input = row.querySelector('[data-pt-value]');
      const next = normalizePtInput(input ? input.value : '')[0];
      if (!next) return toast(netTr('请输入有效的域名'));
      return ptReplace(rule, next);
    }
  });
  $('#ptList').addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-pt-value]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = e.target.closest('[data-pt-rule]');
      const next = normalizePtInput(e.target.value)[0];
      if (!next) return toast(netTr('请输入有效的域名'));
      ptReplace(row.dataset.ptRule, next);
    } else if (e.key === 'Escape') {
      S.ptEditing = '';
      renderPassthrough();
    }
  });
  const ptChipClick = (e) => {
    const chip = e.target.closest('[data-pt-add]');
    if (!chip) return;
    ptAdd(chip.dataset.ptAdd, chip.dataset.ptSource || 'manager');
  };
  $('#ptPending').addEventListener('click', ptChipClick);
  $('#ptSuggest').addEventListener('click', ptChipClick);

  $('#stSave').addEventListener('click', async () => {
    const dirty = settingsDirty;
    if (dirty) {
      const ok = await saveSettings({ silent: true, close: false });
      if (!ok) return; // 保存失败就留在弹窗里，别把改动悄悄关掉
      toast('设置已保存');
    }
    closeModals();
  });
  // 诊断行详情里的「加入跳过解密 / 查看管理列表」：详情面板会重建，用全局委托
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-block-host]');
    if (btn) return addPassthroughHost(btn.dataset.blockHost);
    if (e.target.closest('[data-pt-open]')) openPassthrough();
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
    if (!confirm(`确定删除规则「${S.editingRule.name || '未命名规则'}」？不可恢复。`)) return;
    await api('/api/rules/' + S.editingRule.id, { method: 'DELETE' });
    if (S.ruleFromTree) await closeActiveRuleTab({ force: true });
    else { closeModals(); await loadRules(); }
    await loadStatus();
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

  $('#rulesSearch').addEventListener('input', () => { renderRules(); renderTree(); });
  $('#rulesImport').addEventListener('click', () => openJsonIO('import'));
  $('#rulesExport').addEventListener('click', () => openJsonIO('export'));
  /* 文件树工具栏：在当前选中目录里新建 */
  $('#rtNewFile').addEventListener('click', () => newFileIn(S.rulesDir));
  $('#rtNewDir').addEventListener('click', () => newDirIn(S.rulesDir));
  $('#rtRefresh').addEventListener('click', async () => {
    try {
      await loadRules();
      toast(S.rulesTreeError ? '扫描完成，但文件树读取失败：' + S.rulesTreeError : '已重新扫描 rules 目录');
    } catch (err) {
      toast('扫描失败：' + err.message);
    }
  });
  $('#rtToggleBody').addEventListener('click', () => {
    S.showRuleBody = !S.showRuleBody;
    localStorage.setItem('reqlite-rule-show-body', S.showRuleBody ? '1' : '0');
    $('#rtToggleBody').setAttribute('aria-pressed', String(S.showRuleBody));
    $('#rulesTree').classList.toggle('hide-body', !S.showRuleBody);
  });
  $('#rtToggleBody').setAttribute('aria-pressed', String(S.showRuleBody));
  $('#ruBackRules').addEventListener('click', () => closeActiveRuleTab());
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
        // 编辑器现在嵌在工作区里面：它内部的点击不能外溢成「关掉整个工作区」。
        if (m.id === 'modalRules' && e.target.closest('#modalRule')) return;
        // 导入/导出只关自己；编辑器 ✕ 只关当前标签；其余弹窗保持「全关」语义。
        if (m.id === 'modalJsonIO') m.hidden = true;
        else if (m.id === 'modalRule' && S.ruleFromTree) closeActiveRuleTab();
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
    applyScale(SCALE_BASE);
    toast('字号已恢复 100%');
  });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const ws = !$('#modalRules').hidden;
    const editing = ws && !$('#modalRule').hidden;
    const key = e.key.toLowerCase();
    if (meta && key === 'k') {
      e.preventDefault();
      openCmdPalette();
    } else if (meta && key === 's' && editing) {
      e.preventDefault();
      saveRule(false);
    } else if (meta && key === 'w' && ws) {
      e.preventDefault();
      if (editing) closeActiveRuleTab();
      else closeModals();
    } else if (meta && /^[1-9]$/.test(e.key) && ws) {
      const t = S.ruleTabs[Number(e.key) - 1];
      if (t) { e.preventDefault(); activateRuleTab(t.key); }
    } else if (e.key === 'Escape') {
      if (closeAllPopups()) {
        e.preventDefault();
        return;
      }
      if (ws) {
        e.preventDefault();
        if (editing) closeActiveRuleTab();
        else closeModals();
        return;
      }
      closeModals();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (document.activeElement === $('#search') || document.activeElement === $('#cmdInput')) return;
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

  bindSimpleUI();
  bindRuleWorkspace();
  bindMcp();

  // 实时流
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'flow') {
      const f = msg.flow;
      // 面板打开期间也让「已模拟 N 条」跟着涨，不用手动刷新
      if (f.simMode && S.status && S.status.stats) {
        S.status.stats.simulated = (S.status.stats.simulated || 0) + 1;
        if (!$('#modalNetwork').hidden) renderNetLive();
      }
      const m = {
        id: f.id,
        ts: f.ts,
        method: f.method,
        url: f.url,
        host: f.host,
        path: f.path,
        scheme: f.scheme,
        httpVersion: f.httpVersion,
        status: f.status,
        pending: !!f.pending,
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
        matchStatusUi(m, S.filter.status) &&
        (!S.filter.mocked || m.mocked) &&
        (!S.filter.app.length || S.filter.app.includes(m.app)) &&
        (!S.filter.host || m.host === S.filter.host) &&
        (!S.filter.route || m.route === S.filter.route) &&
        devMatch &&
        (!S.filter.q || hay.includes(S.filter.q.toLowerCase()));
      if (match) {
        S.flows.unshift(m);
        if (S.flows.length > 800) S.flows.pop();
        // 「握手失败」视图只渲染诊断行，别把新流量插进 DOM
        if (S.filter.status !== 'tls') scheduleFlowAdd(m);
        scheduleFacets();
      }
    } else if (msg.type === 'flow-update') {
      // 两种来源：① 请求完成（占位记录就地补上状态码 / 耗时 / 响应类型）；
      // ② 本机进程名是 lsof 异步查到的。都推的是完整 summary，整行合并即可。
      const f = msg.flow;
      const row = S.flows.find((x) => x.id === f.id);
      if (row) {
        Object.assign(row, f);
        scheduleFlowPatch(row);
      } else if (f.status || f.error) {
        // 进行中的记录当时被筛选挡掉了，完成后可能应该出现 → 按最终状态重拉列表
        loadFlows();
      }
      if (S.selectedId === f.id) {
        // 请求刚完成时详情里才有响应体，自动刷新（保留当前 tab，不打断查看）
        api('/api/flows/' + f.id)
          .then((flow) => {
            if (S.selectedId !== f.id) return;
            S.selected = flow;
            renderDetail();
          })
          .catch(() => {});
      }
      scheduleFacets();
    } else if (msg.type === 'tls-failure') {
      upsertTlsFailure(msg.failure);
    } else if (msg.type === 'tls-remove') {
      // 加入跳过解密 / 握手成功后，服务端把已解决的域名撤掉；所有窗口同步
      removeTlsFailures(msg.hosts || []);
    } else if (msg.type === 'tls-clear') {
      S.tlsFailures = [];
      syncTlsBadge();
      if (String(S.selectedId || '').startsWith(TLS_ROW_PREFIX)) {
        S.selectedId = null;
        S.selected = null;
        $('#detail').innerHTML = detailEmptyHtml;
      }
      scheduleRender();
    } else if (msg.type === 'passthrough') {
      // 别的窗口 / 设置页改了白名单：角标、设置页文本框、管理列表同步
      if (typeof msg.killed === 'number') S.ptLastKilled = msg.killed;
      loadPassthrough();
    } else if (msg.type === 'network-sim') {
      // 别的窗口改了规则：同步角标和侧栏开关；正在输入时不重绘面板，避免打断编辑
      S.networkSim = normalizeNetSim(msg.sim);
      if (typeof msg.killed === 'number') S.lastSimKilled = msg.killed;
      const panel = $('#modalNetwork');
      if (!panel.hidden && !panel.querySelector('input:focus, select:focus')) renderNetPanel();
      else {
        syncNetBadge();
        renderSide();
      }
    } else if (msg.type === 'rules-changed') {
      // 外部改动（AI 客户端走 MCP、或手改了 rules 目录）：文件树与列表同步一次。
      // 不动编辑器里的草稿，避免把用户正在写的内容冲掉。
      if (S.rulesTreeData) loadRules().catch(() => {});
    } else if (msg.type === 'clear') {
      // 别的窗口点了清空：列表和侧栏同步消失，不走 80ms 定时器
      clearFlowsUi();
      scheduleRender();
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

/* -------------------------------------------- 精简交互层：功能不删，只收路径 */

/** 顶栏「更多」与筛选「更多」互斥展开；force 可强制开 / 关 */
function toggleMoreMenu(which, force) {
  const top = which !== 'filter';
  const menu = $(top ? '#moreMenu' : '#filterMoreMenu');
  const trigger = $(top ? '#btnMore' : '#btnFilterMore');
  const other = $(top ? '#filterMoreMenu' : '#moreMenu');
  const otherTrigger = $(top ? '#btnFilterMore' : '#btnMore');
  if (!menu) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  if (open && other) {
    other.hidden = true;
    if (otherTrigger) otherTrigger.setAttribute('aria-expanded', 'false');
  }
  menu.hidden = !open;
  if (trigger) trigger.setAttribute('aria-expanded', String(open));
  // 筛选菜单是 fixed 的（要跳出 .fbar 的横向滚动裁剪），展开前得先算好坐标
  if (open && !top) placeFilterMenu();
  if (open) closeCtxMenu();
}

/** 把筛选「更多」菜单贴到触发器下方；下方放不开就往上翻，左右夹在视口内 */
function placeFilterMenu() {
  const trig = $('#btnFilterMore');
  const menu = $('#filterMoreMenu');
  if (!trig || !menu) return;
  const r = trig.getBoundingClientRect();
  // 先归位再量尺寸，避免用到上一次的位置
  menu.style.left = '0px';
  menu.style.top = '0px';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const pad = 8;
  let left = r.right - mw;
  left = Math.max(pad, Math.min(left, window.innerWidth - mw - pad));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad) {
    const above = r.top - mh - 6;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - mh - pad);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeCtxMenu() {
  const m = $('#ctxMenu');
  if (m) m.hidden = true;
}

/** 关掉所有轻量浮层；返回是否真的关了东西（Esc 用来决定要不要继续关弹窗） */
function closeAllPopups() {
  let closed = false;
  for (const [menuId, triggerId] of [
    ['moreMenu', 'btnMore'],
    ['filterMoreMenu', 'btnFilterMore'],
  ]) {
    const m = $('#' + menuId);
    if (m && !m.hidden) {
      m.hidden = true;
      closed = true;
      const t = $('#' + triggerId);
      if (t) t.setAttribute('aria-expanded', 'false');
    }
  }
  const ctx = $('#ctxMenu');
  if (ctx && !ctx.hidden) {
    ctx.hidden = true;
    closed = true;
  }
  const cmd = $('#cmdBackdrop');
  if (cmd && !cmd.hidden) {
    cmd.hidden = true;
    closed = true;
  }
  return closed;
}

function syncFilterMore() {
  const active = !!(S.filter.mocked || S.filter.status === 'tls' || S.filter.status === 'error');
  const dot = $('#filterMoreDot');
  const trig = $('#btnFilterMore');
  if (dot) dot.hidden = !active;
  if (trig) trig.classList.toggle('on', active);
}

/** 三步连接向导：从「证书」进来直接高亮第 2 步，从「设置」进来常规打开 */
function focusConnectStep(n) {
  $$('.connect-step').forEach((s) => s.classList.remove('focus'));
  const el = document.getElementById('connectStep' + n);
  if (!el) return;
  el.classList.add('focus');
  el.scrollIntoView({ block: 'nearest' });
  setTimeout(() => el.classList.remove('focus'), 2000);
}
async function openConnect(step) {
  await openSettings();
  // 从设置弹窗内部直接切到「信任根证书」时也要刷新状态卡（不只走顶栏证书按钮）
  void loadCaStatus();
  if (step) focusConnectStep(step);
}

/* ------------------------------------------------------------ 就近网络模式 */

function showCtxMenu(x, y, html) {
  const m = $('#ctxMenu');
  if (!m) return;
  m.innerHTML = html;
  m.hidden = false;
  const w = m.offsetWidth || 200;
  const h = m.offsetHeight || 180;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}

function openNetModeMenu(e, match, label) {
  const cur = currentNetSim().rules.find(
    (r) => r.match.toLowerCase() === String(match).toLowerCase()
  );
  const modes = [
    ['normal', '正常'],
    ['weak', '弱网'],
    ['offline', '断网'],
    ['timeout', '超时'],
  ];
  showCtxMenu(
    e.clientX,
    e.clientY,
    `<div class="ctx-title">${esc(label)}</div>` +
      modes
        .map(
          ([m, t]) =>
            `<button class="ctx-item${(cur ? cur.mode : 'normal') === m ? ' on' : ''}" data-net-set="${m}" data-net-match="${esc(match)}">${netTr(t)}</button>`
        )
        .join('') +
      `<div class="ctx-sep"></div><button class="ctx-item" data-cmd="network">${netTr('管理网络规则')}</button>`
  );
}

async function setNetMode(match, mode) {
  const sim = currentNetSim();
  const t = String(match).toLowerCase();
  sim.rules = sim.rules.filter((r) => r.match.toLowerCase() !== t);
  if (mode !== 'normal') {
    sim.rules.push({ id: 'r' + Date.now().toString(36), match, mode });
  }
  sim.enabled = true;
  await putNetSim(sim, true);
  if (!$('#modalNetwork').hidden) renderNetPanel();
  toast(mode === 'normal' ? '已恢复正常网络' : '已切换为' + netTr(NET_MODES[mode] || mode));
}

function openFlowNetMenu(e, f) {
  const hasApp = f.app && f.app !== '未知来源';
  const name = hasApp ? f.app : f.host;
  if (!name) return toast('这条请求没有可识别的应用 / 域名');
  openNetModeMenu(e, (hasApp ? 'app:' : 'host:') + name, name);
}

function openRowMenu(x, y, id) {
  const isTls = String(id).startsWith('tls:');
  const f = isTls
    ? S.tlsFailures.find((t) => 'tls:' + t.host === id)
    : S.flows.find((v) => v.id === id);
  if (!f) return;
  const label = isTls ? f.host : (f.path || f.url || '').slice(0, 46);
  const rows = [];
  if (isTls) {
    rows.push(
      `<button class="ctx-item" data-block-host="${esc(f.host)}">${netTr('加入跳过解密')}</button>`,
      `<button class="ctx-item" data-cmd="passthrough">${netTr('管理跳过解密')}</button>`
    );
  } else {
    rows.push(
      `<button class="ctx-item" data-cmd="replay" data-id="${esc(id)}">${netTr('重放')}</button>`,
      `<button class="ctx-item" data-cmd="quickmock" data-id="${esc(id)}">${netTr('快速 Mock')}</button>`,
      `<button class="ctx-item" data-cmd="curl" data-id="${esc(id)}">${netTr('复制 cURL')}</button>`,
      `<button class="ctx-item" data-cmd="star" data-id="${esc(id)}">${netTr('收藏')}</button>`
    );
  }
  rows.push(
    '<div class="ctx-sep"></div>',
    `<button class="ctx-item" data-cmd="network">${netTr('管理网络规则')}</button>`,
    `<button class="ctx-item" data-cmd="export">${netTr('导出 HAR')}</button>`
  );
  showCtxMenu(x, y, `<div class="ctx-title">${esc(label)}</div>` + rows.join(''));
}

/* ---------------------------------------------------------------- 命令面板 */

const CMD_ITEMS = [
  {
    label: '新建 Mock 规则', hint: '完整编辑器', keys: 'new rule mock 规则 新建',
    run: () => { closeModals(); openRuleTab({}); },
  },
  {
    label: '快速 Mock 当前请求', hint: '选中请求后', keys: 'quick mock 快速 当前请求',
    run: () => { const f = S.selected; if (f && f.kind !== 'tls') openQuickMock(f); else toast('先选一条请求'); },
  },
  {
    label: '查看规则列表', keys: 'rules list 规则 列表',
    run: openRuleWorkspace,
  },
  {
    label: '网络模拟', keys: 'network 网络 断网 弱网 超时', run: () => openNetwork(),
  },
  { label: '导出 HAR', keys: 'export har 导出', run: () => exportFlows('har') },
  {
    label: '连接向导 / 证书', keys: 'connect ca certificate 证书 连接 设置',
    run: () => openConnect(0),
  },
  {
    label: '高级设置', keys: 'settings 设置 高级',
    run: () => { openConnect(0); const d = document.querySelector('.st-advanced'); if (d) d.open = true; },
  },
  { label: '切换主题', keys: 'theme dark light 主题 深色 浅色', run: () => $('#btnTheme').click() },
  { label: '切换语言', keys: 'language english 中文 语言', run: () => $('#btnLang').click() },
  { label: '抓包开 / 关', keys: 'capture 抓包 暂停', run: () => $('#capture').click() },
  { label: '清空流量', keys: 'clear 清空', run: () => $('#btnClear').click() },
];

function cmdItems() {
  const list = CMD_ITEMS.slice();
  for (const a of (S.facets.apps || []).slice(0, 6)) {
    const label = a.label || a.key;
    list.push({
      label: '断网：' + label, hint: '网络模拟', keys: 'offline 断网 ' + a.key + ' ' + label,
      run: () => setNetMode('app:' + a.key, 'offline'),
    });
    list.push({
      label: '弱网：' + label, hint: '网络模拟', keys: 'slow weak 弱网 ' + a.key + ' ' + label,
      run: () => setNetMode('app:' + a.key, 'weak'),
    });
  }
  return list;
}

let cmdResults = [];
let cmdActive = 0;

function renderCmdList(q) {
  const box = $('#cmdList');
  if (!box) return;
  const term = String(q || '').trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  const cmds = cmdItems().filter((c) =>
    words.every((w) => (c.keys + ' ' + c.label).toLowerCase().includes(w))
  );
  const flows = term
    ? S.flows
        .filter((f) => `${f.url} ${f.app || ''} ${f.method} ${f.host || ''}`.toLowerCase().includes(term))
        .slice(0, 8)
    : [];
  cmdResults = [
    ...cmds.map((c) => ({ type: 'cmd', ...c })),
    ...flows.map((f) => ({
      type: 'flow',
      id: f.id,
      label: `${f.method} ${(f.path || f.url || '').slice(0, 66)}`,
      hint: `${f.status || '—'} · ${f.app || f.host || ''}`,
    })),
  ].slice(0, 14);
  cmdActive = Math.min(cmdActive, Math.max(0, cmdResults.length - 1));
  box.innerHTML = cmdResults.length
    ? cmdResults
        .map(
          (r, i) =>
            `<button class="cmd-item${i === cmdActive ? ' on' : ''}" data-cmd-index="${i}">` +
            `<span class="cmd-kind">${r.type === 'flow' ? netTr('请求') : netTr('命令')}</span>` +
            `<span class="cmd-label">${esc(r.label)}</span>` +
            `<span class="cmd-hint">${esc(r.hint || '')}</span></button>`
        )
        .join('')
    : `<div class="cmd-empty">${netTr('没有匹配的命令或请求')}</div>`;
}

function openCmdPalette() {
  closeModals();
  const bd = $('#cmdBackdrop');
  bd.hidden = false;
  $('#cmdInput').value = '';
  cmdActive = 0;
  renderCmdList('');
  $('#cmdInput').focus();
}

async function runCmdIndex(i) {
  const r = cmdResults[i];
  if (!r) return;
  $('#cmdBackdrop').hidden = true;
  if (r.type === 'flow') {
    await selectFlow(r.id);
    const row = $(`.row[data-id="${r.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  await r.run();
}

/* -------------------------------------------------------------- 快速 Mock */

const QK = { rule: null };

function openQuickMock(f) {
  QK.rule = fromFlowRule(f);
  $('#qkName').value = QK.rule.name || '';
  $('#qkStatus').value = QK.rule.status || 200;
  $('#qkDelay').value = QK.rule.delayMs || 0;
  $('#qkBody').value = QK.rule.body || '';
  $('#qkMatchLine').textContent = `匹配 ${f.method} ${f.host || ''}${QK.rule.urlMatch || ''}`;
  openModal('#modalQuick');
}

function quickPayload() {
  const r = QK.rule || {};
  return {
    name: $('#qkName').value.trim() || '未命名规则',
    note: '',
    enabled: true,
    method: r.method || '*',
    host: r.host || '',
    urlMatch: r.urlMatch || '',
    matchMode: 'contains',
    status: Number($('#qkStatus').value) || 200,
    delayMs: Math.max(0, Number($('#qkDelay').value) || 0),
    headers: r.headers || { 'content-type': 'application/json; charset=utf-8' },
    body: $('#qkBody').value,
    bodyType: 'auto',
  };
}

async function saveQuickMock() {
  try {
    await api('/api/rules', { method: 'POST', body: quickPayload() });
    closeModals();
    await loadRules();
    toast('规则已保存，立即生效');
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

function quickToAdvanced() {
  const p = quickPayload();
  closeModals();
  openRuleTab(p);
}

/* ------------------------------------------------ 规则工作区交互绑定 */

function bindRuleWorkspace() {
  const form = $('#modalRule');
  if (form) {
    // 捕获模式：Monaco 的隐藏 textarea 也会触发 input，一并算作「未保存」
    form.addEventListener('input', markActiveTabDirty, true);
    form.addEventListener('change', markActiveTabDirty, true);
  }

  // 标签条与侧栏「打开的编辑器」共用同一套就近操作
  const onTabClick = (e) => {
    const close = e.target.closest('[data-rt-close]');
    if (close) { e.stopPropagation(); closeRuleTab(close.dataset.rtClose); return; }
    if (e.target.closest('[data-rt-add]')) { newRuleInDir(S.rulesDir); return; }
    const tab = e.target.closest('[data-rt-key]');
    if (tab) activateRuleTab(tab.dataset.rtKey);
  };
  $('#ruleTabs').addEventListener('click', onTabClick);
  $('#wsOpenList').addEventListener('click', onTabClick);

  $('#wsActExplorer').addEventListener('click', () => {
    const off = document.documentElement.dataset.wsSidebar === 'off';
    document.documentElement.dataset.wsSidebar = off ? 'on' : 'off';
    $('#wsActExplorer').classList.toggle('on', !!off);
  });
  $('#wsActSearch').addEventListener('click', () => $('#rulesSearch').focus());
  $('#wsActNew').addEventListener('click', () => newRuleInDir(S.rulesDir));
  $('#wsActCmd').addEventListener('click', openCmdPalette);
  $('#wsActHelp').addEventListener('click', () => {
    const d = $('#wsHelp');
    if (d) d.open = !d.open;
  });

  $('#wsQuickNew').addEventListener('click', () => newRuleInDir(S.rulesDir));
  $('#wsQuickImport').addEventListener('click', () => openJsonIO('import'));
  $('#wsQuickExport').addEventListener('click', () => openJsonIO('export'));

  // 目录 / 搜索变化时同步面包屑与状态栏
  $('#rulesSearch').addEventListener('input', updateWorkspaceChrome);
  const panel = $('#modalRules');
  if (panel) panel.addEventListener('click', (e) => {
    if (e.target.closest('#rtCrumbBack')) updateWorkspaceChrome();
  });
}

/* ------------------------------------------------------------ 新交互绑定 */

function bindSimpleUI() {
  $('#btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMoreMenu('top');
  });
  $('#moreMenu').addEventListener('click', (e) => {
    // 外观类按钮可以连续点，不收菜单；打开弹窗的类目点完即收
    const keep = e.target.closest('#fontDown, #fontUp, #fontVal, #btnTheme, #btnLang');
    if (!keep) toggleMoreMenu('top', false);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#moreWrap')) {
      const m = $('#moreMenu');
      if (m && !m.hidden) toggleMoreMenu('top', false);
    }
    if (!e.target.closest('#filterMoreWrap')) {
      const m = $('#filterMoreMenu');
      if (m && !m.hidden) toggleMoreMenu('filter', false);
    }
    if (!e.target.closest('#ctxMenu') && !e.target.closest('[data-net-app], #actNet, [data-op="menu"]')) closeCtxMenu();
  });

  $('#ctxMenu').addEventListener('click', async (e) => {
    const rt = e.target.closest('[data-rt]');
    if (rt) {
      closeCtxMenu();
      await treeOp(rt.dataset.rt, {
        dataset: {
          path: rt.dataset.rtPath,
          type: rt.dataset.rtType,
          id: rt.dataset.rtRuleId,
          ruleId: rt.dataset.rtRuleId,
        },
      });
      return;
    }
    const ns = e.target.closest('[data-net-set]');
    if (ns) {
      closeCtxMenu();
      await setNetMode(ns.dataset.netMatch, ns.dataset.netSet);
      return;
    }
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) {
      const id = cmd.dataset.id;
      const action = cmd.dataset.cmd;
      closeCtxMenu();
      if (id) await selectFlow(id);
      const map = {
        replay: '#actReplay',
        quickmock: '#actMock',
        curl: '#actCurl',
        star: '#actStar',
      };
      if (map[action]) $(map[action])?.click();
      else if (action === 'network') openNetwork();
      else if (action === 'passthrough') openPassthrough();
      else if (action === 'export') exportFlows('har');
    }
  });

  $('#cmdInput').addEventListener('input', (e) => {
    cmdActive = 0;
    renderCmdList(e.target.value);
  });
  $('#cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cmdActive = Math.max(
        0,
        Math.min(cmdResults.length - 1, cmdActive + (e.key === 'ArrowDown' ? 1 : -1))
      );
      renderCmdList($('#cmdInput').value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCmdIndex(cmdActive);
    }
  });
  $('#cmdList').addEventListener('click', (e) => {
    const it = e.target.closest('[data-cmd-index]');
    if (it) runCmdIndex(Number(it.dataset.cmdIndex));
  });
  $('#cmdBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#cmdBackdrop')) $('#cmdBackdrop').hidden = true;
  });

  $('#qkSave').addEventListener('click', saveQuickMock);
  $('#qkAdvanced').addEventListener('click', quickToAdvanced);
  syncFilterMore();
}

async function init() {
  detailEmptyHtml = $('#detail').innerHTML;
  const savedTheme = localStorage.getItem('reqlite-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  /* 字号：用户调过的按所选百分比保留（相对新基准），没调过用新默认（旧默认的 80%） */
  if (!localStorage.getItem(SCALE_MIGRATED)) {
    const storedScale = Number(localStorage.getItem(SCALE_KEY));
    if (Number.isFinite(storedScale) && storedScale > 0) {
      // 旧存值是相对旧基准 1.3 的绝对值 → 换算成用户当时看到的百分比，再套新基准
      localStorage.setItem(SCALE_KEY, String((storedScale / 1.3) * SCALE_BASE));
    }
    localStorage.setItem(SCALE_MIGRATED, '1');
  }
  applyScale(Number(localStorage.getItem(SCALE_KEY)) || SCALE_BASE, false);
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
  bindDock();
  await loadStatus();
  loadLocalProxy(); // 只读探测，不阻塞首屏
  loadCaStatus(); // 预热证书状态卡：用户点开证书页时不用再等检测
  await loadTlsFailures();
  await loadPassthrough(); // 白名单角标 + 管理列表（服务端持久化）
  await loadFlows(); // 内部 renderList 会一并渲染置顶的诊断行
  await loadRules();
  await Promise.all([loadFacets(), loadBookmarks()]);
  renderChips();
  NARROW.addEventListener('change', () => {
    syncSideForViewport();
    applyPaneWidths();
  });
  window.addEventListener('resize', applyPaneWidths);
  // 筛选「更多」是 fixed 定位，窗口缩放或筛选条横向滚动后会和触发器脱钩，直接收起
  window.addEventListener('resize', () => toggleMoreMenu('filter', false));
  $('#filters').addEventListener('scroll', () => toggleMoreMenu('filter', false), { passive: true });
  setInterval(loadStatus, 5000);
  maybeShowWelcome();
}

init();
