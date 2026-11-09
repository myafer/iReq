'use strict';

/**
 * 本机应用图标（Reqable 那种侧栏里带 App 图标的效果）。
 *
 * 思路：代理跑在 macOS 上时，ProcessMap 已经能拿到发起连接的真实进程名，
 * 而 /Applications 里的 .app 自带图标文件。这里按名字找到 bundle，用系统自带
 * 的 plutil + sips 把 .icns 转成 128px PNG 缓存下来，控制台直接当 <img> 用。
 *
 * - 全程只用 macOS 自带命令，不需要网络、不需要额外依赖
 * - 结果缓存在 data/app-icons/，同名只转一次；重启服务直接复用
 * - 只有 CFBundleIconName / Assets.car 的新式 App 用 NSWorkspace 兜底
 * - 非 macOS、命令行工具、手机 App 都拿不到本机图标 → 返回 null，
 *   由前端回退到内置 SVG / 默认首字母图标（见 public/app-icons.js）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const EXEC_OPTS = { timeout: 6000, maxBuffer: 2 * 1024 * 1024 };

const APP_DIRS = [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities',
  '/Applications/Utilities',
  '/System/Library/CoreServices',
  '/System/Cryptexes/App/System/Applications',
];

/** UA 推断出来的名字带版本号 / 平台后缀，统一压成一个可比较的 key */
const ALIASES = {
  chrome: ['googlechrome', 'chrome', 'chromium'],
  chromium: ['chromium', 'googlechrome'],
  safari: ['safari'],
  firefox: ['firefox'],
  edge: ['microsoftedge', 'edge'],
  wechat: ['wechat', '微信'],
  dingtalk: ['dingtalk', '钉钉'],
  wework: ['企业微信', 'wecom', 'wework'],
  qq: ['qq'],
  postman: ['postman'],
  figma: ['figma'],
  vscode: ['visualstudiocode', 'vscode'],
  code: ['visualstudiocode', 'vscode'],
  xcode: ['xcode'],
  androidstudio: ['androidstudio'],
  terminal: ['terminal', 'iterm2', 'iterm'],
  iterm: ['iterm2', 'iterm'],
  finder: ['finder'],
  node: ['node'],
};

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.app$/, '')
    .replace(/\s+\d+(?:\.\d+)*$/, '') // "Chrome 141" / "OkHttp 4" -> "chrome" / "okhttp"
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** /Applications/X.app/Contents/MacOS/X -> /Applications/X.app；也接受已经是 bundle 的路径 */
function bundlePathOf(p) {
  const s = String(p || '');
  const i = s.indexOf('.app/');
  if (i >= 0) return s.slice(0, i + 4);
  return /\.app$/.test(s) ? s : null;
}

function safeIconFile(name) {
  return /^[a-f0-9]{20}\.png$/.test(String(name || '')) ? String(name) : null;
}

class AppIconResolver {
  constructor({ dataDir } = {}) {
    this.supported = process.platform === 'darwin';
    this.dir = path.join(dataDir || path.join(__dirname, '..', 'data'), 'app-icons');
    this.index = new Map(); // normalized name -> bundle path
    this.cache = new Map(); // app name -> {url, kind, bundle} | null
    this.pending = new Map(); // app name -> Promise
    this.scannedAt = 0;
    this.hintsAt = 0;
    this.stats = { resolved: 0, generated: 0, failed: 0, cached: 0, fallback: 0 };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (_) {
      /* 只读环境：仍然可以返回内置图标 */
    }
  }

