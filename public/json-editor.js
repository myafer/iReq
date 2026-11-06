'use strict';

/*
 * iReq JSON 编辑器封装
 * ---------------------------------------------------------------------------
 * 用的是本地 vendor 化的 Monaco Editor 0.52.2（VS Code 同款内核），不依赖 CDN，
 * 断网 / 公司内网也能用。loader 是 AMD 版，worker 通过 Blob 代理加载 jsonWorker，
 * 所以 JSON 语法校验、错误红线、智能提示都是真家伙，不是正则假装的高亮。
 *
 * 对外只有一个全局：window.ReqLiteJSON
 *   mount(host, opts)  把一个 div 变成编辑器，返回控制器
 *   colorize(text)     给只读 <pre> 用的轻量 JSON 着色（不依赖 Monaco）
 *   treeHtml(text)     把 JSON 渲染成可折叠树
 *   setTheme / setScale / relayout / ready / destroy
 *
 * 加载失败会退回原生 textarea，所有 getValue / setValue 行为保持不变，
 * 保证 Mock / 重放在任何环境下都不会「存不进去」。
 */

(function () {
  const BASE = '/vendor/monaco/vs';
  const controls = new Set();
  let loaderPromise = null;
  let monaco = null;
  let currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  let currentScale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1.3;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  function themeName() {
    return currentTheme === 'dark' ? 'reqlite-dark' : 'reqlite-light';
  }

  function defineThemes(m) {
    m.editor.defineTheme('reqlite-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'string.key.json', foreground: '8A4BD6', fontStyle: 'bold' },
        { token: 'string.value.json', foreground: '16794A' },
        { token: 'string', foreground: '16794A' },
        { token: 'number', foreground: 'A35C00' },
        { token: 'number.json', foreground: 'A35C00' },
        { token: 'keyword', foreground: '2F5FE0', fontStyle: 'bold' },
        { token: 'keyword.json', foreground: '2F5FE0', fontStyle: 'bold' },
        { token: 'delimiter', foreground: '8A8378' },
        { token: 'comment', foreground: '8A8378', fontStyle: 'italic' },
        { token: 'string.escape.json', foreground: 'C22F22' },
      ],
      colors: {
        'editor.background': '#FBFAF8',
        'editor.foreground': '#211F1C',
        'editorGutter.background': '#FBFAF8',
        'editorLineNumber.foreground': '#B7B0A4',
        'editorLineNumber.activeForeground': '#2F5FE0',
        'editorCursor.foreground': '#2F5FE0',
        'editor.selectionBackground': '#DCE6FF',
        'editor.inactiveSelectionBackground': '#EDF2FF',
        'editor.lineHighlightBackground': '#F2F0EB',
        'editor.lineHighlightBorder': '#00000000',
        'editorIndentGuide.background1': '#E9E5DD',
        'editorIndentGuide.activeBackground1': '#C9C3B8',
        'editorBracketMatch.background': '#EEF2FF',
        'editorBracketMatch.border': '#2F5FE0',
        'editorError.foreground': '#C22F22',
        'editorWarning.foreground': '#A35C00',
        'editorWidget.background': '#FFFFFF',
        'editorWidget.border': '#E5E2DC',
        'editorSuggestWidget.background': '#FFFFFF',
        'editorHoverWidget.background': '#FFFFFF',
        'editorOverviewRuler.border': '#00000000',
        'scrollbarSlider.background': '#D5D1C966',
        'scrollbarSlider.hoverBackground': '#B7B0A466',
      },
    });

    m.editor.defineTheme('reqlite-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'string.key.json', foreground: 'C9A5FF', fontStyle: 'bold' },
        { token: 'string.value.json', foreground: '7DDCAA' },
        { token: 'string', foreground: '7DDCAA' },
        { token: 'number', foreground: 'E8B567' },
        { token: 'number.json', foreground: 'E8B567' },
        { token: 'keyword', foreground: '82A9FF', fontStyle: 'bold' },
        { token: 'keyword.json', foreground: '82A9FF', fontStyle: 'bold' },
        { token: 'delimiter', foreground: '8A919B' },
        { token: 'comment', foreground: '8A919B', fontStyle: 'italic' },
        { token: 'string.escape.json', foreground: 'F2705F' },
      ],
      colors: {
        'editor.background': '#202327',
        'editor.foreground': '#E8E7E4',
        'editorGutter.background': '#202327',
        'editorLineNumber.foreground': '#5E656E',
        'editorLineNumber.activeForeground': '#9DB9FF',
        'editorCursor.foreground': '#6B93FF',
        'editor.selectionBackground': '#2C426B',
        'editor.inactiveSelectionBackground': '#26324A',
        'editor.lineHighlightBackground': '#262B31',
        'editor.lineHighlightBorder': '#00000000',
        'editorIndentGuide.background1': '#333940',
        'editorIndentGuide.activeBackground1': '#4A525C',
        'editorBracketMatch.background': '#2A3650',
        'editorBracketMatch.border': '#6B93FF',
        'editorError.foreground': '#F2705F',
        'editorWarning.foreground': '#E0A33A',
        'editorWidget.background': '#1B1D20',
        'editorWidget.border': '#3A3F46',
        'editorSuggestWidget.background': '#1B1D20',
        'editorHoverWidget.background': '#1B1D20',
        'editorOverviewRuler.border': '#00000000',
        'scrollbarSlider.background': '#3A3F4666',
        'scrollbarSlider.hoverBackground': '#555C6666',
      },
    });
  }

  /** 懒加载 Monaco：只有真正打开含编辑器的弹窗时才下载 4.6MB 的脚本 */
  function ready() {
    if (window.monaco && monaco) return Promise.resolve(monaco);
    if (loaderPromise) return loaderPromise;

    loaderPromise = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-reqlite-monaco]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = BASE + '/editor/editor.main.css';
        link.dataset.reqliteMonaco = '1';
        document.head.appendChild(link);
      }

      // AMD worker 代理：workerMain 内部会 importScripts(loader.js) 再载入
      // vs/language/json/jsonWorker，所以这里只需给它一个可信的 baseUrl。
      const base = location.origin + '/vendor/monaco/';
      const blob = new Blob(
        [
          `self.MonacoEnvironment = { baseUrl: '${base}' };\n` +
            `importScripts('${base}vs/base/worker/workerMain.js');\n`,
        ],
        { type: 'text/javascript' }
      );
      const workerUrl = URL.createObjectURL(blob);
      window.MonacoEnvironment = { getWorkerUrl: () => workerUrl };

      const script = document.createElement('script');
      script.src = BASE + '/loader.js';
      script.onload = () => {
        try {
          window.require.config({
            paths: { vs: BASE },
            'vs/nls': { availableLanguages: { '*': 'zh-cn' } },
          });
          window.require(
            ['vs/editor/editor.main'],
            () => {
              monaco = window.monaco;
              defineThemes(monaco);
              if (monaco.languages.json && monaco.languages.json.jsonDefaults) {
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                  validate: true,
                  allowComments: false,
                  enableSchemaRequest: false,
                  schemas: [],
                });
              }
              resolve(monaco);
            },
            (err) => reject(new Error('Monaco 模块加载失败: ' + err))
          );
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error('Monaco loader 加载失败'));
      document.head.appendChild(script);
    }).catch((err) => {
      loaderPromise = null;
      throw err;
    });

    return loaderPromise;
  }

  function looksLikeJSON(text) {
    return /^\s*[[{]/.test(String(text || ''));
  }

  function pickLanguage(text, explicit) {
    if (explicit && explicit !== 'auto') return explicit;
    return looksLikeJSON(text) ? 'json' : 'plaintext';
  }

  function fontSize() {
    return Math.max(11, Math.round(13 * currentScale));
  }

  /**
   * 把 host 变成编辑器。
   * opts: { value, source(隐藏 textarea), language, readOnly, onChange, onCursor, ariaLabel }
   */
  function mount(host, opts) {
    const o = opts || {};
    if (!host) return null;
    const initial = o.value !== undefined ? String(o.value) : o.source ? o.source.value : '';
    let lang = pickLanguage(initial, o.language);
    let langReq = o.language || 'auto';

    host.classList.add('je-host');

    const fallback = document.createElement('textarea');
    fallback.className = 'je-fallback';
    fallback.spellcheck = false;
    fallback.value = initial;
    fallback.setAttribute('aria-label', o.ariaLabel || '内容编辑');
    fallback.hidden = true;
    host.appendChild(fallback);

    const loading = document.createElement('div');
    loading.className = 'je-loading';
    loading.textContent = '正在加载编辑器…';
    host.appendChild(loading);

    const slot = document.createElement('div');
    slot.className = 'je-slot';
    host.appendChild(slot);

    let editor = null;
    let timer = null;
    let disposed = false;
    const ctrl = {
      ready: false,
      isMonaco: false,
      host,
      get language() {
        return editor ? editor.getModel() && editor.getModel().getLanguageId() : lang;
      },
      getValue() {
        return editor ? editor.getValue() : fallback.value;
      },
      setValue(v) {
        const text = String(v == null ? '' : v);
        fallback.value = text;
        if (editor) editor.setValue(text);
        if (o.source) o.source.value = text;
        if (langReq === 'auto' && editor) {
          monaco.editor.setModelLanguage(editor.getModel(), pickLanguage(text, 'auto'));
        }
        emit(true);
      },
      setLanguage(next) {
        langReq = next || 'auto';
        const actual = pickLanguage(ctrl.getValue(), langReq);
        if (editor) monaco.editor.setModelLanguage(editor.getModel(), actual);
        else lang = actual;
        emit(true);
      },
      format() {
        const text = ctrl.getValue();
        if (!text.trim()) return false;
        try {
          const out = JSON.stringify(JSON.parse(text), null, 2);
          ctrl.setValue(out);
          return true;
        } catch (_) {
          return false;
        }
      },
      minify() {
        const text = ctrl.getValue();
        if (!text.trim()) return false;
        try {
          ctrl.setValue(JSON.stringify(JSON.parse(text)));
          return true;
        } catch (_) {
          return false;
        }
      },
      validate() {
        const text = ctrl.getValue();
        if (!text.trim()) return { ok: true, empty: true, bytes: 0 };
        const isJsonLang =
          langReq === 'json' || (langReq === 'auto' && (ctrl.language === 'json' || looksLikeJSON(text)));
        if (!isJsonLang) return { ok: null, skipped: true, bytes: new Blob([text]).size };
        try {
          const parsed = JSON.parse(text);
          const count =
            parsed && typeof parsed === 'object'
              ? Object.keys(parsed).length
              : 1;
          return { ok: true, empty: false, bytes: new Blob([text]).size, keys: count };
        } catch (err) {
          let line = null;
          const m = /position (\d+)/.exec(err.message);
          if (m) {
            const pos = Number(m[1]);
            line = text.slice(0, pos).split('\n').length;
          }
          return { ok: false, error: err.message, line, bytes: new Blob([text]).size };
        }
      },
      focus() {
        if (editor) editor.focus();
        else {
          fallback.hidden = false;
          fallback.focus();
        }
      },
      layout() {
        if (editor) editor.layout();
      },
      applyOptions() {
        if (editor) {
          editor.updateOptions({
            fontSize: fontSize(),
            lineHeight: Math.round(fontSize() * 1.6),
          });
        }
      },
      setReadOnly(v) {
        if (editor) editor.updateOptions({ readOnly: !!v });
        fallback.readOnly = !!v;
      },
      revealLine(n) {
        if (editor && n) {
          editor.revealLineInCenter(n);
          editor.setPosition({ lineNumber: n, column: 1 });
          editor.focus();
        }
      },
      dispose() {
        disposed = true;
        clearTimeout(timer);
        controls.delete(ctrl);
        if (editor) {
          try {
            const model = editor.getModel();
            editor.dispose();
            if (model) model.dispose();
          } catch (_) {
            /* noop */
          }
        }
        host.innerHTML = '';
      },
    };

    function emit(immediate) {
      if (disposed) return;
      if (o.source) o.source.value = ctrl.getValue();
      if (!o.onChange) return;
      clearTimeout(timer);
      if (immediate) o.onChange(ctrl.getValue(), ctrl);
      else timer = setTimeout(() => o.onChange(ctrl.getValue(), ctrl), 220);
    }

    fallback.addEventListener('input', () => emit(false));
    controls.add(ctrl);

    ready()
      .then((m) => {
        if (disposed) return;
        loading.remove();
        editor = m.editor.create(slot, {
          value: fallback.value,
          language: lang,
          theme: themeName(),
          automaticLayout: true,
          readOnly: !!o.readOnly,
          fontSize: fontSize(),
          lineHeight: Math.round(fontSize() * 1.6),
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          fontLigatures: false,
          minimap: { enabled: false },
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          wordWrap: 'on',
          wrappingIndent: 'indent',
          tabSize: 2,
          insertSpaces: true,
          autoClosingBrackets: 'always',
          autoClosingQuotes: 'always',
          bracketPairColorization: { enabled: true },
          guides: { indentation: true, bracketPairs: false },
          formatOnPaste: false,
          padding: { top: 8, bottom: 8 },
          fixedOverflowWidgets: true,
          contextmenu: true,
          quickSuggestions: { other: true, comments: false, strings: false },
          suggestOnTriggerCharacters: true,
          ariaLabel: o.ariaLabel || 'JSON 编辑器',
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        ctrl.ready = true;
        ctrl.isMonaco = true;
        editor.onDidChangeModelContent(() => {
          fallback.value = editor.getValue();
          emit(false);
        });
        if (o.onCursor) {
          editor.onDidChangeCursorPosition((e) => o.onCursor(e.position, ctrl));
        }
        // 打开弹窗时容器可能是 0 高，ready 后重新量一次
        requestAnimationFrame(() => editor && editor.layout());
        emit(true);
      })
      .catch(() => {
        if (disposed) return;
        loading.remove();
        slot.remove();
        fallback.hidden = false;
        fallback.classList.add('je-fallback-on');
        ctrl.ready = true;
        emit(true);
      });

    return ctrl;
  }

  /* ------------------------------------------------ 只读 JSON 着色（详情面板） */

  /** 扫描式着色：区分对象 key / 字符串 / 数字 / 字面量 / 标点，全部转义后输出 */
  function colorize(text) {
    const src = String(text == null ? '' : text);
    let out = '';
    let i = 0;
    const n = src.length;
    const push = (cls, s) => (out += `<span class="${cls}">${esc(s)}</span>`);

    while (i < n) {
      const c = src[i];
      if (c === '"') {
        let j = i + 1;
        let buf = '"';
        while (j < n) {
          if (src[j] === '\\' && j + 1 < n) {
            buf += src[j] + src[j + 1];
            j += 2;
            continue;
          }
          buf += src[j];
          if (src[j] === '"') {
            j += 1;
            break;
          }
          j += 1;
        }
        // key：字符串后面（跳过空白）是冒号
        let k = j;
        while (k < n && /\s/.test(src[k])) k += 1;
        push(src[k] === ':' ? 'jt-key' : 'jt-str', buf);
        i = j;
        continue;
      }
      if (/[-0-9]/.test(c) && /^[-+]?\d/.test(src.slice(i, i + 12))) {
        const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        if (m) {
          push('jt-num', m[0]);
          i += m[0].length;
          continue;
        }
      }
      const word = /^(true|false|null)\b/.exec(src.slice(i));
      if (word) {
        push('jt-lit', word[0]);
        i += word[0].length;
        continue;
      }
      if (/[{}\[\],:]/.test(c)) {
        push('jt-punct', c);
        i += 1;
        continue;
      }
      push('jt-plain', c);
      i += 1;
    }
    return out;
  }

  /** 可折叠 JSON 树，供详情/预览使用；非 JSON 返回空串 */
  function treeHtml(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (_) {
      return '';
    }
    function node(v, key, depth) {
      const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
      const isObj = v !== null && typeof v === 'object';
      const label = key === null ? '' : `<span class="jt-key">${esc(key)}</span><span class="jt-punct">: </span>`;
      if (isObj) {
        const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
        const meta = `<span class="jt-meta">${Array.isArray(v) ? `[ ${entries.length} ]` : `{ ${entries.length} }`}</span>`;
        return `<details class="jt-node" ${depth < 2 ? 'open' : ''}><summary>${label}<span class="jt-type">${Array.isArray(v) ? 'Array' : 'Object'}</span>${meta}</summary><div class="jt-children">${entries
          .map(([k, val]) => node(val, k, depth + 1))
          .join('')}</div></details>`;
      }
      const shown =
        v === null ? 'null' : type === 'string' ? `"${v}"` : String(v);
      return `<div class="jt-leaf">${label}<span class="jt-${type === 'string' ? 'str' : type === 'number' ? 'num' : 'lit'}">${esc(shown)}</span></div>`;
    }
    return `<div class="json-tree">${node(data, null, 0)}</div>`;
  }

  /**
   * 结构化视图：格式化 JSON 和可折叠树合二为一。
   * 展开时就是带缩进和着色的格式化文本，每个对象 / 数组的开头可点击收起，
   * 收起后显示 `{ … 3 键 }` / `[ … 5 项 ]` 摘要。非合法 JSON 返回空串。
   */
  function foldHtml(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (_) {
      return '';
    }
    function render(v, key, depth, isLast) {
      const comma = isLast ? '' : '<span class="jt-punct">,</span>';
      const pad = `padding-left:${Math.min(depth, 12) * 18}px`;
      const keyHtml =
        key === null ? '' : `<span class="jt-key">${esc(key)}</span><span class="jt-punct">: </span>`;
      if (v === null || typeof v !== 'object') {
        const t = typeof v;
        const shown = v === null ? 'null' : t === 'string' ? `"${v}"` : String(v);
        const cls = t === 'string' ? 'jt-str' : t === 'number' ? 'jt-num' : 'jt-lit';
        return `<div class="jt-leaf" style="${pad}">${keyHtml}<span class="${cls}">${esc(shown)}</span>${comma}</div>`;
      }
      const isArr = Array.isArray(v);
      const entries = isArr ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      const open = isArr ? '[' : '{';
      const close = isArr ? ']' : '}';
      if (!entries.length) {
        return `<div class="jt-leaf" style="${pad}">${keyHtml}<span class="jt-punct">${open}${close}</span>${comma}</div>`;
      }
      const label = isArr ? `${entries.length} 项` : `${entries.length} 键`;
      const kids = entries
        .map(([k, val], i) => render(val, isArr ? null : k, depth + 1, i === entries.length - 1))
        .join('');
      return (
        `<details class="jf-node" open>` +
        `<summary style="${pad}">${keyHtml}<span class="jt-punct">${open}</span>` +
        `<span class="jf-folded"> … <span class="jf-count">${label}</span> <span class="jt-punct">${close}</span>${comma}</span></summary>` +
        `<div class="jf-children">${kids}</div>` +
        `<div class="jt-leaf" style="${pad}"><span class="jt-punct">${close}</span>${comma}</div>` +
        `</details>`
      );
    }
    return `<div class="json-fold">${render(data, null, 0, true)}</div>`;
  }

  /* --------------------------------------------------------------- 全局控制 */

  function setTheme(next) {
    currentTheme = next === 'dark' ? 'dark' : 'light';
    if (monaco) monaco.editor.setTheme(themeName());
  }

  function setScale(scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1;
    currentScale = s;
    if (!monaco) return;
    for (const c of controls) c.applyOptions();
  }

  function relayout() {
    if (!monaco) return;
    for (const c of controls) c.layout();
  }

  function destroyAll() {
    for (const c of Array.from(controls)) c.dispose();
  }

  window.ReqLiteJSON = {
    mount,
    colorize,
    treeHtml,
    foldHtml,
    ready,
    setTheme,
    setScale,
    relayout,
    destroyAll,
    looksLikeJSON,
    get loaded() {
      return !!monaco;
    },
    get theme() {
      return currentTheme;
    },
  };
})();
