'use strict';

/**
 * 历史记录：每次「清空」把当天的抓包归档成一个文件，界面上就是一条记录。
 * 记录可以改名、删除、点开回看。
 *
 * 回看是**从文件尾部倒序分块读**：归档动辄几百 MB / 几十万条，
 * 整份读进内存再切片，点一次就卡死一次。这里按 64KB 块反向扫描，
 * 返回一页 + 下一页的字节游标，前端滚到底再要下一页。
 */

const fs = require('fs');
const path = require('path');
const { prepareFilter, summary, ensureDerived } = require('./store');

const CLEARED_RE = /^flows-(\d{4}-\d{2}-\d{2})\.jsonl\.cleared-(\d+)$/;
const CHUNK = 64 * 1024;
const NAME_MAX = 60;
/** 单次导出条数上限：HAR 是一个 JSON 对象，只能整体序列化，得防着几百 MB 的归档 */
const EXPORT_MAX = 50000;
/** reconcile 时同步数行数的上限：超过这个大小的归档留空，等用户点开时再数 */
const COUNT_MAX_BYTES = 32 * 1024 * 1024;

/** 默认名字用本地时间，跟用户「我几点清的」直觉一致 */
function defaultName(ts, withSeconds = false) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${withSeconds ? `${hms}:${p(d.getSeconds())}` : hms}`;
}

function countLines(file) {
  // 归档里的行 = 一次写入，一个请求可能占两行（占位 + 完成），所以这只是量级
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch (_) {
    return null;
  }
}

class FlowHistory {
  constructor({ dir, indexFile }) {
    this.dir = dir;
    this.indexFile = indexFile;
    this.items = [];
    this._load();
    this.reconcile();
  }

  _abs(name) {
    return path.join(this.dir, name);
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw && raw.items;
      if (Array.isArray(list)) this.items = list.filter((x) => x && x.id && x.file);
    } catch (_) {
      /* 没有索引 / 索引坏了：当成空，reconcile 会把磁盘上的归档补回来 */
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      const tmp = this.indexFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
      fs.renameSync(tmp, this.indexFile);
    } catch (_) {
      /* 落盘失败不影响本进程内的使用 */
    }
  }

  _sort() {
    this.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /**
   * 同一分钟内连清两次会撞名（一条 11-14 00:49 分不清是哪次），
   * 撞上了先退到带秒；同一秒内还撞（脚本连着清）就加序号，
   * 名字必须唯一，否则用户没法指认「要删/要导出的是哪一条」。
   * 用户自己改的名字不做去重，那是他的选择。
   */
  _uniqueName(ts, exceptId) {
    const taken = new Set(this.items.filter((x) => x.id !== exceptId).map((x) => x.name));
    const base = defaultName(ts);
    if (!taken.has(base)) return base;
    const withSec = defaultName(ts, true);
    if (!taken.has(withSec)) return withSec;
    let n = 2;
    while (taken.has(`${withSec} (${n})`)) n += 1;
    return `${withSec} (${n})`;
  }

  /** 老版本留下的 .cleared-* 没进过索引，启动时补登记，不然它们在界面上凭空消失 */
  reconcile() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (_) {
      return 0;
    }
    const known = new Set(this.items.map((x) => x.file));
    let added = 0;
    for (const name of names) {
      const m = CLEARED_RE.exec(name);
      if (!m || known.has(name)) continue;
      const abs = this._abs(name);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch (_) {
        continue;
      }
      if (!size) continue;
      const ts = Number(m[2]);
      this.items.push({
        id: String(ts),
        file: name,
        name: this._uniqueName(ts),
        // 大文件别在启动路径上同步扫，点开时再数
        count: size <= COUNT_MAX_BYTES ? countLines(abs) : null,
        bytes: size,
        createdAt: ts,
      });
      added += 1;
    }
    // 索引里有、磁盘上已经没有的（用户手动删了文件），一并清掉
    const before = this.items.length;
    this.items = this.items.filter((x) => {
      try {
        return fs.statSync(this._abs(x.file)).isFile();
      } catch (_) {
        return false;
      }
    });
    const dropped = before - this.items.length;
    if (added || dropped) {
      this._sort();
      this._save();
    }
    return added;
  }

  list() {
    return this.items.map((x) => ({ ...x }));
  }

  find(id) {
    return this.items.find((x) => x.id === String(id)) || null;
  }

  add({ id, file, count = null, bytes, createdAt, name }) {
    const itemId = String(id);
    const prev = this.find(itemId);
    if (prev) {
      prev.count = count == null ? prev.count : count;
      prev.bytes = bytes || prev.bytes;
      this._save();
      return prev;
    }
    const custom = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
    const item = {
      id: itemId,
      file,
      name: custom || this._uniqueName(createdAt),
      count,
      bytes: Number(bytes) || 0,
      createdAt: Number(createdAt) || Date.now(),
    };
    this.items.push(item);
    this._sort();
    this._save();
    return item;
  }

  rename(id, name) {
    const item = this.find(id);
    if (!item) return null;
    const next = String(name == null ? '' : name)
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, NAME_MAX);
    if (!next) return { ...item, unchanged: true };
    item.name = next;
    this._save();
    return { ...item };
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === String(id));
    if (i < 0) return false;
    const [item] = this.items.splice(i, 1);
    try {
      fs.unlinkSync(this._abs(item.file));
    } catch (_) {
      /* 文件已经不在就算了，索引照删 */
    }
    this._save();
    return true;
  }

  clearAll() {
    const n = this.items.length;
    for (const item of this.items) {
      try {
        fs.unlinkSync(this._abs(item.file));
      } catch (_) {
        /* 单个失败不阻塞 */
      }
    }
    this.items = [];
    this._save();
    return n;
  }

  stats() {
    return {
      count: this.items.length,
      bytes: this.items.reduce((n, x) => n + (Number(x.bytes) || 0), 0),
    };
  }

  /**
   * 从归档里取一条完整记录（含 headers / body），点开详情用。
   * 从文件尾部往前找、命中即停：越近的请求越快，不用把几百 MB 扫一遍。
   * 同一 id 可能有「发起时」和「完成时」两行，倒序先遇到的是完成时那份。
   */
  getFlow(id, flowId) {
    const item = this.find(id);
    if (!item) return { error: 'not-found' };
    const abs = this._abs(item.file);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (_) {
      return { error: 'missing' };
    }
    const flow = findFlow(abs, size, flowId);
    if (!flow) return { error: 'flow-not-found' };
    return { flow, item: { ...item } };
  }

  /**
   * 读一页（新→旧）。cursor 是「已经读到文件哪个字节位置」，不传表示从文件尾开始。
   * 返回的 nextCursor 直接回传给下一次请求，前端不用理解它是什么。
   */
  page(id, { cursor, limit = 200, filters = {} } = {}) {
    const item = this.find(id);
    if (!item) return { error: 'not-found' };
    const abs = this._abs(item.file);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (_) {
      return { error: 'missing' };
    }
    const res = tailPage(abs, { size, cursor, limit, filters });
    // 顺手校准「一共多少条」：清空那一刻记的是内存里剩几条，文件里可能更多
    if (res.totalRead != null && res.totalRead !== item.count) {
      item.count = res.totalRead;
      this._save();
    }
    return { ...res, item: { ...item } };
  }

  /**
   * 导出整条归档。倒着读（跟回看同一套逻辑），倒序先遇到的是「完成态」，
   * 按 id 去重后天然拿到每条流量的最终状态，不用在正序里反复覆盖。
   * 结果仍是新→旧，调用方（HAR / JSON）自己决定顺序。
   */
  async exportFlows(id, { filters = {}, limit = EXPORT_MAX } = {}) {
    const item = this.find(id);
    if (!item) return { error: 'not-found' };
    const abs = this._abs(item.file);
    let size = 0;
    try {
      size = (await fs.promises.stat(abs)).size;
    } catch (_) {
      return { error: 'missing' };
    }
    const cap = Math.max(1, Math.min(Number(limit) || EXPORT_MAX, EXPORT_MAX));
    const flows = await readArchive(abs, { size, limit: cap, filters });
    return { flows, item: { ...item }, truncated: flows.length >= cap };
  }
}

/**
 * 从文件尾部倒序读一页。
 *
 * 为什么不用 readFileSync：归档能到几百 MB，用户点开一条历史就要整份读 + 全量
 * JSON.parse，主线程会卡好几秒。这里反向按块扫，只解析这一页需要的行。
 *
 * cursor 用字节偏移而不是行号：文件是追加写的，行号得从头数，越往后越慢。
 */
function tailPage(file, { size = null, cursor = null, limit = 200, filters = {} } = {}) {
  const total = size == null ? fs.statSync(file).size : size;
  let pos = Number.isFinite(Number(cursor)) && Number(cursor) > 0 ? Number(cursor) : total;
  if (pos > total) pos = total;
  const ok = prepareFilter(filters);
  const out = [];
  const seen = new Set();
  // 条数只在第一页算一次（用户点开记录那一刻），后续页不重复扫
  const wantTotal = cursor == null || !Number(cursor);
  let head = Buffer.alloc(0);
  let nextCursor = pos;
  const fd = fs.openSync(file, 'r');
  try {
    let stop = false;
    while (pos > 0 && !stop) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = head.length ? Buffer.concat([buf, head]) : buf;
      let end = data.length;
      let i = data.length - 1;
      while (i >= 0) {
        if (data[i] !== 0x0a) {
          i -= 1;
          continue;
        }
        const line = data.subarray(i + 1, end);
        end = i;
        if (line.length && takeLine(line, out, seen, ok, limit)) {
          // 这一页满了：游标停在这行的行首，下次从这里继续往前读
          nextCursor = pos + i + 1;
          stop = true;
          break;
        }
        i -= 1;
      }
      if (!stop) head = data.subarray(0, end);
    }
    // 走到文件开头：head 是第一行（前面没有换行了）
    if (!stop) {
      if (head.length) takeLine(head, out, seen, ok, limit);
      nextCursor = 0;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    flows: out,
    nextCursor,
    hasMore: nextCursor > 0,
    totalRead: wantTotal ? countMatching(file, filters) : null,
  };
}

/**
 * 导出用：整个归档倒着读一遍，凑够 limit 条就停。
 *
 * 跟 tailPage 的区别是不分页、要全量，所以用 awaits 的 fs 读 —— 几百 MB 的归档
 * 同步读会把控制台（含 SSE、代理）整条阻塞好几秒，用户会以为界面卡死了。
 */
async function readArchive(file, { size = null, limit = EXPORT_MAX, filters = {} } = {}) {
  const total = size == null ? (await fs.promises.stat(file)).size : size;
  const ok = prepareFilter(filters);
  const out = [];
  const seen = new Set();
  let pos = total;
  let head = Buffer.alloc(0);
  const fh = await fs.promises.open(file, 'r');
  try {
    let stop = false;
    while (pos > 0 && !stop) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, pos);
      const data = head.length ? Buffer.concat([buf, head]) : buf;
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const line = data.subarray(i + 1, end);
        end = i;
        if (!line.length) continue;
        const f = parseFlow(line, seen);
        if (f && ok(f)) {
          out.push(f);
          if (out.length >= limit) {
            stop = true;
            break;
          }
        }
      }
      if (!stop) head = data.subarray(0, end);
    }
    // 走到文件开头：head 是第一行（前面没有换行了）
    if (!stop && head.length) {
      const f = parseFlow(head, seen);
      if (f && ok(f)) out.push(f);
    }
  } finally {
    await fh.close();
  }
  return out;
}

/** 全文数一遍「满足筛选的条数」。只在打开一条历史的第一页调用。 */
function countMatching(file, filters) {
  const ok = prepareFilter(filters);
  const fd = fs.openSync(file, 'r');
  const CH = 1024 * 1024;
  const buf = Buffer.allocUnsafe(CH);
  const seen = new Set();
  let carry = Buffer.alloc(0);
  let n = 0;
  let pos = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CH, pos);
      if (!read) break;
      pos += read;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, read)])
        : Buffer.from(buf.subarray(0, read));
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue;
        const f = parseFlow(data.subarray(start, i), seen);
        start = i + 1;
        if (f && ok(f)) n += 1;
      }
      carry = data.subarray(start);
    }
    if (carry.length) {
      const f = parseFlow(carry, seen);
      if (f && ok(f)) n += 1;
    }
  } catch (_) {
    /* 读不动就返回已数到的 */
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

/** 单个 flow 的完整记录，从文件尾部倒着找，命中即停 */
function findFlow(file, size, flowId) {
  const want = String(flowId);
  let pos = size;
  let head = Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = head.length ? Buffer.concat([buf, head]) : buf;
      let end = data.length;
      let i = data.length - 1;
      while (i >= 0) {
        if (data[i] !== 0x0a) {
          i -= 1;
          continue;
        }
        const line = data.subarray(i + 1, end);
        end = i;
        if (line.length) {
          const f = parseFlow(line, null);
          if (f && String(f.id) === want) return f;
        }
        i -= 1;
      }
      head = data.subarray(0, end);
    }
    if (head.length) {
      const f = parseFlow(head, null);
      if (f && String(f.id) === want) return f;
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/** 解析一行 JSONL；补丁行 / 重复 id 一律丢掉（不传 seen 表示不做去重） */
function parseFlow(line, seen) {
  let f;
  try {
    f = JSON.parse(line.toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!f || f.__patch || !f.id) return null;
  if (seen) {
    if (seen.has(f.id)) return null;
    seen.add(f.id);
  }
  ensureDerived(f);
  return f;
}

/** 收一行；返回 true 表示这一页已经满了（调用方要停） */
function takeLine(line, out, seen, ok, limit) {
  const f = parseFlow(line, seen);
  if (!f || !ok(f)) return false;
  out.push(summary(f));
  return out.length >= limit;
}

module.exports = { FlowHistory, tailPage, defaultName };
