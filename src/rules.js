'use strict';

/**
 * Mock 规则引擎 —— 文件系统版。
 *
 * 规则以真实文件组织在 data/rules/ 目录，像编辑器工程一样管理：
 *   data/rules/
 *   ├── 我的App/
 *   │   ├── 课程列表.rule.json      ← 匹配条件 + 元数据（不含 body）
 *   │   └── 课程列表.body.json      ← 响应 body 单独存放（按内容定扩展名）
 *   └── 全局兜底.rule.json
 *
 * 设计要点：
 * - 外部编辑器 / git / AI 都可以直接读写这些文件，fs.watch 热加载。
 * - 内存里仍是扁平数组（含 body），match() 语义与旧版完全一致。
 * - 匹配优先级 = 目录深度 + 名称排序（浅层在前、同层按名称），不再有全局上下移。
 * - 旧版 data/rules.json 首次启动自动迁移为文件，并改名 .migrated 备份。
 * - 文件级 API（tree/file/fs/move）同时服务于界面文件树与后期 AI 接入。
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + '$', 'i');
}

const RULE_EXT = '.rule.json';

/** body 内容决定扩展名 */
function bodyExtOf(bodyType, bodyBase64, text) {
  if (bodyBase64) return '.bin';
  switch (bodyType) {
    case 'json': return '.json';
    case 'html': return '.html';
    case 'xml': return '.xml';
    case 'javascript': return '.js';
    case 'plaintext': return '.txt';
    default: {
      // auto：能 parse 成 JSON 就 .json，否则 .txt
      if (typeof text === 'string' && text.trim()) {
        try { JSON.parse(text); return '.json'; } catch (_) { /* not json */ }
      }
      return '.txt';
    }
  }
}

function sanitizeName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'untitled-rule';
}

/** 相对路径安全解析：必须在 rules 根内，防目录穿越 */
function resolveWithin(root, rel) {
  const clean = path.normalize(String(rel || '')).replace(/^(\.\.[/\\])+/, '');
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('非法路径: ' + rel);
  }
  return abs;
}

class RuleEngine {
  constructor(dir, { onChange } = {}) {
    this.root = path.join(dir || path.join(process.cwd(), 'data'), 'rules');
    fs.mkdirSync(this.root, { recursive: true });
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.rules = [];
    this.reload();
    this._migrateLegacy();
    this._startWatch();
  }

  /* ---------------- 扫描与加载 ---------------- */

  reload() {
    const found = [];
    this._walk('', found);
    // 匹配顺序：目录浅的在前，同层按名称
    found.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    this.rules = found;
  }

