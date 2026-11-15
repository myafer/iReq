'use strict';

/**
 * 派生列：把响应 JSON 里的一个字段提出来，变成列表里的一列。
 *
 * 排障时最省眼的功能 —— `data.items[0].id`、`result.traceId` 这类字段
 * 每次都要点开详情翻 JSON，提成列之后一眼就能扫。
 *
 * 路径写法：
 *   data.items[0].id     点号 + 方括号下标（下标也可以写成 .0）
 *   $.data.items[0].id   $ 前缀可写可不写
 *   req.body.userId      加 req. 前缀取请求体（默认是响应体）
 *   h:content-type       取响应头（h: 前缀）
 *
 * 纯函数，脱离网络就能单测。
 */

const MAX_COLUMNS = 4;
const MAX_TEXT = 64;

/** 把 "a.b[0].c" 拆成 ['a','b',0,'c']；非法路径返回 null */
function parsePath(raw) {
  let s = String(raw || '').trim();
  let side = 'res';
  if (!s) return null;
  const h = /^h:\s*(.+)$/i.exec(s);
  if (h) return { kind: 'header', side: 'res', name: h[1].trim().toLowerCase() };
  if (/^req\./i.test(s)) {
    side = 'req';
    s = s.slice(4);
  } else if (/^res\./i.test(s)) {
    s = s.slice(4);
  }
  s = s.replace(/^\$\.?/, '');
  if (!s) return null;

  const tokens = [];
  // 逐字符扫描：标识符 / [n] 下标 / 点号分隔。其它写法（过滤表达式等）一律判非法，
  // 免得写错时静默变成空列，用户以为工具坏了。
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const m = /^\[(\d+)\]/.exec(s.slice(i));
      if (!m) return null;
      tokens.push(Number(m[1]));
      i += m[0].length;
      continue;
    }
    const m = /^[^.[\]]+/.exec(s.slice(i));
    if (!m) return null;
    const seg = m[0];
    tokens.push(/^\d+$/.test(seg) ? Number(seg) : seg);
    i += seg.length;
  }
  if (!tokens.length) return null;
  return { kind: 'json', side, tokens };
}

function pick(obj, tokens) {
  let cur = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = cur[t];
    }
  }
  return cur;
}

/** 展示用：对象/数组压成一行，长文本截断；null / undefined 给空串 */
function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s;
  try {
    s = JSON.stringify(v);
  } catch (_) {
    return '';
  }
  if (!s) return '';
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
}

/** 按需解析 body：同一条 flow 的多个列共用一次 JSON.parse */
function bodyJson(flow, side) {
  const raw = side === 'req' ? flow.reqBody : flow.resBody;
  if (typeof raw !== 'string' || !raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

/**
 * 给一条 flow 算派生列，返回 { 列 id: 展示文本 }。
 * 解析失败的列给空串（不写错误信息，列表里塞满报错比空白更吵）。
 */
function applyColumns(flow, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  if (!flow || !cols.length) return null;
  const cache = {};
  const out = {};
  let any = false;
  for (const col of cols) {
    if (!col || !col.id) continue;
    const spec = typeof col.path === 'string' ? parsePath(col.path) : null;
    if (!spec) continue;
    let value;
    if (spec.kind === 'header') {
      const headers = flow.resHeaders || {};
      value = headers[spec.name];
    } else {
      if (!(spec.side in cache)) cache[spec.side] = bodyJson(flow, spec.side);
      value = pick(cache[spec.side], spec.tokens);
    }
    out[col.id] = formatValue(value);
    any = true;
  }
  return any ? out : null;
}

/** 配置归一化：最多 4 列，名字和路径都必须有 */
function normalizeColumns(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c) continue;
    const name = String(c.name || '').trim().slice(0, 24);
    const path = String(c.path || '').trim().slice(0, 200);
    if (!name || !path || !parsePath(path)) continue;
    let id = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 32);
    if (!id || seen.has(id)) id = 'col' + (out.length + 1);
    seen.add(id);
    out.push({ id, name, path });
    if (out.length >= MAX_COLUMNS) break;
  }
  return out;
}

module.exports = { parsePath, pick, formatValue, applyColumns, normalizeColumns, MAX_COLUMNS };
