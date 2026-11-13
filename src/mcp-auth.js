'use strict';

/**
 * MCP 授权：令牌签发 / 校验 / 撤销 + 审计 + 限流。
 *
 * 设计取舍：
 * - 令牌明文只在校验时短暂存在，落盘只存 sha256(salt + token)。
 *   令牌本身是 crypto.randomBytes(24) 的 base64url（192bit 熵），不需要慢哈希抗爆破。
 * - 一个令牌一组 scope：read 只读（流量 / 规则 / 状态），write 可改规则、弱网、白名单。
 * - 校验失败一律返回同一个原因（避免区分「令牌不存在 / 已撤销 / 过期」被打探）。
 * - 审计只进内存环形缓冲 + 可选落盘 JSONL（超 512KB 轮转一次），界面显示最近 N 条。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { savePersistedConfig } = require('./user-config');

const TOKEN_PREFIX = 'ireq_mcp_';
const SCOPES = ['read', 'write'];
const AUDIT_MAX = 400;
const AUDIT_FILE_BYTES = 512 * 1024;
/* 限流：单个令牌 60 秒内最多 240 次调用（本地 AI 客户端远用不到这么多） */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 240;

function newRawToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function hashToken(raw, salt) {
  return crypto.createHash('sha256').update(salt + ':' + raw).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 对外展示的令牌指纹：前缀 + 首尾各 4 位，足够人眼区分，不足以还原 */
function maskToken(prefix) {
  const p = String(prefix || '');
  return p ? p.slice(0, TOKEN_PREFIX.length + 4) + '…' : '';
}

class McpAuth {
  constructor({ config, dataDir }) {
    this.config = config;
    this.dataDir = dataDir || null;
    this.auditLog = [];
    this.rate = new Map(); // tokenId -> { windowStart, count }
    this._dirtyTokens = 0;
    this._lastSave = 0;
    this._ensure();
    this._loadAudit();
  }

  /* ---------------- 配置 ---------------- */

  _ensure() {
    if (!this.config.mcp || typeof this.config.mcp !== 'object') {
      this.config.mcp = { enabled: false, tokens: [] };
    }
    const m = this.config.mcp;
    if (!Array.isArray(m.tokens)) m.tokens = [];
    m.enabled = m.enabled === true;
    for (const t of m.tokens) {
      if (!Array.isArray(t.scopes) || !t.scopes.length) t.scopes = ['read'];
      t.scopes = t.scopes.filter((s) => SCOPES.includes(s));
      if (!t.scopes.length) t.scopes = ['read'];
    }
  }

  get enabled() {
    return this.config.mcp.enabled === true;
  }

  setEnabled(on) {
    this.config.mcp.enabled = on === true;
    this._save();
    return this.enabled;
  }

  _save() {
    if (!this.dataDir) return;
    try {
      savePersistedConfig(this.dataDir, this.config);
    } catch {
      /* 磁盘只读不影响主功能 */
    }
  }

  /** 调用频繁时把 lastUsedAt / calls 攒一攒再落盘，别每个请求都写文件 */
  _touchSoon() {
    this._dirtyTokens += 1;
    const now = Date.now();
    if (this._dirtyTokens >= 20 || now - this._lastSave > 15000) {
      this._lastSave = now;
      this._dirtyTokens = 0;
      this._save();
    }
  }

  /* ---------------- 令牌 ---------------- */

  /** 界面用：不含 hash / salt */
  listTokens() {
    return this.config.mcp.tokens
      .map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        masked: maskToken(t.prefix),
        scopes: t.scopes,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt || 0,
        calls: t.calls || 0,
        expiresAt: t.expiresAt || 0,
        expired: Boolean(t.expiresAt && t.expiresAt < Date.now()),
        revoked: t.revoked === true,
      }))
      .filter((t) => !t.revoked)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 返回 { token, entry }；token 只在这里出现一次，之后无法再取回 */
  createToken({ name, scopes, expiresInDays } = {}) {
    const raw = newRawToken();
    const salt = crypto.randomBytes(12).toString('hex');
    const list = SCOPES.filter((s) => (Array.isArray(scopes) ? scopes.includes(s) : scopes !== 'read-only'));
    const days = Number(expiresInDays);
    const entry = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 40) || '未命名令牌',
      prefix: raw.slice(0, TOKEN_PREFIX.length + 8),
      salt,
      hash: hashToken(raw, salt),
      scopes: list.length ? list : ['read'],
      createdAt: Date.now(),
      lastUsedAt: 0,
      calls: 0,
      expiresAt: Number.isFinite(days) && days > 0 ? Date.now() + days * 86400000 : 0,
    };
    this.config.mcp.tokens.push(entry);
    this._save();
    return { token: raw, entry: this.listTokens().find((t) => t.id === entry.id) };
  }

  revokeToken(id) {
    const t = this.config.mcp.tokens.find((x) => x.id === id);
    if (!t) return false;
    /* 真删掉而不是打标记，免得「已撤销但 hash 还在」被误判 */
    this.config.mcp.tokens = this.config.mcp.tokens.filter((x) => x.id !== id);
    this.rate.delete(id);
    this._save();
    return true;
  }

  /**
   * 校验 Authorization: Bearer <token>。
   * 返回 { ok, token:{id,name,scopes}, reason }
   */
  verify(header, { ip } = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    const raw = extractBearer(header);
    if (!raw) return { ok: false, reason: 'missing' };
    if (!raw.startsWith(TOKEN_PREFIX) || raw.length < TOKEN_PREFIX.length + 20) {
      return { ok: false, reason: 'invalid' };
    }
    let matched = null;
    for (const t of this.config.mcp.tokens) {
      if (t.revoked) continue;
      if (safeEqualHex(hashToken(raw, t.salt), t.hash)) {
        matched = t;
        break;
      }
    }
    if (!matched) return { ok: false, reason: 'invalid' };
    if (matched.expiresAt && matched.expiresAt < Date.now()) {
      return { ok: false, reason: 'invalid' };
    }
    /* 限流：滑动窗口，超了就 429（别把审计日志也刷爆） */
    const now = Date.now();
    const slot = this.rate.get(matched.id) || { windowStart: now, count: 0 };
    if (now - slot.windowStart > RATE_WINDOW_MS) {
      slot.windowStart = now;
      slot.count = 0;
    }
    slot.count += 1;
    this.rate.set(matched.id, slot);
    if (slot.count > RATE_MAX) {
      return { ok: false, reason: 'rate', token: { id: matched.id, name: matched.name, scopes: matched.scopes } };
    }
    matched.lastUsedAt = now;
    matched.calls = (matched.calls || 0) + 1;
    this._touchSoon();
    return {
      ok: true,
      token: { id: matched.id, name: matched.name, scopes: matched.scopes, ip: ip || '' },
    };
  }

  static allows(token, scope) {
    if (!token) return false;
    if (scope === 'read') return true; // 有令牌就能读
    return Array.isArray(token.scopes) && token.scopes.includes('write');
  }

  /* ---------------- 审计 ---------------- */

  _auditFile() {
    return this.dataDir ? path.join(this.dataDir, 'mcp-audit.jsonl') : null;
  }

  _loadAudit() {
    const file = this._auditFile();
    if (!file) return;
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-AUDIT_MAX);
      for (const line of lines) {
        try {
          this.auditLog.push(JSON.parse(line));
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 还没有审计文件 */
    }
  }

  record(entry) {
    const row = {
      at: Date.now(),
      token: entry.token ? entry.token.name : '',
      tokenId: entry.token ? entry.token.id : '',
      ip: entry.ip || '',
      method: entry.method || '',
      tool: entry.tool || '',
      ok: entry.ok !== false,
      ms: Math.max(0, Math.round(entry.ms || 0)),
      error: entry.error ? String(entry.error).slice(0, 200) : '',
    };
    this.auditLog.push(row);
    if (this.auditLog.length > AUDIT_MAX) this.auditLog.splice(0, this.auditLog.length - AUDIT_MAX);
    const file = this._auditFile();
    if (!file) return row;
    try {
      try {
        if (fs.statSync(file).size > AUDIT_FILE_BYTES) fs.renameSync(file, file + '.1');
      } catch {
        /* 首次写入 */
      }
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch {
      /* 审计落盘失败不影响调用 */
    }
    return row;
  }

  /** 最近的审计记录（新的在前） */
  audit(limit = 20) {
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    return this.auditLog.slice(-n).reverse();
  }

  clearAudit() {
    this.auditLog = [];
    const file = this._auditFile();
    if (file) {
      try {
        fs.rmSync(file, { force: true });
        fs.rmSync(file + '.1', { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 月度统计用：总调用数 / 最近一次调用时间 */
  stats() {
    const tokens = this.config.mcp.tokens;
    return {
      enabled: this.enabled,
      tokens: tokens.length,
      calls: tokens.reduce((a, t) => a + (t.calls || 0), 0),
      lastUsedAt: tokens.reduce((a, t) => Math.max(a, t.lastUsedAt || 0), 0),
    };
  }
}

function extractBearer(header) {
  const raw = String(header || '').trim();
  if (!raw) return '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : raw).trim();
}

module.exports = { McpAuth, SCOPES, TOKEN_PREFIX, maskToken };