  _walk(relDir, out) {
    const abs = resolveWithin(this.root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const childRel = relDir ? path.join(relDir, ent.name) : ent.name;
      if (ent.isDirectory()) {
        this._walk(childRel, out);
      } else if (ent.isFile() && ent.name.endsWith(RULE_EXT)) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(abs, ent.name), 'utf8'));
          const rule = normalizeRule(raw);
          const stem = ent.name.slice(0, -RULE_EXT.length);
          const meta = this._loadBody(relDir, stem, raw.bodyFile);
          out.push({
            ...rule,
            name: raw.name || stem, // 文件名即身份，name 字段缺省时用文件名
            dir: relDir.split(path.sep).join('/'),
            file: childRel.split(path.sep).join('/'),
            bodyFile: meta.bodyFile,
            body: meta.body,
            bodyBase64: meta.bodyBase64,
          });
        } catch (err) {
          console.warn('[rules] 跳过损坏的规则文件:', childRel, err.message);
        }
      }
    }
  }

  /** 读取 body 文件，统一成内存里的 body 字符串 + bodyBase64 标记
   *  bodyFile 语义：相对 rules 根；声明文件读不到时按 stem 猜测兜底 */
  _loadBody(relDir, stem, declaredFile) {
    const dirAbs = resolveWithin(this.root, relDir);
    const candidates = [];
    if (declaredFile) candidates.push(resolveWithin(this.root, declaredFile));
    for (const ext of ['.bin', '.json', '.html', '.xml', '.js', '.txt']) {
      candidates.push(path.join(dirAbs, stem + '.body' + ext));
    }
    for (const f of candidates) {
      try {
        const buf = fs.readFileSync(f);
        const rel = path.relative(this.root, f).split(path.sep).join('/');
        if (f.endsWith('.bin')) {
          return { bodyFile: rel, body: buf.toString('base64'), bodyBase64: true };
        }
        return { bodyFile: rel, body: buf.toString('utf8'), bodyBase64: false };
      } catch (_) {
        /* 试下一个候选 */
      }
    }
    return { bodyFile: null, body: '', bodyBase64: false };
  }

  /* ---------------- 兼容旧 API（CRUD） ---------------- */

  list() {
    return this.rules;
  }

  add(input) {
    const dir = this._normDir(input && input.dir);
    const dirAbs = resolveWithin(this.root, dir);
    fs.mkdirSync(dirAbs, { recursive: true }); // dir 可能是新建的未落盘目录
    const name = sanitizeName(input && (input.name || input.urlMatch) || '未命名规则');
    const stem = this._freeStem(dir, name);
    const rule = normalizeRule({ ...input, id: randomUUID(), name: stem });

    const bodyFile = this._writeBody(dir, stem, rule);
    const meta = { ...rule, bodyFile };
    delete meta.body;
    fs.writeFileSync(
      path.join(resolveWithin(this.root, dir), stem + RULE_EXT),
      JSON.stringify(meta, null, 2)
    );
    this.reload();
    return this.rules.find((r) => r.id === rule.id) || rule;
  }

  update(id, patch) {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const cur = this.rules[idx];
    const next = normalizeRule({ ...cur, ...patch, id });

    // name 变化 → 同目录重命名文件（rule + body 同步）
    let dir = cur.dir;
    let stem = cur.file.slice(cur.file.lastIndexOf('/') + 1, -RULE_EXT.length);
    if (patch && patch.name !== undefined) {
      const want = sanitizeName(patch.name);
      if (want !== stem) {
        const renamed = this._renameStem(dir, stem, this._freeStem(dir, want));
        if (renamed) stem = renamed;
      }
    }

    const bodyFile = this._writeBody(dir, stem, { ...next, body: next.body, bodyBase64: next.bodyBase64, bodyType: next.bodyType });
    const meta = { ...next, name: stem, bodyFile };
    delete meta.body;
    fs.writeFileSync(
      path.join(resolveWithin(this.root, dir), stem + RULE_EXT),
      JSON.stringify(meta, null, 2)
    );
    this.reload();
    return this.rules.find((r) => r.id === id) || null;
  }

  remove(id) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return false;
    try {
      fs.rmSync(resolveWithin(this.root, rule.file));
      if (rule.bodyFile) fs.rmSync(resolveWithin(this.root, rule.bodyFile), { force: true });
    } catch (_) {
      /* 忽略 */
    }
    this.reload();
    return true;
  }

  /** 文件树方案下无全局顺序，保留为兼容 no-op */
  reorder() {
    return this.rules;
  }

  /* ---------------- 文件级 API（文件树 + AI 用） ---------------- */

  tree() {
    const root = { type: 'dir', name: '', path: '', children: [] };
    const dirIndex = new Map([['', root]]);

    const ensureDir = (p) => {
      if (p === '.' || p === './') p = '';
      if (dirIndex.has(p)) return dirIndex.get(p);
      const parent = ensureDir(path.posix.dirname(p));
      const node = { type: 'dir', name: path.posix.basename(p), path: p, children: [] };
      parent.children.push(node);
      dirIndex.set(p, node);
      return node;
    };

    // 先收集目录（包括空目录）
    const addDirs = (relDir) => {
      let entries;
      try {
        entries = fs.readdirSync(resolveWithin(this.root, relDir), { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const child = relDir ? relDir + '/' + ent.name : ent.name;
        if (ent.isDirectory()) {
          ensureDir(child);
          addDirs(child);
        }
      }
    };
    addDirs('');

    for (const r of this.rules) {
      const node = {
        type: 'rule',
        name: r.name,
        path: r.file,
        rule: {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          method: r.method,
          urlMatch: r.urlMatch,
          matchMode: r.matchMode,
          status: r.status,
          host: r.host,
        },
        children: [],
      };
      if (r.bodyFile) {
        node.children.push({ type: 'body', name: path.posix.basename(r.bodyFile), path: r.bodyFile });
      }
      ensureDir(r.dir).children.push(node);
    }

    const sortNode = (n) => {
      if (!Array.isArray(n.children)) return;
      n.children.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1
      );
      n.children.forEach(sortNode);
    };
    sortNode(root);
    return {
      root: path.relative(process.cwd(), this.root) || this.root,
      rootAbs: this.root, // 界面「复制绝对路径 / 在文件管理器中显示」用
      tree: root.children,
    };
  }

  /** 读单个文件：.rule.json 返回规则（含 body），body 文件返回原文 */
  readFile(rel) {
    const abs = resolveWithin(this.root, rel);
    if (rel.endsWith(RULE_EXT)) {
      const rule = this.rules.find((r) => r.file === rel.split(path.sep).join('/'));
      if (!rule) throw new Error('规则未加载: ' + rel);
      return { kind: 'rule', rule: { ...rule } };
    }
    const buf = fs.readFileSync(abs);
    if (rel.endsWith('.bin')) return { kind: 'body', base64: buf.toString('base64'), binary: true };
    return { kind: 'body', text: buf.toString('utf8'), binary: false };
  }

  /** 直接写 body 文件（界面里双击 body 文件编辑、AI 改写响应内容） */
  writeBodyFile(rel, { text, base64 }) {
    const abs = resolveWithin(this.root, rel);
    if (!/\.body\./.test(path.basename(rel))) throw new Error('只能写 .body.* 文件');
    if (base64 !== undefined) fs.writeFileSync(abs, Buffer.from(String(base64), 'base64'));
    else fs.writeFileSync(abs, String(text ?? ''), 'utf8');
    this.reload();
    return { ok: true };
  }

  /** 新建文件夹或规则 */
  create(input) {
    const { type, dir, name } = input || {};
    const d = this._normDir(dir);
    if (type === 'dir') {
      const nm = sanitizeName(name);
      let target = d ? d + '/' + nm : nm;
      let i = 2;
      while (fs.existsSync(resolveWithin(this.root, target))) {
        target = (d ? d + '/' : '') + nm + ' ' + i++;
      }
      fs.mkdirSync(resolveWithin(this.root, target), { recursive: true });
      this.reload();
      return { path: target };
    }
    // type === 'rule'：建一条规则（urlMatch/body/bodyType 等字段透传）
    return this.add({ ...input, dir: d, name });
  }

  /** 重命名 / 移动（拖拽）：from 为 .rule.json 或目录
   *  只传 newName 不传 toDir = 就地改名；显式传 toDir（含 ''）才是移动 */
  move({ from, toDir, newName }) {
    const fromRel = String(from || '').split(path.sep).join('/');
    const absFrom = resolveWithin(this.root, fromRel);
    const ownDir = path.posix.dirname(fromRel);
    const targetDir = toDir === undefined ? (ownDir === '.' ? '' : ownDir) : this._normDir(toDir);
    const st = fs.statSync(absFrom);

    if (st.isDirectory()) {
      const nm = sanitizeName(newName || path.posix.basename(fromRel));
      let to = targetDir ? targetDir + '/' + nm : nm;
      if (to === fromRel) return { ok: true, path: to };
      let i = 2;
      while (fs.existsSync(resolveWithin(this.root, to))) to = (targetDir ? targetDir + '/' : '') + nm + ' ' + i++;
      // 不能把目录移进自己
      if ((targetDir + '/').startsWith(fromRel + '/')) throw new Error('不能把文件夹移动到它自己里面');
      fs.renameSync(absFrom, resolveWithin(this.root, to));
      this.reload();
      return { ok: true, path: to };
    }

    if (!fromRel.endsWith(RULE_EXT)) throw new Error('只能移动 .rule.json 或文件夹');
    const rule = this.rules.find((r) => r.file === fromRel);
    if (!rule) throw new Error('规则未加载: ' + fromRel);
    const oldStem = path.posix.basename(fromRel).slice(0, -RULE_EXT.length);
    const stem = this._freeStem(targetDir, sanitizeName(newName || oldStem));
    const renamed = this._renameStem(rule.dir, oldStem, stem, targetDir);
    this.reload();
    return { ok: !!renamed, path: (targetDir ? targetDir + '/' : '') + stem + RULE_EXT };
  }

  /** 删除文件（.rule.json 连同 body）或整个文件夹 */
  deletePath(rel) {
    const abs = resolveWithin(this.root, rel);
    fs.rmSync(abs, { recursive: true, force: true });
    this.reload();
    return { ok: true };
  }

  /** 复制（粘贴的来源）：规则文件连同响应体一起复制并换新 id，
   *  文件夹递归复制（里面每条规则同样换 id，避免和原件抢同一条规则）。
   *  名字冲突自动编号，重复粘贴不会互相覆盖。 */
  copy({ from, toDir, newName }) {
    const fromRel = String(from || '')
      .split(path.sep)
      .join('/')
      .replace(/^\/+|\/+$/g, '');
    if (!fromRel) throw new Error('没有指定要复制的文件');
    const absFrom = resolveWithin(this.root, fromRel);
    if (!fs.existsSync(absFrom)) throw new Error('源文件不存在: ' + fromRel);
    const targetDir = this._normDir(toDir);
    const base = path.posix.basename(fromRel);
    const st = fs.statSync(absFrom);

    if (st.isDirectory()) {
      const nm = this._freeDirName(targetDir, sanitizeName(newName || base));
      const to = targetDir ? targetDir + '/' + nm : nm;
      if ((to + '/').startsWith(fromRel + '/')) throw new Error('不能把文件夹复制到它自己里面');
      fs.cpSync(absFrom, resolveWithin(this.root, to), { recursive: true });
      this._reidCopiedRules(fromRel, to);
      this.reload();
      return { ok: true, type: 'dir', path: to };
    }

    if (base.endsWith(RULE_EXT)) {
      const oldStem = base.slice(0, -RULE_EXT.length);
      const stem = this._freeStem(targetDir, sanitizeName(newName || oldStem));
      const to = (targetDir ? targetDir + '/' : '') + stem + RULE_EXT;
      const raw = JSON.parse(fs.readFileSync(absFrom, 'utf8'));
      const src = this.rules.find((r) => r.file === fromRel);
      let bodyFile = null;
      if (src && src.bodyFile) {
        const ext = path.posix.extname(src.bodyFile);
        const dstBody = (targetDir ? targetDir + '/' : '') + stem + '.body' + ext;
        fs.copyFileSync(resolveWithin(this.root, src.bodyFile), resolveWithin(this.root, dstBody));
        bodyFile = dstBody;
      }
      const meta = { ...raw, id: randomUUID(), name: stem };
      if (bodyFile) meta.bodyFile = bodyFile;
      else delete meta.bodyFile;
      delete meta.body;
      fs.writeFileSync(resolveWithin(this.root, to), JSON.stringify(meta, null, 2));
      this.reload();
      return { ok: true, type: 'rule', path: to };
    }

    // 其它文件（响应体等）：按字节复制
    const ext = path.posix.extname(base);
    const nm = this._freeFileName(targetDir, sanitizeName(newName || base.slice(0, -ext.length)) + ext);
    const to = targetDir ? targetDir + '/' + nm : nm;
    fs.copyFileSync(absFrom, resolveWithin(this.root, to));
    this.reload();
    return { ok: true, type: 'file', path: to };
  }

  /** 在系统文件管理器里定位（macOS 访达 / Windows 资源管理器 / Linux 文件管理器）
   *  { dryRun: true } 只算出命令不真的打开窗口——自检脚本用它避免在跑测试时弹窗 */
  reveal(rel, { dryRun } = {}) {
    const target = resolveWithin(this.root, String(rel || ''));
    const exists = fs.existsSync(target);
    const isDir = exists ? fs.statSync(target).isDirectory() : !path.extname(target);
    const dir = exists && isDir ? target : path.dirname(target);
    const plat = process.platform;
    let cmd;
    let args;
    if (plat === 'darwin') {
      cmd = 'open';
      args = exists && isDir ? [target] : ['-R', target]; // -R = 在访达里选中该文件
    } else if (plat === 'win32') {
      cmd = 'explorer';
      args = exists && isDir ? [target] : ['/select,' + target];
    } else {
      cmd = 'xdg-open';
      args = [dir];
    }
    if (dryRun) return { ok: true, platform: plat, path: target, dir, cmd, args, dryRun: true };
    try {
      const { execFile } = require('child_process');
      const child = execFile(cmd, args, { windowsHide: true }, () => {
        /* explorer 选中文件时返回值恒为 1，这里不当作失败 */
      });
      child.unref();
    } catch (err) {
      throw new Error('打开文件管理器失败: ' + err.message);
    }
    return { ok: true, platform: plat, path: target, dir };
  }

  /* ---------------- 内部工具 ---------------- */

  _normDir(d) {
    const rel = String(d || '').split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
    if (!rel) return '';
    resolveWithin(this.root, rel); // 校验
    return rel;
  }

  /** 目录里找一个没被占用的 stem */
  _freeStem(dir, want) {
    const dirAbs = resolveWithin(this.root, dir);
    let stem = sanitizeName(want);
    let i = 2;
    while (fs.existsSync(path.join(dirAbs, stem + RULE_EXT))) {
      stem = sanitizeName(want) + ' ' + i++;
    }
    return stem;
  }

  /** 目录里找一个没被占用的文件夹名 */
  _freeDirName(dir, want) {
    const dirAbs = resolveWithin(this.root, dir);
    const base = sanitizeName(want);
    let name = base;
    let i = 2;
    while (fs.existsSync(path.join(dirAbs, name))) name = base + ' ' + i++;
    return name;
  }

  /** 目录里找一个没被占用的文件名（含扩展名） */
  _freeFileName(dir, want) {
    const dirAbs = resolveWithin(this.root, dir);
    const ext = path.extname(want);
    const base = sanitizeName(want.slice(0, want.length - ext.length)) + ext;
    const stem = base.slice(0, base.length - ext.length);
    let name = base;
    let i = 2;
    while (fs.existsSync(path.join(dirAbs, name))) name = stem + ' ' + i++ + ext;
    return name;
  }

  /** 复制文件夹后把里面每条规则的 id 换掉，并把 bodyFile 指到新位置 */
  _reidCopiedRules(oldRel, newRel) {
    const walk = (oldDir, newDir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(resolveWithin(this.root, newDir), { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const childOld = oldDir ? oldDir + '/' + ent.name : ent.name;
        const childNew = newDir ? newDir + '/' + ent.name : ent.name;
        if (ent.isDirectory()) {
          walk(childOld, childNew);
          continue;
        }
        if (!ent.name.endsWith(RULE_EXT)) continue;
        const abs = resolveWithin(this.root, childNew);
        try {
          const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
          const next = { ...raw, id: randomUUID() };
          if (raw.bodyFile) {
            const rest = String(raw.bodyFile).startsWith(oldRel + '/')
              ? String(raw.bodyFile).slice(oldRel.length)
              : '/' + path.posix.basename(String(raw.bodyFile));
            next.bodyFile = newRel + rest;
          }
          fs.writeFileSync(abs, JSON.stringify(next, null, 2));
        } catch (_) {
          /* 损坏文件原样保留，交给 reload 打日志 */
        }
      }
    };
    walk(oldRel, newRel);
  }

  /** 重命名 stem（rule + body 一起），可同时挪目录；失败返回 null
   *  同时把 rule 文件里的 bodyFile 字段改成新位置（相对根） */
  _renameStem(fromDir, oldStem, newStem, toDir) {
    const d = toDir !== undefined ? toDir : fromDir;
    const fromAbs = resolveWithin(this.root, fromDir);
    const toAbs = resolveWithin(this.root, d);
    try {
      fs.renameSync(path.join(fromAbs, oldStem + RULE_EXT), path.join(toAbs, newStem + RULE_EXT));
      let hasBody = false;
      for (const ext of ['.bin', '.json', '.html', '.xml', '.js', '.txt']) {
        const f = path.join(fromAbs, oldStem + '.body' + ext);
        if (fs.existsSync(f)) {
          fs.renameSync(f, path.join(toAbs, newStem + '.body' + ext));
          hasBody = true;
        }
      }
      // 同步 rule 文件内的 bodyFile 引用
      const rulePath = path.join(toAbs, newStem + RULE_EXT);
      try {
        const raw = JSON.parse(fs.readFileSync(rulePath, 'utf8'));
        if (hasBody) raw.bodyFile = (d ? d + '/' : '') + newStem + '.body' + (raw.bodyFile ? path.extname(raw.bodyFile) : '.json');
        else delete raw.bodyFile;
        fs.writeFileSync(rulePath, JSON.stringify(raw, null, 2));
      } catch (_) { /* 内容读不出就不改引用，_loadBody 有 stem 兜底 */ }
      return newStem;
    } catch (err) {
      console.warn('[rules] 重命名失败:', err.message);
      return null;
    }
  }

  /** 按内容写 body 文件，返回相对路径（空 body 返回 null 并清理旧文件） */
  _writeBody(dir, stem, rule) {
    const dirAbs = resolveWithin(this.root, dir);
    // 清掉可能的旧 body 文件（扩展名可能变化）
    for (const ext of ['.bin', '.json', '.html', '.xml', '.js', '.txt']) {
      const f = path.join(dirAbs, stem + '.body' + ext);
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    const body = typeof rule.body === 'string' ? rule.body : '';
    if (!body) return null;
    const ext = bodyExtOf(rule.bodyType, rule.bodyBase64, body);
    const file = stem + '.body' + ext;
    if (rule.bodyBase64) fs.writeFileSync(path.join(dirAbs, file), Buffer.from(body, 'base64'));
    else fs.writeFileSync(path.join(dirAbs, file), body, 'utf8');
    return (dir ? dir + '/' : '') + file;
  }

  /** 旧版 data/rules.json → 目录文件，一次性迁移 */
  _migrateLegacy() {
    const legacy = path.join(path.dirname(this.root), 'rules.json');
    if (!fs.existsSync(legacy)) return;
    try {
      const arr = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (Array.isArray(arr) && arr.length && !this.rules.length) {
        for (const r of arr) this.add(r);
        console.log(`[rules] 已迁移 ${arr.length} 条旧规则到 ${path.basename(this.root)}/ 目录`);
      }
      fs.renameSync(legacy, legacy + '.migrated');
    } catch (err) {
      console.warn('[rules] 迁移 rules.json 失败:', err.message);
    }
  }

  /* ---------------- 热监听 ---------------- */

  _startWatch() {
    try {
      this._watcher = fs.watch(this.root, { recursive: true }, () => this._debounceReload());
    } catch (_) {
      // linux 递归 watch 不支持 → 轮询兜底
      this._lastSig = this._sig();
      this._poll = setInterval(() => {
        const sig = this._sig();
        if (sig !== this._lastSig) {
          this._lastSig = sig;
          this.reload();
          if (this.onChange) this.onChange();
        }
      }, 5000);
      return;
    }
    this._debounceTimer = null;
  }

  _debounceReload() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this.reload();
      if (this.onChange) this.onChange();
    }, 200);
  }

  _sig() {
    let out = '';
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(path.join(this.root, d), { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const rel = d ? d + '/' + e.name : e.name;
        if (e.isDirectory()) walk(rel);
        else {
          try {
            const st = fs.statSync(path.join(this.root, rel));
            out += `${rel}:${st.size}:${st.mtimeMs};`;
          } catch (_) { /* gone */ }
        }
      }
    };
    walk('');
    return out;
  }

  close() {
    if (this._watcher) this._watcher.close();
    if (this._poll) clearInterval(this._poll);
    clearTimeout(this._debounceTimer);
  }

  /* ---------------- 匹配（语义与旧版一致） ---------------- */

  match({ method, url, host }) {
    const target = String(url || '');
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== String(method).toUpperCase()) {
        continue;
      }
      if (rule.host && String(host || '').toLowerCase() !== rule.host.toLowerCase()) continue;
      const pattern = rule.urlMatch || '';
      if (!pattern) {
        if (rule.host) return rule; // 只按 host 匹配
        continue;
      }
      let hit = false;
      if (rule.matchMode === 'regex') {
        try {
          hit = new RegExp(pattern, 'i').test(target);
        } catch (_) {
          hit = false;
        }
      } else if (rule.matchMode === 'wildcard') {
        hit = wildcardToRegExp(pattern).test(target);
      } else {
        hit = target.toLowerCase().includes(pattern.toLowerCase());
      }
      if (hit) return rule;
    }
    return null;
  }
}

