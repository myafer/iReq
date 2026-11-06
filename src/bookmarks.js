'use strict';

/**
 * 收藏（书签）：存的是"一条筛选条件"，不是某一条请求，
 * 这样请求被挤出内存后书签依然可用。
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ALLOWED = ['host', 'route', 'app', 'ip', 'q', 'status', 'mocked'];

function cleanFilter(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ALLOWED) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'mocked') {
      if (value === true || value === 1 || value === '1') out.mocked = true;
      continue;
    }
    out[key] = String(value).slice(0, 300);
  }
  return out;
}

class BookmarkStore {
  constructor(dir) {
    this.file = path.join(dir, 'bookmarks.json');
    fs.mkdirSync(dir, { recursive: true });
    this.items = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        return raw
          .filter((b) => b && b.id && b.filter)
          .map((b) => ({
            id: b.id,
            label: String(b.label || '').slice(0, 200) || '未命名',
            filter: cleanFilter(b.filter),
            createdAt: b.createdAt || Date.now(),
          }));
      }
    } catch (_) {
      /* 首次运行 */
    }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch (_) {
      /* 忽略 */
    }
  }

  list() {
    return this.items;
  }

  add({ label, filter }) {
    const f = cleanFilter(filter);
    if (!Object.keys(f).length) return null;
    const existing = this.items.find((b) => JSON.stringify(b.filter) === JSON.stringify(f));
    if (existing) return existing;
    const item = {
      id: randomUUID(),
      label: String(label || '').slice(0, 200).trim() || describe(f),
      filter: f,
      createdAt: Date.now(),
    };
    this.items.unshift(item);
    this._save();
    return item;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((b) => b.id !== id);
    if (this.items.length !== before) this._save();
    return this.items.length !== before;
  }
}

function describe(filter) {
  const parts = [];
  if (filter.app) parts.push(filter.app);
  if (filter.host) parts.push(filter.host);
  if (filter.route) parts.push(filter.route);
  if (filter.ip) parts.push(filter.ip);
  if (filter.q) parts.push(`"${filter.q}"`);
  return parts.join(' · ') || '筛选';
}

module.exports = { BookmarkStore, describe };
