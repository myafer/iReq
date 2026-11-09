'use strict';

/**
 * 应用 / 设备图标。
 *
 * 三层兜底，任何一个环节失败都不会让界面缺图标：
 *   1. 本机 .app 的真实图标 —— 后端 /api/app-icons 抽好 PNG，这里异步替换成 <img>
 *   2. 内置 SVG —— Chrome / 微信 / 钉钉 / OkHttp / iOS … 常见名字直接有品牌色图标
 *   3. 默认图标 —— 按应用名生成稳定的首字母色块，永远有东西可显示
 *
 * 用 MutationObserver 自动接管新渲染的 DOM：列表、侧栏、详情、SSE 回填都无需手动调用。
 */

(function () {
  const esc = (v) =>
    String(v === undefined || v === null ? '' : v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  const svg = (inner) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
  const round = (color) => `<circle cx="12" cy="12" r="11" fill="${color}"/>`;
  const box = (color) => `<rect x="1" y="1" width="22" height="22" rx="6" fill="${color}"/>`;
  const glyph = (ch, color = '#fff', size = 12) =>
    `<text x="12" y="16.5" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${size}" font-weight="700" fill="${color}">${ch}</text>`;

  /** 内置图标：顺序有意义，具体的放前面 */
  const BUILTIN = [
    {
      re: /microsoft\s*edge|\bedge\b|edg\//i,
      key: 'edge',
      label: 'Edge',
      art: svg(`${round('#0F7CC8')}<path d="M3 15c2.5-6.5 8-10 16-8.5-.5 8.5-5.5 13-12.5 13-2.5 0-4-1.5-3.5-4.5z" fill="#35C1A8"/><path d="M3 15c3-2 7-2.5 10-1" stroke="#fff" stroke-width="1.6" fill="none" opacity=".8"/>`),
    },
    {
      re: /chrome|chromium|crios/i,
      key: 'chrome',
      label: 'Chrome',
      art: svg(`${round('#EA4335')}<path d="M12 1a11 11 0 0 1 9.5 5.5L12 12z" fill="#FBBC05"/><path d="M21.5 6.5A11 11 0 0 1 12 23V12z" fill="#34A853"/><path d="M12 23A11 11 0 0 1 1 7.5L12 12z" fill="#4285F4"/><circle cx="12" cy="12" r="4.7" fill="#fff"/><circle cx="12" cy="12" r="3.6" fill="#4285F4"/>`),
    },
    {
      re: /firefox|gecko/i,
      key: 'firefox',
      label: 'Firefox',
      art: svg(`${round('#FF7139')}<circle cx="12" cy="12" r="7.5" fill="#FFBD4F"/><circle cx="12" cy="14.5" r="4.2" fill="#FFE9A3"/><path d="M4 9c2-4 6-6 10-5" stroke="#FFDDA1" stroke-width="2" fill="none" stroke-linecap="round"/>`),
    },
    {
      re: /safari|webkit|webcontent/i,
      key: 'safari',
      label: 'Safari',
      art: svg(`${round('#1E9BF0')}<circle cx="12" cy="12" r="8.6" fill="#fff" opacity=".16"/><path d="M17 7 13 13l-6 4 3-6z" fill="#fff"/><path d="M17 7 10 11l3 2z" fill="#F0433A"/>`),
    },
    {
      re: /企业微信|企业微信|wecom|wework|wxwork/i,
      key: 'wework',
      label: '企业微信',
      art: svg(`${box('#2F7BF6')}<path d="M6 8.5h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5l-3 2v-2H6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z" fill="#fff"/><circle cx="8.5" cy="12.5" r="1" fill="#2F7BF6"/><circle cx="12.5" cy="12.5" r="1" fill="#2F7BF6"/>`),
    },
    {
      re: /微信|wechat|weixin/i,
      key: 'wechat',
      label: '微信',
      art: svg(`${box('#07C160')}<ellipse cx="9.4" cy="9.8" rx="5.1" ry="4.2" fill="#fff"/><ellipse cx="15.8" cy="14.2" rx="4.4" ry="3.7" fill="#fff"/><circle cx="7.7" cy="9" r=".85" fill="#07C160"/><circle cx="11.1" cy="9" r=".85" fill="#07C160"/><circle cx="14.5" cy="13.5" r=".7" fill="#07C160"/><circle cx="17.3" cy="13.5" r=".7" fill="#07C160"/>`),
    },
    {
      re: /钉钉|dingtalk|dingding/i,
      key: 'dingtalk',
      label: '钉钉',
      art: svg(`${box('#1E88E5')}<path d="M18.5 5.5 7.6 13.4h4.2l-3 5.3 9.7-8.2h-4.4z" fill="#fff"/>`),
    },
    {
      re: /\bqq\b|tim\.qq|mqq/i,
      key: 'qq',
      label: 'QQ',
      art: svg(`${round('#12B7F5')}<ellipse cx="12" cy="13" rx="6" ry="6.5" fill="#fff"/><circle cx="9.8" cy="11.5" r="1" fill="#1B2733"/><circle cx="14.2" cy="11.5" r="1" fill="#1B2733"/><path d="M9.5 16c1.5 1.2 3.5 1.2 5 0" stroke="#F5A623" stroke-width="1.4" fill="none" stroke-linecap="round"/>`),
    },
    {
      re: /postman/i,
      key: 'postman',
      label: 'Postman',
      art: svg(`${round('#FF6C37')}<circle cx="12" cy="12" r="6.6" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M12 7.5v8M8 11l4-3 4 3" stroke="#fff" stroke-width="1.7" fill="none" stroke-linejoin="round"/>`),
    },
    {
      re: /figma/i,
      key: 'figma',
      label: 'Figma',
      art: svg(`${box('#2C2C2C')}<circle cx="9.5" cy="7" r="2.6" fill="#F24E1E"/><circle cx="14.5" cy="7" r="2.6" fill="#FF7262"/><circle cx="9.5" cy="12" r="2.6" fill="#A259FF"/><circle cx="14.5" cy="12" r="2.6" fill="#1ABCFE"/><circle cx="9.5" cy="17" r="2.6" fill="#0ACF83"/>`),
    },
    {
      re: /vscode|visual studio code|\bcode\b/i,
      key: 'vscode',
      label: 'VS Code',
      art: svg(`${box('#1E8AD6')}<path d="M7 6 3 9.5v5L7 18l2-2-2.5-4L9 8zM17 6l4 3.5v5L17 18l-2-2 2.5-4L15 8z" fill="#fff" opacity=".95"/><path d="M9.5 12 13 8.5v7z" fill="#fff"/>`),
    },
    {
      re: /xcode/i,
      key: 'xcode',
      label: 'Xcode',
      art: svg(`${box('#1B86E0')}<path d="M8 7 4 12l4 5M16 7l4 5-4 5M13.5 5.5l-3 13" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    },
    {
      re: /android studio/i,
      key: 'androidstudio',
      label: 'Android Studio',
      art: svg(`${box('#3DDC84')}<path d="M6 10h12v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="#fff"/><path d="M7 6.5 9 9M17 6.5 15 9" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="9.5" cy="12" r=".9" fill="#3DDC84"/><circle cx="14.5" cy="12" r=".9" fill="#3DDC84"/>`),
    },
    {
      re: /flutter|dart/i,
      key: 'flutter',
      label: 'Flutter',
      art: svg(`${box('#137FCB')}<path d="M14.5 3 5 12.5l3 3L20.5 6.5zM14.5 11l-4 4 3 3 4-4z" fill="#fff"/>`),
    },
    {
      re: /okhttp|retrofit/i,
      key: 'okhttp',
      label: 'OkHttp',
      art: svg(`${box('#3B82C4')}${glyph('{}', '#fff', 11)}`),
    },
    {
      re: /alamofire/i,
      key: 'alamofire',
      label: 'Alamofire',
      art: svg(`${box('#7B61A8')}${glyph('A', '#fff', 13)}`),
    },
    {
      re: /cfnetwork|nsurlsession|urlsession/i,
      key: 'cfnetwork',
      label: 'CFNetwork',
      art: svg(`${box('#64748B')}${glyph('&lt;/&gt;', '#fff', 9)}`),
    },
    {
      re: /curl|wget|httpie/i,
      key: 'curl',
      label: 'cURL',
      art: svg(`${box('#334155')}${glyph('>_', '#7DD3FC', 10)}`),
    },
    {
      re: /\bnode(\.js)?\b|electron/i,
      key: 'node',
      label: 'Node.js',
      art: svg(`${box('#3C873A')}${glyph('N', '#fff', 13)}`),
    },
    {
      re: /python/i,
      key: 'python',
      label: 'Python',
      art: svg(`${box('#3776AB')}<path d="M12 5c-3 0-4 1-4 3v2h5v1H6c-2 0-3 1-3 3s1 3 3 3h2v-2c0-2 1-3 3-3h4c2 0 3-1 3-3V8c0-2-1-3-4-3z" fill="#FFD43B"/>`),
    },
    {
      re: /java|jvm/i,
      key: 'java',
      label: 'Java',
      art: svg(`${box('#E76F00')}<path d="M7 8h9v6a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3zM16 9h1.5a1.5 1.5 0 0 1 0 3H16" stroke="#fff" stroke-width="1.5" fill="none"/><path d="M8 5c1-1 2 1 3 0M11 4c1-1 2 1 3 0" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>`),
    },
    {
      re: /terminal|iterm|shell|bash|zsh/i,
      key: 'terminal',
      label: '终端',
      art: svg(`${box('#1F2937')}<rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="#64748B" stroke-width="1.2"/>${glyph('>_', '#4ADE80', 9)}`),
    },
    {
      re: /finder|访达/i,
      key: 'finder',
      label: 'Finder',
      art: svg(`${box('#1E90D8')}<path d="M4 5h16v14H4z" fill="#fff" opacity=".9"/><path d="M4 12h16M12 5v7" stroke="#1E90D8" stroke-width="1.2"/><circle cx="8" cy="9" r=".8" fill="#1E90D8"/><circle cx="16" cy="9" r=".8" fill="#1E90D8"/><path d="M9 15c2 1.6 4 1.6 6 0" stroke="#1E90D8" stroke-width="1.2" fill="none"/>`),
    },
    {
      re: /android/i,
      key: 'android',
      label: 'Android',
      art: svg(`${box('#3DDC84')}<path d="M6 10.5h12v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="#fff"/><path d="M7.5 6.5 9 9M16.5 6.5 15 9" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/><circle cx="9.7" cy="12.3" r=".85" fill="#3DDC84"/><circle cx="14.3" cy="12.3" r=".85" fill="#3DDC84"/>`),
    },
    {
      re: /ios|iphone|ipad|apple|darwin/i,
      key: 'ios',
      label: 'iOS',
      art: svg(`${box('#475569')}<rect x="8" y="3" width="8" height="18" rx="2" fill="#fff"/><rect x="9.2" y="5" width="5.6" height="13" rx=".6" fill="#475569"/><circle cx="12" cy="19.3" r=".7" fill="#475569"/>`),
    },
    {
      re: /windows|win32|win64/i,
      key: 'windows',
      label: 'Windows',
      art: svg(`${box('#0078D4')}<path d="M4 7.5 11 6.5v5H4zM12.5 6.2 20 5v6.5h-7.5zM4 13h7v5L4 17zM12.5 13H20v6.5l-7.5-1.3z" fill="#fff"/>`),
    },
    {
      re: /macos|mac os|os x/i,
      key: 'macos',
      label: 'macOS',
      art: svg(`${box('#64748B')}<rect x="5" y="5" width="14" height="10" rx="1.5" fill="#fff"/><path d="M3 18h18l-1 2H4z" fill="#fff" opacity=".8"/>`),
    },
    {
      re: /linux|ubuntu/i,
      key: 'linux',
      label: 'Linux',
      art: svg(`${box('#273142')}<ellipse cx="12" cy="12" rx="4.5" ry="6" fill="#F5C451"/><circle cx="10.3" cy="10.5" r=".9" fill="#273142"/><circle cx="13.7" cy="10.5" r=".9" fill="#273142"/><path d="M10 15c1.3 1 2.7 1 4 0" stroke="#273142" stroke-width="1.1" fill="none"/>`),
    },
  ];

  const DEVICE_ART = {
    local: svg(`${box('var(--ic-device)')}<rect x="5" y="5.5" width="14" height="10" rx="1.5" fill="#fff"/><path d="M3 19h18l-1.5 1.5h-15z" fill="#fff" opacity=".85"/>`),
    phone: svg(`${box('var(--ic-device)')}<rect x="8" y="3.5" width="8" height="17" rx="1.8" fill="#fff"/><rect x="9.2" y="5.5" width="5.6" height="12" rx=".5" fill="var(--ic-device)"/><circle cx="12" cy="19" r=".65" fill="var(--ic-device)"/>`),
    desktop: svg(`${box('var(--ic-device)')}<rect x="4" y="5" width="16" height="11" rx="1.5" fill="#fff"/><path d="M10 18h4M8 20h8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`),
    generic: svg(`${box('var(--ic-device)')}<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13 0 16M12 4c-2.5 2.5-2.5 13 0 16" stroke="#fff" stroke-width="1.2" fill="none"/>`),
  };

  function initialOf(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const ch = Array.from(s)[0] || '?';
    return /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : ch;
  }

  function matchBuiltin(name) {
    const s = String(name || '');
    return BUILTIN.find((b) => b.re.test(s)) || null;
  }

  /**
   * 生成一个图标节点。
   * 真实图标的 URL 一旦已知（CACHE 里有）就在渲染时直接内联 <img>，
   * 点击 / 重渲染不会再出现「色块 → 真实图标」的闪动；
   * 只有第一次见到的名字才走异步注入。
   * 默认图标用主题中性色，不再随机彩色。
   */
  function iconHtml(name, size = 'sm') {
    const n = String(name || '未知来源');
    const built = matchBuiltin(n);
    const cls = `app-icon ic-${size} ${built ? `builtin ic-${built.key}` : 'default'}`;
    let body;
    let state;
    let title;
    if (CACHE.has(n) && CACHE.get(n)) {
      const url = CACHE.get(n);
      body = `<img class="ic-real" src="${esc(url)}" alt="" decoding="async">`;
      state = 'real';
      title = `${n} · 本机应用图标`;
    } else {
      body = built ? built.art : `<span class="ic-initial">${esc(initialOf(n))}</span>`;
      state = CACHE.has(n) ? 'none' : 'pending';
      title = built ? `${n} · ${built.label} 图标` : `${n} · 默认图标`;
    }
    return `<span class="${cls}${state === 'real' ? ' has-real' : ''}" data-app-icon="${esc(n)}" data-icon-state="${state}" title="${esc(title)}" aria-hidden="true">${body}</span>`;
  }

  /** 设备分组图标：不请求后端，纯内置 */
  function deviceHtml(label, key) {
    const text = String(label || '');
    const kind =
      key === 'local' || /本机/.test(text)
        ? 'local'
        : /ios|iphone|ipad|android|mobile|手机/i.test(text)
        ? 'phone'
        : /mac|windows|pc|桌面/i.test(text)
        ? 'desktop'
        : 'generic';
    return `<span class="app-icon device ic-sm ic-${kind}" title="${esc(text || '设备')}" aria-hidden="true">${DEVICE_ART[kind]}</span>`;
  }

  /* ------------------------------------------------------------- 真实图标回填 */
  const CACHE = new Map(); // name -> url | null
  const INFLIGHT = new Set();
  const FAILED_AT = new Map(); // name -> 上次判定「没有真实图标」的时间
  const RETRIES = new Map(); // name -> 已重试次数
  let timer = null;
  let mounted = false;

  function apply(nodes, name, url) {
    for (const node of nodes) {
      if (!node.isConnected || node.dataset.iconState !== 'pending') continue;
      if (!url) {
        node.dataset.iconState = 'none';
        if (!FAILED_AT.has(name)) FAILED_AT.set(name, Date.now());
        continue;
      }
      const img = document.createElement('img');
      img.className = 'ic-real';
      img.src = url;
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        img.remove();
        node.classList.remove('has-real');
        node.dataset.iconState = 'none';
        node.title = `${name} · 默认图标`;
      });
      node.insertBefore(img, node.firstChild);
      node.dataset.iconState = 'real';
      node.title = `${name} · 本机应用图标`;
      node.classList.add('has-real');
    }
  }

  function scan() {
    const nodes = Array.from(document.querySelectorAll('.app-icon[data-icon-state="pending"]'));
    if (!nodes.length) return;
    const groups = new Map();
    for (const n of nodes) {
      const name = n.dataset.appIcon;
      if (!name) {
        n.dataset.iconState = 'none';
        continue;
      }
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(n);
    }
    for (const [name, list] of groups) if (CACHE.has(name)) apply(list, name, CACHE.get(name));

    const todo = [...groups.keys()].filter((n) => !CACHE.has(n) && !INFLIGHT.has(n) && !n.includes(','));
    if (!todo.length) return;
    for (const n of todo) INFLIGHT.add(n);

    fetch('/api/app-icons?names=' + encodeURIComponent(todo.join(',')))
      .then((r) => (r.ok ? r.json() : { icons: {} }))
      .then((json) => {
        const icons = json.icons || {};
        for (const name of todo) {
          const hit = icons[name];
          const url = hit && hit.url ? hit.url : null;
          CACHE.set(name, url);
          INFLIGHT.delete(name);
          apply(
            Array.from(document.querySelectorAll('.app-icon[data-icon-state="pending"]')).filter(
              (n) => n.dataset.appIcon === name
            ),
            name,
            url
          );
        }
      })
      .catch(() => {
        for (const name of todo) {
          CACHE.set(name, null);
          INFLIGHT.delete(name);
          apply(
            Array.from(document.querySelectorAll('.app-icon[data-icon-state="pending"]')).filter(
              (n) => n.dataset.appIcon === name
            ),
            name,
            null
          );
        }
      });
  }

  function hydrate() {
    clearTimeout(timer);
    timer = setTimeout(scan, 40);
  }

  /**
   * 进程识别是异步回填的：第一次问图标时可能还没有 .app 路径。
   * 每隔 12 秒把「没找到」的图标重新问一遍，最多 3 次，图标会自动升级成真实图标。
   */
  function retry() {
    const now = Date.now();
    const byName = new Map();
    for (const n of document.querySelectorAll('.app-icon[data-icon-state="none"]')) {
      const name = n.dataset.appIcon;
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(n);
    }
    let dirty = false;
    for (const [name, nodes] of byName) {
      if (CACHE.get(name) !== null) continue;
      if (now - (FAILED_AT.get(name) || 0) < 12000) continue;
      if ((RETRIES.get(name) || 0) >= 3) continue;
      RETRIES.set(name, (RETRIES.get(name) || 0) + 1);
      CACHE.delete(name);
      for (const n of nodes) n.dataset.iconState = 'pending';
      dirty = true;
    }
    if (dirty) hydrate();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const observer = new MutationObserver(() => hydrate());
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(retry, 12000);
    hydrate();
  }

  window.ReqLiteIcons = {
    iconHtml,
    deviceHtml,
    hydrate,
    retry,
    mount,
    builtin: (name) => Boolean(matchBuiltin(name)),
    cached: () => Object.fromEntries(CACHE),
  };
})();
