'use strict';

/**
 * 导入 HAR：把别人给的抓包文件变成这里的一份「历史记录」。
 *
 * 为什么落成历史记录而不是塞进实时列表：HAR 是别人某个时间点的快照，混进实时列表会
 * 让人分不清「刚抓的」和「别人给的」。历史记录本来就是「一批流量的快照」，语义正好，
 * 而且回看、重放、导出、对比这些链路全都现成。
 */

const fs = require('fs');
const path = require('path');
const { ensureDerived } = require('./store');
const { routeOf } = require('./derive');

/** 一次最多导这么多条：再多就该在源头裁剪了，塞进来只会让回看卡住 */
const MAX_ENTRIES = 5000;
/** 单条 body 上限，超过就截断（HAR 里偶有几十 MB 的视频段） */
const MAX_BODY = 4 * 1024 * 1024;

function headerObject(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    if (!h || !h.name) continue;
    const k = String(h.name).toLowerCase();
    const v = Array.isArray(h.value) ? h.value.join(', ') : String(h.value == null ? '' : h.value);
    // 同名头出现过就按规范用 ", " 合并，跟 Node 的 req.headers 习惯一致
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

/** HAR 的 content / postData 可能是明文，也可能标了 base64 */
function bodyOf(content) {
  if (!content || typeof content !== 'object') return { text: '', base64: null, size: 0, truncated: false };
  const raw = content.text == null ? '' : String(content.text);
  const isB64 = String(content.encoding || '').toLowerCase() === 'base64';
  if (!raw) {
    const size = Number(content.size) || 0;
    return { text: '', base64: null, size, truncated: false };
  }
  if (isB64) {
    // 已经是 base64 就原样存：界面那边认这个字段，语义和实时抓到的二进制一致
    const size = Math.floor((raw.length * 3) / 4);
    return { text: null, base64: raw, size, truncated: false };
  }
  const truncated = raw.length > MAX_BODY;
  return {
    text: truncated ? raw.slice(0, MAX_BODY) : raw,
    base64: null,
    size: Buffer.byteLength(raw, 'utf8'),
    truncated,
  };
}

/** HAR entry → 这里的 flow 结构（字段名与实时抓包一致，前端才不用分两套逻辑） */
function entryToFlow(entry, i, baseTs) {
  const req = entry.request || {};
  const res = entry.response || {};
  let url;
  try {
    url = new URL(String(req.url || ''));
  } catch (_) {
    return null;
  }
  const started = Date.parse(entry.startedDateTime || '') || baseTs + i;
  const reqBody = bodyOf(req.postData);
  const resBody = bodyOf(res.content);
  const flow = {
    id: `h${started}-${i}`,
    ts: started,
    method: String(req.method || 'GET').toUpperCase(),
    url: url.toString(),
    host: url.hostname,
    scheme: url.protocol.replace(':', ''),
    path: (url.pathname || '/') + (url.search || ''),
    route: routeOf(req.method, url.pathname || '/'),
    reqHeaders: headerObject(req.headers),
    resHeaders: headerObject(res.headers),
    reqBody: reqBody.text,
    reqBodyBase64: reqBody.base64,
    reqBodyTruncated: reqBody.truncated,
    reqSize: reqBody.size,
    resBody: resBody.text,
    resBodyBase64: resBody.base64,
    resBodyTruncated: resBody.truncated,
    resSize: Number(resBody.size) || Number(res.content && res.content.size) || 0,
    resContentType: (res.content && res.content.mimeType) || '',
    status: Number(res.status) || 0,
    statusText: String(res.statusText || ''),
    duration: Number(entry.time) || 0,
    // 来源标记：界面上一眼能看出「这批是从文件导进来的」，别和本机抓的混了
    imported: true,
    app: 'HAR 导入',
    appSource: 'import',
  };
  if (url.protocol === 'https:') flow.httpVersion = flow.httpVersion || 'HTTP/1.1';
  try {
    ensureDerived(flow);
    // ensureDerived 会按 UA 覆盖 app：导入的流量保留来源标记更利于排查，但也别丢 UA 推断
    if (flow.app && flow.app !== 'HAR 导入') flow.appSource = flow.appSource || 'ua';
  } catch (_) {
    /* 派生失败不影响导入 */
  }
  return flow;
}

/**
 * 解析并落盘成一份历史记录。
 * 返回 { ok, file, count, bytes, skipped, id, name } 或 { ok:false, error }
 */
function importHar({ text, dir, name, history, now = Date.now() }) {
  let har;
  try {
    har = JSON.parse(String(text || ''));
  } catch (_) {
    return { ok: false, error: '不是合法的 JSON，可能选错了文件' };
  }
  const log = har && har.log;
  const entries = log && Array.isArray(log.entries) ? log.entries : null;
  if (!entries) return { ok: false, error: '这个文件里没有 HAR 的 log.entries，确认一下是不是抓包导出文件' };
  if (!entries.length) return { ok: false, error: '这份 HAR 里一条请求都没有' };

  const picked = entries.slice(0, MAX_ENTRIES);
  const lines = [];
  let skipped = 0;
  for (let i = 0; i < picked.length; i += 1) {
    const flow = entryToFlow(picked[i], i, now);
    if (!flow) {
      skipped += 1;
      continue;
    }
    lines.push(JSON.stringify(flow));
  }
  if (!lines.length) return { ok: false, error: 'HAR 里的请求都解析不出地址，无法导入' };

  const stamp = now;
  const day = new Date(stamp).toISOString().slice(0, 10);
  const file = `flows-${day}.jsonl.cleared-${stamp}`;
  const abs = path.join(dir, file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, lines.join('\n') + '\n');
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }

  const bytes = fs.statSync(abs).size;
  // 名字优先用调用方给的，其次 HAR 里的页面标题，最后退回默认的时间名
  const title = String(
    (name || (log.pages && log.pages[0] && log.pages[0].title) || '').trim()
  ).slice(0, 60);
  const item = history
    ? history.add({
        id: String(stamp),
        file,
        count: lines.length,
        bytes,
        createdAt: stamp,
        name: title ? `${title}` : undefined,
      })
    : null;

  return {
    ok: true,
    id: String(stamp),
    file,
    count: lines.length,
    bytes,
    skipped,
    total: entries.length,
    truncated: entries.length > MAX_ENTRIES,
    name: item ? item.name : title,
  };
}

module.exports = { importHar, entryToFlow, MAX_ENTRIES };
