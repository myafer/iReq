'use strict';

/**
 * 请求标注：给一条流量写一句结论、标个颜色、打个重点。
 *
 * 为什么单独存一份而不是直接写在 flow 上：
 * flow 会被环形队列挤掉、清空时归档，标注跟着没了就等于没写。
 * 这里按 id 存，落盘一个 json，重启后还在；被挤掉的 id 由 max 上限按时间淘汰。
 *
 * 注意：标注只影响展示与导出，不参与筛选语义（除了「只看重点」这一个开关）。
 */

const fs = require('fs');
const path = require('path');

const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const NOTE_MAX = 500;
const MAX_ENTRIES = 5000;
const SAVE_DELAY = 400;

function cleanColor(v) {
  const c = String(v || '').toLowerCase();
  return COLORS.includes(c) ? c : '';
}

function cleanNote(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\r\n/g, '\n').slice(0, NOTE_MAX);
}

class Annotations {
  constructor({ file, max = MAX_ENTRIES } = {}) {
    this.file = file || '';
    this.max = max;
    this.map = new Map();
    this._timer = null;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = raw && typeof raw === 'object' ? raw.items || raw : {};
      for (const [id, v] of Object.entries(items)) {
        if (!v || typeof v !== 'object') continue;
        const entry = {
          note: cleanNote(v.note),
          color: cleanColor(v.color),
          pinned: v.pinned === true,
          at: Number(v.at) || Date.now(),
        };
        if (!entry.note && !entry.color && !entry.pinned) continue;
        this.map.set(String(id), entry);
      }
    } catch (_) {
      /* 文件不存在或坏了：当作没有标注，不影响抓包 */
    }
  }

  _scheduleSave() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, SAVE_DELAY);
    // 别让定时器把进程吊住：命令行跑完该退就退
    if (this._timer.unref) this._timer.unref();
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const items = {};
      for (const [id, v] of this.map) items[id] = v;
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, items }, null, 0));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 写入（合并语义：只改传进来的字段）；三个字段都空时等同于删除 */
  set(id, patch = {}) {
    const key = String(id || '');
    if (!key) return null;
    const prev = this.map.get(key) || { note: '', color: '', pinned: false, at: 0 };
    // 颜色：空字符串表示清掉，非法值（写错名字）当没传，不要顺手把原来的颜色也抹了
    let color = prev.color;
    if (patch.color !== undefined) {
      const raw = String(patch.color || '').trim();
      color = raw ? cleanColor(raw) || prev.color : '';
    }
    const next = {
      note: patch.note === undefined ? prev.note : cleanNote(patch.note),
      color,
      pinned: patch.pinned === undefined ? prev.pinned : patch.pinned === true,
      at: Date.now(),
    };
    if (!next.note && !next.color && !next.pinned) {
      this.map.delete(key);
      this._scheduleSave();
      return null;
    }
    this.map.delete(key); // 重新插入，保证 Map 的顺序就是「最近修改」
    this.map.set(key, next);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this._scheduleSave();
    return next;
  }

  remove(id) {
    const ok = this.map.delete(String(id || ''));
    if (ok) this._scheduleSave();
    return ok;
  }

  get(id) {
    return this.map.get(String(id || '')) || null;
  }

  /** 把标注合到 flow 上：不改原对象，列表 / 详情 / 导出都走这里 */
  apply(flow) {
    if (!flow || !flow.id) return flow;
    const a = this.map.get(String(flow.id));
    if (!a) return flow;
    const out = { ...flow };
    if (a.note) out.note = a.note;
    if (a.color) out.color = a.color;
    if (a.pinned) out.pinned = true;
    return out;
  }

  applyAll(flows) {
    if (!this.map.size || !Array.isArray(flows)) return flows;
    return flows.map((f) => this.apply(f));
  }

  /** 清空流量时不该把标注一起扔：用户可能还要按 id 回看归档 */
  stats() {
    let pinned = 0;
    let noted = 0;
    for (const v of this.map.values()) {
      if (v.pinned) pinned += 1;
      if (v.note) noted += 1;
    }
    return { total: this.map.size, pinned, noted, colors: COLORS };
  }
}

module.exports = { Annotations, COLORS, NOTE_MAX };
