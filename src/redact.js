'use strict';

/**
 * 脱敏：把凭据从「对外输出」里摘掉。
 *
 * 边界很关键 —— **只作用于导出文件与 MCP 输出，界面永远显示原值**。
 * 界面也打码的话，这个工具就没法调试了（你没法确认到底是哪个 token 失效）。
 * 所以这里只有纯函数，调用方决定什么时候用。
 *
 * 默认开：导出 HAR 贴进工单是最高频的泄漏路径，比「突然发现 token 变空了」严重得多。
 */

const PLACEHOLDER = '[REDACTED]';

/** 默认要打码的头：凭据优先。存的是小写名，比较时统一小写 */
const DEFAULT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
  'x-secret',
  'x-signature',
  'x-sign',
];

/** 默认要打码的字段：凭据与密钥。PII（手机 / 身份证 / 邮箱）要用户显式打开 */
const DEFAULT_FIELDS = [
  'password',
  'passwd',
  'pwd',
  'pass',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'secret',
  'client_secret',
  'private_key',
  'api_key',
  'apikey',
  'session_id',
  'sessionid',
  'cookie',
  'authorization',
  'credential',
  'credentials',
];

/** 勾了「个人隐私」之后再额外打码的字段 */
const PII_FIELDS = ['phone', 'mobile', 'phone_number', 'tel', 'id_card', 'idcard', 'id_number', 'email', 'address', 'real_name'];

/** 查询串里要打码的参数名（= 凭据 + 隐私的超集，但只在名字精确匹配时生效） */
const QUERY_NAMES = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'authorization',
  'api_key',
  'apikey',
  'key',
  'secret',
  'sign',
  'signature',
  'session_id',
  'sessionid',
  'password',
  'pwd',
  'ticket',
  'phone',
  'mobile',
  'id_card',
  'email',
];

/** 键名归一：去大小写与下划线 / 连字符，`accessToken` 与 `access_token` 应该同样命中 */
function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

function setOf(list) {
  const s = new Set();
  for (const x of list || []) {
    const n = norm(x);
    if (n) s.add(n);
  }
  return s;
}

/** 认证头的 scheme 要留着：`Bearer xxx` 与 `Basic xxx` 的差别有诊断价值 */
function redactAuthValue(value) {
  const s = String(value);
  const m = /^(Bearer|Basic|Digest|Negotiate|Token|Bot)\s+/i.exec(s);
  return m ? `${m[1]} ${PLACEHOLDER}` : PLACEHOLDER;
}

function isAuthHeader(name) {
  const n = String(name || '').toLowerCase();
  return n === 'authorization' || n === 'proxy-authorization';
}

/* ---------------- 配置 ---------------- */

/**
 * 配置归一。额外名单接受数组，也接受「逗号 / 换行分隔的字符串」（界面里就是一个输入框）
 */
function normalize(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const extraHeaders = []
    .concat(listOf(src.extraHeaders), splitList(src.extraHeaderText))
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
  const extraFields = []
    .concat(listOf(src.extraFields), splitList(src.extraFieldText))
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 100);
  return {
    enabled: src.enabled !== false,
    headers: src.headers !== false,
    query: src.query !== false,
    body: src.body !== false,
    pii: src.pii === true,
    extraHeaders: [...new Set(extraHeaders)],
    extraFields: [...new Set(extraFields)],
  };
}

/** 数组 / 字符串都收：界面上是一个输入框，配置文件里是数组 */
function listOf(v) {
  if (Array.isArray(v)) return v;
  return splitList(v);
}

function splitList(v) {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 这一份配置实际生效的头 / 字段名单（界面用来展示，测试用来断言） */
function lists(cfg) {
  const c = normalize(cfg);
  const headers = new Set(DEFAULT_HEADERS);
  for (const h of c.extraHeaders) headers.add(String(h).toLowerCase());
  // fields / query 都按归一后的名字比较（access_token ≡ accessToken ≡ access-token）
  const fields = setOf(DEFAULT_FIELDS);
  for (const f of c.extraFields) fields.add(norm(f));
  if (c.pii) for (const f of PII_FIELDS) fields.add(norm(f));
  const query = setOf(QUERY_NAMES);
  for (const f of c.extraFields) query.add(norm(f));
  if (c.pii) for (const f of PII_FIELDS) query.add(norm(f));
  return { headers, fields, query };
}

/* ---------------- 各部分的脱敏 ---------------- */

/** 头部：值整体替换，类型（数组）保持不变 */
function redactHeaders(headers, { headers: set }, counter) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!set.has(k.toLowerCase())) {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) out[k] = v.map((x) => (isAuthHeader(k) ? redactAuthValue(x) : PLACEHOLDER));
    else out[k] = isAuthHeader(k) ? redactAuthValue(v) : PLACEHOLDER;
    counter.n += Array.isArray(v) ? v.length : 1;
    counter.parts.add('headers');
  }
  return out;
}