  /** 扫描应用目录（只扫一层 + 常见子目录，别把启动拖慢） */
  scan(force = false) {
    if (!this.supported) return this.index;
    if (!force && Date.now() - this.scannedAt < 5 * 60 * 1000) return this.index;
    this.scannedAt = Date.now();
    for (const dir of APP_DIRS) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory() || !ent.name.endsWith('.app')) continue;
        const key = normalizeName(ent.name);
        if (key && !this.index.has(key)) this.index.set(key, path.join(dir, ent.name));
      }
    }
    return this.index;
  }

  /** flow 里带的可执行路径最准（能覆盖不在标准目录的 App）。
   *  不加时间节流：lsof 是异步回填的，而前端一个名字通常只问一次，
   *  节流会让「第一次没查到 → 之后永远拿不到真实图标」。 */
  collectHints(flows) {
    if (!this.supported || !Array.isArray(flows)) return;
    for (const f of flows) {
      const p = (f && f.process && (f.process.path || f.process.command)) || '';
      const bundle = bundlePathOf(p);
      if (!bundle) continue;
      const name = (f && (f.app || (f.process && f.process.name))) || path.basename(bundle, '.app');
      this.registerHint(name, p);
      this.registerHint(path.basename(bundle, '.app'), bundle);
    }
  }

  registerHint(name, p) {
    const bundle = bundlePathOf(p);
    if (!bundle) return null;
    const key = normalizeName(name || path.basename(bundle, '.app'));
    if (!key) return bundle;
    if (this.index.get(key) !== bundle) {
      this.index.set(key, bundle);
      // 之前判过「没有图标」的，现在有了更准的路径，允许重新解析
      for (const [cachedName, value] of [...this.cache]) {
        if (value === null && normalizeName(cachedName) === key) this.cache.delete(cachedName);
      }
    }
    return bundle;
  }

  findBundle(name) {
    if (!this.supported) return null;
    this.scan();
    const key = normalizeName(name);
    if (!key) return null;
    if (this.index.has(key)) return this.index.get(key);
    for (const alias of ALIASES[key] || []) {
      const hit = this.index.get(normalizeName(alias));
      if (hit) return hit;
    }
    // "Chrome 141" / "Chrome for Testing" 这类带后缀的名字：取最接近的一个
    if (key.length >= 4) {
      const candidates = [...this.index.entries()]
        .filter(([k]) => k.startsWith(key) || key.startsWith(k) || k.endsWith(key) || key.endsWith(k))
        .filter(([k]) => Math.min(k.length, key.length) >= 5 && Math.abs(k.length - key.length) <= 8)
        .sort((a, b) => a[0].length - b[0].length);
      if (candidates.length) return candidates[0][1];
    }
    return null;
  }

  /** 批量解析；同名合并成一个 Promise，最多 4 个 sips 并行 */
  async resolveMany(names) {
    const out = {};
    const unique = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].slice(0, 80);
    const queue = unique.slice();
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        out[name] = await this.resolve(name);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async resolve(name) {
    if (!name) return null;
    if (this.cache.has(name)) {
      this.stats.cached += 1;
      return this.cache.get(name);
    }
    if (this.pending.has(name)) return this.pending.get(name);
    const job = this._generate(name)
      .then((result) => {
        this.cache.set(name, result);
        if (result) this.stats.resolved += 1;
        else this.stats.failed += 1;
        return result;
      })
      .catch(() => {
        this.cache.set(name, null);
        this.stats.failed += 1;
        return null;
      })
      .finally(() => this.pending.delete(name));
    this.pending.set(name, job);
    return job;
  }

  async _generate(name) {
    if (!this.supported) return null;
    const bundle = this.findBundle(name);
    if (!bundle) return null;

    const hash = crypto.createHash('sha1').update(bundle).digest('hex').slice(0, 20);
    const file = `${hash}.png`;
    const target = path.join(this.dir, file);
    try {
      if (fs.statSync(target).size > 100) {
        return { url: `/app-icon/${file}`, kind: 'bundle', bundle, generated: false };
      }
    } catch (_) {
      /* 还没生成 */
    }

    const icon = await this._iconFile(bundle);
    let ok = false;
    if (icon) {
      try {
        await execFileAsync('sips', ['-s', 'format', 'png', icon, '--out', target, '-Z', '128'], EXEC_OPTS);
        ok = fs.existsSync(target) && fs.statSync(target).size > 100;
      } catch (_) {
        ok = false;
      }
    }
    if (!ok) ok = await this._viaWorkspace(bundle, target);
    if (!ok) {
      this.stats.fallback += 1;
      try {
        fs.unlinkSync(target);
      } catch (_) {
        /* noop */
      }
      return null;
    }
    this.stats.generated += 1;
    return { url: `/app-icon/${file}`, kind: 'bundle', bundle, generated: true };
  }

  /** 优先用 Info.plist 指定的 .icns，找不到就挑 Resources 里的任意 .icns */
  async _iconFile(bundle) {
    const resources = path.join(bundle, 'Contents', 'Resources');
    let iconName = '';
    try {
      const r = await execFileAsync(
        'plutil',
        ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')],
        EXEC_OPTS
      );
      iconName = String(r.stdout || '').trim().split('\n')[0];
    } catch (_) {
      /* 新式 App 用 Assets.car，走下面的兜底 */
    }
    if (iconName) {
      const withExt = iconName.endsWith('.icns') ? iconName : iconName + '.icns';
      const candidate = path.join(resources, withExt);
      if (fs.existsSync(candidate)) return candidate;
    }
    try {
      const list = fs.readdirSync(resources).filter((f) => f.toLowerCase().endsWith('.icns'));
      if (iconName) {
        const partial = list.find((f) => f.toLowerCase().includes(iconName.toLowerCase()));
        if (partial) return path.join(resources, partial);
      }
      const preferred = list.find((f) => /^(appicon|icon|application)/i.test(f)) || list[0];
      if (preferred) return path.join(resources, preferred);
    } catch (_) {
      /* noop */
    }
    return null;
  }

  /** Assets.car / 系统 App 的兜底：NSWorkspace 直接问系统要图标，再缩到 128px */
  async _viaWorkspace(bundle, target) {
    const big = target + '.big.png';
    const script = [
      'ObjC.import("AppKit");',
      `var img = $.NSWorkspace.sharedWorkspace.iconForFile(${JSON.stringify(bundle)});`,
      'if (!img || !img.js) throw new Error("no icon");',
      'var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);',
      'var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());',
      `png.writeToFileAtomically(${JSON.stringify(big)}, true);`,
      '"ok";',
    ].join('\n');
    try {
      await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], EXEC_OPTS);
      if (!fs.existsSync(big) || fs.statSync(big).size < 100) return false;
      await execFileAsync('sips', ['-Z', '128', big, '--out', target], EXEC_OPTS);
      return fs.existsSync(target) && fs.statSync(target).size > 100;
    } catch (_) {
      return false;
    } finally {
      try {
        fs.unlinkSync(big);
      } catch (_) {
        /* noop */
      }
    }
  }

  /** /app-icon/<hash>.png：只允许缓存目录里的 hash 文件名，防目录穿越 */
  serve(name, res) {
    const file = safeIconFile(name);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    fs.readFile(path.join(this.dir, file), (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': data.length,
        'cache-control': 'public, max-age=86400',
      });
      res.end(data);
    });
  }

  status() {
    return { supported: this.supported, ...this.stats, apps: this.index.size };
  }
}

module.exports = {
  AppIconResolver,
  normalizeName,
  bundlePathOf,
  safeIconFile,
};