function normalizeRule(r) {
  const out = {
    id: r.id || randomUUID(),
    name: r.name || '',
    enabled: r.enabled !== false,
    method: (r.method || '*').toUpperCase(),
    host: r.host || '',
    urlMatch: r.urlMatch || '',
    matchMode: r.matchMode === 'regex' || r.matchMode === 'wildcard' ? r.matchMode : 'contains',
    status: Number(r.status) || 200,
    delayMs: Number(r.delayMs) || 0,
    headers: normalizeHeaders(r.headers),
    body: typeof r.body === 'string' ? r.body : '',
    bodyBase64: !!r.bodyBase64,
    // 下面两个只服务于控制台编辑体验，不参与匹配
    note: typeof r.note === 'string' ? r.note : '',
    bodyType: ['auto', 'json', 'plaintext', 'html', 'xml', 'javascript'].includes(r.bodyType)
      ? r.bodyType
      : 'auto',
    createdAt: r.createdAt || Date.now(),
  };
  return out;
}

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const line of h) {
      const i = String(line).indexOf(':');
      if (i > 0) out[String(line).slice(0, i).trim().toLowerCase()] = String(line).slice(i + 1).trim();
    }
    return out;
  }
  if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (k) out[String(k).trim().toLowerCase()] = String(v);
    }
  }
  return out;
}

module.exports = { RuleEngine, normalizeRule };