/** URL 查询串：只换命中的那几个参数，其余原样（排序与编码都别动，方便对照） */
function redactUrl(url, { query: set }, counter) {
  const s = String(url || '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const hash = s.indexOf('#', q);
  const head = s.slice(0, q);
  const search = s.slice(q + 1, hash < 0 ? undefined : hash);
  const tail = hash < 0 ? '' : s.slice(hash);
  let hit = 0;
  const parts = search.split('&').map((pair) => {
    if (!pair) return pair;
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const name = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    if (!set.has(norm(name))) return pair;
    hit += 1;
    return `${pair.slice(0, eq)}=${encodeURIComponent(PLACEHOLDER)}`;
  });
  if (!hit) return s;
  counter.n += hit;
  counter.parts.add('query');
  return `${head}?${parts.join('&')}${tail}`;
}

/** JSON：递归走一遍，键名命中的把值换掉（结构保留，数组里的对象同样处理） */
function redactJsonValue(value, fieldSet, counter, depth) {
  if (depth > 24) return value;
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, fieldSet, counter, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (fieldSet.has(norm(k)) && !(v && typeof v === 'object')) {
        out[k] = typeof v === 'string' ? PLACEHOLDER : PLACEHOLDER;
        counter.n += 1;
        counter.parts.add('body');
      } else if (fieldSet.has(norm(k)) && v && typeof v === 'object') {
        // 命中名字但是个对象：把里面所有标量换成占位，保留形状
        out[k] = blankScalars(v, counter);
      } else {
        out[k] = redactJsonValue(v, fieldSet, counter, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function blankScalars(value, counter) {
  if (Array.isArray(value)) return value.map((v) => blankScalars(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = blankScalars(v, counter);
    return out;
  }
  counter.n += 1;
  counter.parts.add('body');
  return PLACEHOLDER;
}

const TEXT_RE =
  /("?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|session[_-]?id|authorization)"?\s*[:=]\s*)("?)([^"'&\s,;}]+)/gi;

/** 正文：JSON 走结构化替换，表单按 & 拆，其它文本用键值正则兜底 */
function redactBodyText(text, contentType, fieldSet, counter) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const ct = String(contentType || '').toLowerCase();

  if (ct.includes('x-www-form-urlencoded')) {
    let hit = 0;
    const out = s
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const name = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
        if (!fieldSet.has(norm(name))) return pair;
        hit += 1;
        return `${pair.slice(0, eq)}=${encodeURIComponent(PLACEHOLDER)}`;
      })
      .join('&');
    if (hit) {
      counter.n += hit;
      counter.parts.add('body');
    }
    return out;
  }

  // 图形 / 压缩 / base64 的正文不硬解：乱码里做替换只会把文件弄坏
  if (ct && !/json|text|javascript|xml|x-ndjson|graphql/i.test(ct)) return s;

  const trimmed = s.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      const out = redactJsonValue(obj, fieldSet, counter, 0);
      const pretty = s.includes('\n') ? JSON.stringify(out, null, 2) : JSON.stringify(out);
      return pretty;
    } catch (_) {
      /* 不是合法 JSON（可能被截断），落到下面的文本兜底 */
    }
  }

  let hit = 0;
  const out = s.replace(TEXT_RE, (m, head, quote) => {
    hit += 1;
    return `${head}${quote}${PLACEHOLDER}`;
  });
  if (hit) {
    counter.n += hit;
    counter.parts.add('body');
  }
  return out;
}

/* ---------------- 整条 flow ---------------- */

/**
 * 脱敏一条 flow，返回**副本**（绝不改 store 里的对象）。
 * 返回值的 `_redactions` 是本条打了多少处，0 表示这条没有敏感内容。
 */
function redactFlow(flow, cfg, columns) {
  const c = normalize(cfg);
  if (!c.enabled || !flow || typeof flow !== 'object') return flow;
  const sets = lists(c);
  const counter = { n: 0, parts: new Set() };
  const out = { ...flow };

  if (c.query) {
    out.url = redactUrl(flow.url, sets, counter);
    // 列表用的是相对路径（含查询串），不一起打码等于 url 白改了
    if (typeof flow.path === 'string') out.path = redactUrl(flow.path, sets, counter);
  }
  if (c.headers) {
    out.reqHeaders = redactHeaders(flow.reqHeaders, sets, counter);
    out.resHeaders = redactHeaders(flow.resHeaders, sets, counter);
  }
  if (c.body) {
    const reqCt = headerOf(flow.reqHeaders, 'content-type');
    const resCt = headerOf(flow.resHeaders, 'content-type');
    if (typeof flow.reqBody === 'string' && flow.reqBody) {
      out.reqBody = redactBodyText(flow.reqBody, reqCt, sets.fields, counter);
      // 打了码就不再给 base64：否则同一个正文有两个版本，取哪个全凭读者
      if (out.reqBody !== flow.reqBody) delete out.reqBodyBase64;
    }
    if (typeof flow.resBody === 'string' && flow.resBody) {
      out.resBody = redactBodyText(flow.resBody, resCt, sets.fields, counter);
      if (out.resBody !== flow.resBody) delete out.resBodyBase64;
    }
    // 帧 / 消息的预览里也可能带 token
    if (Array.isArray(flow.wsFrames)) {
      out.wsFrames = flow.wsFrames.map((f) => {
        if (!f || typeof f.preview !== 'string' || !f.preview) return f;
        const p = redactBodyText(f.preview, 'text/plain', sets.fields, counter);
        return p === f.preview ? f : { ...f, preview: p };
      });
    }
    if (Array.isArray(flow.sseMessages)) {
      out.sseMessages = flow.sseMessages.map((m) => {
        if (!m || typeof m.preview !== 'string' || !m.preview) return m;
        const p = redactBodyText(m.preview, 'text/plain', sets.fields, counter);
        return p === m.preview ? m : { ...m, preview: p };
      });
    }
  }
  // 派生列：键是列 id，看不出含义，得靠列配置里的 path / 名字判断
  if (flow.derived && typeof flow.derived === 'object' && Array.isArray(columns)) {
    const d = { ...flow.derived };
    for (const col of columns) {
      if (!col || !col.id) continue;
      const last = String(col.path || '')
        .replace(/^h:/i, '')
        .split(/[.[\]]+/)
        .filter(Boolean)
        .pop();
      const hot = sets.fields.has(norm(last)) || sets.fields.has(norm(col.name));
      if (!hot) continue;
      if (typeof d[col.id] !== 'string' || d[col.id] === PLACEHOLDER) continue;
      d[col.id] = PLACEHOLDER;
      counter.n += 1;
      counter.parts.add('derived');
    }
    out.derived = d;
  }

  if (counter.n) out._redactions = counter.n;
  return out;
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return '';
}

/** 批量脱敏，顺便给出总计数（导出时写进 HAR 的 comment / 响应头） */
function redactFlows(flows, cfg, columns) {
  const c = normalize(cfg);
  if (!c.enabled) return { flows, count: 0, enabled: false };
  let count = 0;
  const out = (flows || []).map((f) => {
    const r = redactFlow(f, c, columns);
    if (r && r._redactions) {
      count += r._redactions;
      const copy = { ...r };
      delete copy._redactions;
      return copy;
    }
    return r;
  });
  return { flows: out, count, enabled: true };
}

/** 给界面用的一句话说明：这次会打哪些地方 */
function describe(cfg) {
  const c = normalize(cfg);
  if (!c.enabled) return [];
  const out = [];
  if (c.headers) out.push('请求头 / 响应头');
  if (c.query) out.push('URL 查询参数');
  if (c.body) out.push('正文里的凭据字段');
  if (c.pii) out.push('手机号 / 身份证 / 邮箱');
  return out;
}

module.exports = {
  PLACEHOLDER,
  DEFAULT_HEADERS,
  DEFAULT_FIELDS,
  PII_FIELDS,
  QUERY_NAMES,
  normalize,
  lists,
  describe,
  redactFlow,
  redactFlows,
  redactHeaders,
  redactUrl,
  redactBodyText,
};
