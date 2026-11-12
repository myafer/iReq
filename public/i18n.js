/* iReq 界面多语言（zh-CN / en）
 * 思路：字典以「中文原文」为 key，运行时按文本节点/属性精确匹配替换；
 * 动态渲染的内容交给 MutationObserver，带变量的文案走正则模式；
 * 这样不必改动业务代码里的每一处字符串，切换语言也能还原原文。
 */
(function () {
  'use strict';

  var EN = window.ReqLiteI18N_EN || {};
  /* 字典键在采集时被压平了空白，运行时文本节点可能带换行/缩进 → 统一折叠空白后再查 */
  var EN_NORM = {};
  (function () {
    for (var k in EN) {
      if (Object.prototype.hasOwnProperty.call(EN, k)) EN_NORM[k.replace(/\s+/g, ' ').trim()] = EN[k];
    }
  })();
  var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
  var HAN = /[\u4e00-\u9fff]/;
  var KEY = 'reqlite-lang';
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-title'];
  // 代码、报文、编辑器内容与用户数据一律不翻译
  var SKIP = 'script,style,noscript,textarea,pre,code,kbd,svg,.monaco-editor,.json-editor,.body-view,[data-json],[data-no-i18n],[contenteditable="true"]';
  // 详情面板里的键值/报文区域：只做精确字典匹配，绝不做片段替换（避免改写抓到的数据）
  var DATA_AREA = '#detail .dbody, .body-view, [data-json], .jf-children, .jt-leaf, dt, dd, pre, code, textarea, .monaco-editor';

  /* 带变量/数字的动态文案：先按正则整句翻译，避免把变量内容当中文替换 */
  var PATTERNS = [
    // 控制坞：代理状态是动态文本（带 IP:端口），必须整句翻译
    [/^已接管 (.+) · HTTPS 透传$/, function (m, a) { return 'Taking over ' + a + ' · HTTPS passthrough'; }],
    [/^已接管 (.+)$/, function (m, a) { return 'Taking over ' + a; }],
    // 根证书状态卡 / 一键安装 / .p12 备份（带变量，必须整句翻译）
    [/^自动安装未完成：(.+)$/, function (m, a) { return 'Automatic install incomplete: ' + a; }],
    [/^安装失败: (.+)$/, function (m, a) { return 'Install failed: ' + a; }],
    [/^导入失败: (.+)$/, function (m, a) { return 'Import failed: ' + a; }],
    [/^已导出 \.p12，导入密码：(.+)$/, function (m, a) { return 'Exported .p12. Import password: ' + a; }],
    [/^仍未检测到信任：(.+)$/, function (m, a) { return 'Still not trusted: ' + a; }],
    [/^钥匙串里还有 (\d+) 张旧根证书，本机当前用的是上面这份档案。$/,
      function (m, a) { return 'The keychain still holds ' + a + ' old root CA(s); this machine uses the archive above.'; }],
    // 导出反馈：带条数 / 错误原因，必须整句翻译，不能让片段替换译成「已导出 N flows」
    [/^已导出 (\d+) 条$/, function (m, a) { return 'Exported ' + a + ' flows'; }],
    [/^导出失败: (.+)$/, function (m, a) { return 'Export failed: ' + a; }],
    // 握手失败诊断行：次数是动态的，整句翻译才不会把数字后面译成中文
    [/^(\d+) 次握手失败$/, function (m, a) { return a === '1' ? '1 handshake failure' : a + ' handshake failures'; }],
    [/^已让 (.+) 走透传，握手失败记录已清除$/, function (m, a) { return a + ' will now be passed through; handshake failures cleared'; }],
    [/^加入白名单失败: (.+)$/, function (m, a) { return 'Failed to add to allowlist: ' + a; }],
    // 进程识别诊断提示：运行时数字 + 片段替换可能已把「次」变成 requests，两种形态都收
    [/^lsof 快照\s+(\d+)\s*(?:次|requests)?\s*·\s*解析到\s+(\d+)\s*个连接\s*·\s*未命中\s+(\d+)$/,
      function (m, a, b, c) { return 'lsof snapshot: ' + a + ' refreshes · ' + b + ' connections resolved · ' + c + ' misses'; }],
    [/^本机 · (.+)$/, function (m, a) { return 'Local · ' + a; }],
    [/^(.+) · 由 User-Agent 推断$/, function (m, a) { return a + ' · inferred from User-Agent'; }],
    [/^(.+) · 来自本机真实进程$/, function (m, a) { return a + ' · from a real local process'; }],
    [/^(\d+) 条$/, function (m, a) { return a + ' flows'; }],
    [/^(\d+) 项$/, function (m, a) { return a + ' items'; }],
    [/^(\d+) 行$/, function (m, a) { return a + ' lines'; }],
    [/^(\d+) 键$/, function (m, a) { return a + ' keys'; }],
    [/^(\d+) 个响应头$/, function (m, a) { return a + ' response headers'; }],
    // 规则匹配测试器 / 编辑器状态：整句带变量，先翻译外层再递归翻译原因
    [/^✓ 命中 · (.+)$/, function (m, a) { return '✓ Hit · ' + t(a, true); }],
    [/^✕ 不命中 · (.+)$/, function (m, a) { return '✕ No hit · ' + t(a, true); }],
    [/^URL 命中（(.+) 模式）$/, function (m, a) { return 'URL hit (' + a + ' mode)'; }],
    [/^方法不匹配：规则限定 (.+)，测试用的是 (.+)$/, function (m, a, b) { return 'Method mismatch: rule limits to ' + a + ', test used ' + b; }],
    [/^域名不匹配：规则限定 (.+)，测试解析到 (.+)$/, function (m, a, b) { return 'Host mismatch: rule limits to ' + a + ', test resolved to ' + b; }],
    [/^共 (\d+) 项$/, function (m, a) { return a + ' items total'; }],
    [/^共 (\d+) 条规则。可以整段复制、下载成文件，贴到别的机器上一键导入。$/,
      function (m, a) { return 'Total ' + a + ' rules. Copy the whole block, download it as a file, and paste it into another machine to import in one click.'; }],
    [/^确认覆盖 (\d+) 条？（导入 (\d+) 条）$/, function (m, a, b) { return 'Overwrite ' + a + '? (importing ' + b + ')'; }],
    [/^已导入 (\d+) 条规则$/, function (m, a) { return 'Imported ' + a + ' rules'; }],
    [/^行 (\d+) · 列 (\d+)$/, function (m, a, b) { return 'Line ' + a + ' · Column ' + b; }],
    [/^✓ JSON 有效 · (\d+) 个顶层字段 · (\d+) 行$/, function (m, a, b) { return '✓ Valid JSON · ' + a + ' top-level fields · ' + b + ' lines'; }],
    [/^✓ JSON 有效 · (\d+) 条规则$/, function (m, a) { return '✓ Valid JSON · ' + a + ' rules'; }],
    [/^自动 · (.+)$/, function (m, a) { return 'Auto · ' + a; }],
    [/^有新版 v(.+)$/, function (m, a) { return 'New version v' + a + ' available'; }],
    // 网络模拟：规则名与挂起时长是动态的，整句翻译才不会夹中文
    [/^已添加断网规则：(.+)$/, function (m, a) { return 'Added offline rule: ' + a; }],
    [/^已模拟 (\d+) 条请求$/, function (m, a) { return 'Simulated ' + a + ' requests'; }],
    [/^最近变更已切断 (\d+) 条已有连接$/, function (m, a) {
      return 'Last change dropped ' + a + ' existing ' + (a === '1' ? 'connection' : 'connections');
    }],
    [/^iReq 超时模拟：挂起 (\d+)ms 后断开$/, function (m, a) { return 'iReq timeout simulation: held for ' + a + 'ms, then disconnected'; }],
    [/^上次检查失败：(.+)（工具会自动走自家代理重试）$/, function (m, a) { return 'Last check failed: ' + a + ' (will retry automatically)'; }],
    [/^当前 v(.+)，最新 v(.+)，点「前往下载」获取。$/, function (m, a, b) { return 'Current v' + a + ', latest v' + b + '. Click "Download" to get it.'; }],
    [/^当前 v(.+)，已是最新。上次检查 (.+)。$/, function (m, a, b) { return 'Current v' + a + ', up to date. Last checked ' + b + '.'; }],
    [/^已复制 (.+)：(.+)$/, function (m, a, b) { return 'Copied ' + a + ': ' + b; }],
    [/^复制 IP (.+)（Wi-Fi 代理的「服务器」）$/, function (m, a) { return 'Copy IP ' + a + ' (the "Server" field in Wi-Fi proxy settings)'; }],
    [/^复制端口 (.+)（Wi-Fi 代理的「端口」）$/, function (m, a) { return 'Copy port ' + a + ' (the "Port" field in Wi-Fi proxy settings)'; }],
    [/^复制完整地址 (.+)$/, function (m, a) { return 'Copy full address ' + a; }],
    [/^切换地址，当前：(.+)（多网卡 \/ 本机回环）$/, function (m, a) { return 'Switch address, current: ' + a + ' (multiple NICs / loopback)'; }],
    [/^手机 Wi-Fi 代理：服务器 (.+)、端口 (.+)；证书安装页 (.+)$/, function (m, a, b, c) { return 'Phone Wi-Fi proxy: Server ' + a + ', Port ' + b + '; certificate install page ' + c; }],
    [/^重放完成：(.+)$/, function (m, a) { return 'Replay complete: ' + a; }],
    [/^模板 (\d+)$/, function (m, a) { return 'Template ' + a; }],
    [/^已覆盖模板「(.+)」$/, function (m, a) { return 'Template "' + a + '" overwritten'; }],
    [/^已存为模板「(.+)」$/, function (m, a) { return 'Saved as template "' + a + '"'; }],
    [/^已插入「(.+)」模板$/, function (m, a) { return 'Inserted template "' + a + '"'; }],
    [/^方法不匹配：规则限定 (.+)，测试用的是 (.+)$/, function (m, a, b) { return 'Method mismatch: rule requires ' + a + ', test used ' + b; }],
    [/^域名不匹配：规则限定 (.+)，测试解析到 (.+)$/, function (m, a, b) { return 'Host mismatch: rule requires ' + a + ', test resolved to ' + b; }],
    [/^URL 命中（(.+) 模式）$/, function (m, a) { return 'URL matched (' + a + ' mode)'; }],
    [/^ID (.+)… · 规则按顺序匹配，靠前优先$/, function (m, a) { return 'ID ' + a + '… · Rules match in order, earlier ones win'; }],
    [/^只拦截 (.+) 的请求$/, function (m, a) { return 'Only intercept requests to ' + a; }],
    [/^没有匹配「(.+)」的规则$/, function (m, a) { return 'No rules matching "' + a + '"'; }],
    [/^确定删除「(.+)」？\s*将删除(.+)，不可恢复。$/, function (m, a, b) { return 'Delete "' + a + '"? This will also delete ' + b + ' and cannot be undone.'; }],
    [/^插入：(.+)$/, function (m, a) { return 'Insert: ' + a; }],
    [/^延迟 (\d+)ms$/, function (m, a) { return 'Delay ' + a + 'ms'; }],
    [/^搜索：(.+)$/, function (m, a) { return 'Search: ' + a; }],
    [/^(.+) 项$/, function (m, a) { return a + ' items'; }],
    [/^(.+) 行$/, function (m, a) { return a + ' lines'; }],
    [/^(.+) 条$/, function (m, a) { return a + ' flows'; }],
    // 精简交互层：就近网络模式 / 快速 Mock / 命令面板的动态文案（要排在通用「X：Y」之前）
    [/^断网：(.+)$/, function (m, a) { return 'Offline: ' + a; }],
    [/^弱网：(.+)$/, function (m, a) { return 'Slow: ' + a; }],
    [/^匹配 (.+)$/, function (m, a) { return 'Match ' + a; }],
    [/^已切换为(.+)$/, function (m, a) { return 'Switched to ' + a; }],
    // 规则工作区：条数 / 目录 / 路径都是动态的，整句翻译才不会中英夹杂
    [/^共 (\d+) 条规则，匹配 (\d+) 条$/, function (m, a, b) { return a + ' rules total, ' + b + ' matching'; }],
    [/^共 (\d+) 条规则$/, function (m, a) { return a + ' rules total'; }],
    [/^当前文件夹 (\d+) 条 \/ 共 (\d+) 条规则$/, function (m, a, b) { return a + ' in this folder / ' + b + ' total'; }],
    [/^确定删除规则「(.+)」？不可恢复。$/, function (m, a) { return 'Delete rule "' + a + '"? This cannot be undone.'; }],
    [/^扫描完成，但文件树读取失败：(.+)$/, function (m, a) { return 'Scan complete, but the file tree could not be read: ' + a; }],
    [/^文件树读取失败：(.+)$/, function (m, a) { return 'Failed to read the file tree: ' + a; }],
    [/^扫描失败：(.+)$/, function (m, a) { return 'Scan failed: ' + a; }],
    [/^新建失败：(.+)$/, function (m, a) { return 'Create failed: ' + a; }],
    [/^操作失败：(.+)$/, function (m, a) { return 'Operation failed: ' + a; }],
    [/^移动失败：(.+)$/, function (m, a) { return 'Move failed: ' + a; }],
    [/^已新建文件夹 (.+)$/, function (m, a) { return 'Created folder ' + a; }],
    [/^已复制路径：(.+)$/, function (m, a) { return 'Copied path: ' + a; }],
    [/^已移动到 (.+)$/, function (m, a) { return 'Moved to ' + a; }],
    [/^正在编辑响应体（保存后写入 (.+)）$/, function (m, a) { return 'Editing response body (will be written to ' + a + ' on save)'; }],
    [/^(.+)：(.+)$/, function (m, a, b) { return EN[a] ? EN[a] + ': ' + b : m; }],
  ];

  /* 兜底：整句没命中时，替换明显的 UI 片段（不碰代码/数据区） */
  var PARTIALS = [
    ['搜索：', 'Search: '], ['耗时 ', 'Time '], ['共 ', 'Total '],
    [' 项', ' items'], [' 行', ' lines'], [' 条', ' flows'],
    ['请求原文', 'Request raw'], ['响应原文', 'Response raw'],
    ['请求头', 'Request headers'], ['响应头', 'Response headers'],
    ['请求体', 'Request body'], ['响应体', 'Response body'],
    ['展开全部', 'Expand all'], ['折叠全部', 'Collapse all'],
    ['复制全部', 'Copy all'], ['复制 JSON', 'Copy JSON'],
    ['已停用', 'Disabled'], ['返回全部', 'Back to all'],
    ['本机应用图标', 'local app icon'], ['默认图标', 'default icon'],
    [' 图标', ' icon'], ['设备', 'Device'],
    // 运行时拼出来的状态块 / tooltip（含 IP、端口等数据，只能按片段翻译）
    ['局域网', 'LAN'], ['本机回环', 'loopback'], ['多网卡', 'multiple NICs'],
    ['点 IP / 端口分别复制', 'click IP / port to copy each'], ['复制完整地址', 'copy full address'],
    ['切换地址', 'switch address'], ['复制 IP', 'Copy IP'], ['复制端口', 'Copy port'],
    ['网络服务', 'Network service'], ['Web 代理', 'Web proxy'], ['安全 Web', 'Secure Web'],
    ['绕过域名', 'Bypass domains'], ['已记录', 'Recorded'], ['累计转发', 'Forwarded'],
    ['根证书', 'Root CA'], ['解密模式', 'Decryption mode'], ['代理地址', 'Proxy address'],
    ['代理端口', 'Proxy port'], ['控制台端口', 'Console port'], ['版本', 'Version'],
    ['已信任，HTTPS 正常解密', 'Trusted, HTTPS decrypting'],
    ['安全模式（本机 HTTPS 透传）', 'Safe mode (local HTTPS passthrough)'],
    ['正常', 'Normal'], ['失败', 'Failures'], ['次', ' requests'],
  ];

  var origText = new WeakMap();
  var origAttr = new WeakMap();
  var origTitle = document.title;
  /* mode = 用户在设置里的选择：auto（跟随系统，默认）/ en / zh-CN；lang = 当前实际生效语言 */
  var mode = 'auto';
  var lang;

  function systemLang() {
    var n = (navigator.language || navigator.userLanguage || '').toLowerCase();
    return n.indexOf('zh') === 0 ? 'zh-CN' : 'en';
  }
  function resolveLang() { return mode === 'auto' ? systemLang() : mode; }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'auto' || saved === 'en' || saved === 'zh-CN') mode = saved;
  } catch (e) { /* 隐私模式 / 禁写 localStorage 时保持默认 auto */ }
  lang = resolveLang();

  function t(s, exactOnly) {
    if (typeof s !== 'string' || !HAN.test(s)) return s;
    var trimmed = s.trim();
    var out;
    var hit = EN[trimmed];
    if (hit === undefined) hit = EN_NORM[norm(trimmed)];
    if (hit !== undefined) {
      out = hit;
    } else {
      // 正则模式足够具体，数据区域也允许；片段替换只在普通 UI 区域做
      for (var i = 0; i < PATTERNS.length; i++) {
        var p = PATTERNS[i];
        if (p[0].test(trimmed)) {
          out = trimmed.replace(p[0], p[1]);
          if (out !== trimmed) break;
          out = undefined;
        }
      }
      if (out === undefined) out = trimmed;
      if (!exactOnly) {
        // 正则命中的句子里可能还嵌着中文标签（如「局域网」），再补一轮片段替换
        for (var j = 0; j < PARTIALS.length; j++) out = out.split(PARTIALS[j][0]).join(PARTIALS[j][1]);
      }
    }
    if (out === trimmed || out === undefined) return s;
    return s.replace(trimmed, function () { return out; });
  }

  function skipped(el) {
    return !!(el && el.closest && el.closest(SKIP));
  }

  function applyTextNode(node, force) {
    var cur = node.nodeValue;
    if (!HAN.test(cur) && !origText.has(node)) return;
    if (skipped(node.parentElement)) return;
    var orig = origText.get(node);
    if (orig === undefined || (force && HAN.test(cur))) {
      orig = cur;
      origText.set(node, orig);
    }
    var dataArea = node.parentElement && node.parentElement.closest(DATA_AREA);
    var next = lang === 'en' ? t(orig, !!dataArea) : orig;
    if (next !== cur) node.nodeValue = next;
  }

  function applyAttrs(el, force) {
    if (skipped(el)) return;
    var saved = origAttr.get(el) || {};
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var cur = el.getAttribute(a);
      if (cur === null) continue;
      if (HAN.test(cur)) {
        saved[a] = cur; // 业务代码新设置的中文文案，更新原文
      } else if (!saved[a]) {
        continue; // 纯数据/英文，不动
      }
      var next = lang === 'en' ? t(saved[a]) : saved[a];
      if (next !== cur) el.setAttribute(a, next);
    }
    origAttr.set(el, saved);
  }

  function applySubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) return applyTextNode(root);
    if (root.nodeType !== 1) return;
    if (skipped(root)) return;
    applyAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) applyTextNode(n);
      else {
        if (skipped(n)) { w.currentNode = n; continue; }
        applyAttrs(n);
      }
    }
  }

  function refresh() {
    applySubtree(document.body);
    document.title = lang === 'en' ? t(origTitle) : origTitle;
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    updateControls();
  }

  function updateControls() {
    var btn = document.getElementById('btnLang');
    if (btn) {
      btn.textContent = lang === 'en' ? '中' : 'EN';
      btn.title = mode === 'auto'
        ? (lang === 'en'
          ? 'Auto: following the system language. Click to switch to Chinese.'
          : '自动：跟随系统语言，点击切换到英文。')
        : (lang === 'en' ? 'Click to switch to Chinese' : '点击切换到英文');
      btn.setAttribute('aria-label', btn.title);
    }
    var sel = document.getElementById('stLang');
    if (sel) sel.value = mode;
  }

  /* next: 'auto'（跟随系统，默认）| 'en' | 'zh-CN'；旧版存的 en / zh-CN 直接兼容 */
  function setLang(next) {
    mode = (next === 'en' || next === 'zh-CN') ? next : 'auto';
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    lang = resolveLang();
    refresh();
    if (window.ReqLiteDesktop && window.ReqLiteDesktop.setLang) window.ReqLiteDesktop.setLang(lang);
    // 让页面里依赖语言的下拉/派生文案重绘一次
    window.dispatchEvent(new CustomEvent('reqlite-langchange', { detail: lang }));
    return lang;
  }

  /* 原生对话框不在 DOM 里，单独接管 */
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var native = window[name];
    if (typeof native !== 'function') return;
    window[name] = function (msg) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = t(String(msg));
      return native.apply(window, args);
    };
  });

  window.ReqLiteI18N = {
    t: t,
    setLang: setLang,
    getLang: function () { return lang; },
    getMode: function () { return mode; },
    isEn: function () { return lang === 'en'; },
    refresh: refresh,
  };

  /* 动态渲染（流量列表、弹窗、详情、错误提示）自动接管 */
  var mo = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'childList') {
        for (var k = 0; k < r.addedNodes.length; k++) applySubtree(r.addedNodes[k]);
      } else if (r.type === 'characterData') {
        applyTextNode(r.target, true);
      } else if (r.type === 'attributes') {
        applyAttrs(r.target, true);
      }
    }
  });

  refresh();
  if (window.ReqLiteDesktop && window.ReqLiteDesktop.setLang) window.ReqLiteDesktop.setLang(lang);
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  document.addEventListener('DOMContentLoaded', refresh);

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('#btnLang');
    if (btn) setLang(lang === 'en' ? 'zh-CN' : 'en');
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'stLang') setLang(e.target.value);
  });
  /* 系统语言偏好在运行中变化（切系统设置 / Electron locale 变更）时，跟随系统模式自动跟上 */
  window.addEventListener('languagechange', function () {
    if (mode !== 'auto') return;
    var next = resolveLang();
    if (next === lang) return;
    lang = next;
    refresh();
    if (window.ReqLiteDesktop && window.ReqLiteDesktop.setLang) window.ReqLiteDesktop.setLang(lang);
    window.dispatchEvent(new CustomEvent('reqlite-langchange', { detail: lang }));
  });
})();
