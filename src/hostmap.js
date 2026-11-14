'use strict';

/**
 * 域名映射（把请求实际发到另一台机器）。
 *
 * 用途：联调时把 `api.example.com` 指到本机 `127.0.0.1:8080` 或测试环境，
 * 客户端不用改代码、不用改 hosts、也不用一条条去断点里改 URL。
 *
 * 和断点的区别：断点要人守着（拦下来 → 手改 → 放行），映射是配一次一直生效。
 *
 * 只做逻辑与匹配，不碰 socket：代理层拿到结果后自己换上游地址。
 * 这样没有网络也能单测，规则错也不会把流量弄丢。
 */

const MAX_RULES = 60;
const MAX_TEXT = 200;

/** 把 `a.com/v1` 拆成 host 与路径前缀；host 允许 `*` 通配 */
function splitFrom(from) {
  const text = String(from || '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  const host = (slash < 0 ? text : text.slice(0, slash)).toLowerCase();
  const prefix = slash < 0 ? '' : text.slice(slash).replace(/\/+$/, '');
  if (!host) return null;
  return { host, prefix };
}

/**
 * 解析映射目标，三种写法都认：
 *   127.0.0.1:8080             只换地址，协议与路径不变
 *   http://127.0.0.1:8080      顺带把 https 降成明文（本地服务通常没有证书）
 *   http://127.0.0.1:8080/api  再把路径前缀换掉
 */
function parseTo(to) {
  const text = String(to || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch (_) {
    return null;
  }
  const scheme = text.includes('://') ? url.protocol.replace(':', '') : '';
  // URL 会把 IPv6 的方括号带在 hostname 里，转发时要还原成裸地址
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  // 没写协议时不要吞掉 URL 解析给的默认 80：要能区分「没写端口」和「写了 80」
  const explicitPort = /^\[?[^\]]*\]?:\d+/.test(text.replace(/^[a-z]+:\/\//i, ''));
  const port = explicitPort ? Number(url.port) || (url.protocol === 'https:' ? 443 : 80) : 0;
  return {
    scheme,
    host,
    port,
    prefix: (url.pathname || '').replace(/\/+$/, ''),
    label: port ? `${host}:${port}` : host,
  };
}

function normRule(r, i) {
  const from = splitFrom(r && r.from);
  const to = parseTo(r && r.to);
  if (!from || !to) return null;
  return {
    id: String((r && r.id) || `hm${i + 1}`).slice(0, 40),
    from: String(r.from).trim().slice(0, MAX_TEXT),
    to: String(r.to).trim().slice(0, MAX_TEXT),
    enabled: !(r && r.enabled === false),
    // 解析结果缓存下来，匹配时不用每条请求都 new URL
    _from: from,
    _to: to,
  };
}

/** host 匹配：允许 `*` 占一段，其余按字面比（忽略大小写） */
function hostMatch(pattern, host) {
  if (pattern === host) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i'
  );
  return re.test(host);
}

class HostMap {
  constructor(state) {
    this.enabled = false;
    this.rules = [];
    if (state) this.setState(state);
  }

  /** 整体替换（控制台保存时一次给全） */
  setState(state) {
    const s = state || {};
    if (s.enabled !== undefined) this.enabled = !!s.enabled;
    if (Array.isArray(s.rules)) {
      this.rules = s.rules
        .slice(0, MAX_RULES)
        .map(normRule)
        .filter(Boolean);
    }
    return this.state();
  }

  state() {
    return {
      enabled: this.enabled,
      rules: this.rules.map((r) => ({ id: r.id, from: r.from, to: r.to, enabled: r.enabled })),
    };
  }

  /** 命中哪条规则（按配置顺序，第一条为准）；没开或没命中返回 null */
  match(target) {
    if (!this.enabled || !this.rules.length || !target) return null;
    const host = String(target.hostname || '').toLowerCase();
    const path = (target.pathname || '/') + (target.search || '');
    for (const r of this.rules) {
      if (!r.enabled) continue;
      if (!hostMatch(r._from.host, host)) continue;
      if (r._from.prefix && !path.startsWith(r._from.prefix)) continue;
      return r;
    }
    return null;
  }

  /**
   * 算出真正要连的上游地址。
   * 路径规则：先去掉 from 里写的前缀，再拼上 to 里写的前缀 ——
   * 两边都没写就是原样照搬。
   */
  apply(target, rule) {
    const r = rule || this.match(target);
    if (!r) return null;
    const path = (target.pathname || '/') + (target.search || '');
    const rest = r._from.prefix ? path.slice(r._from.prefix.length) : path;
    let out = (r._to.prefix || '') + rest;
    if (!out) out = '/';
    if (!out.startsWith('/')) out = '/' + out;
    const scheme = r._to.scheme || target.protocol.replace(':', '');
    const port = r._to.port || (scheme === 'https' ? 443 : 80);
    return { scheme, host: r._to.host, port, path: out, label: r._to.label, ruleId: r.id };
  }
}

module.exports = { HostMap, splitFrom, parseTo };
