'use strict';

/**
 * 反向代理：抓「打向本机服务」的请求。
 *
 * 正向代理只能看见客户端主动发给别人的请求，而 webhook / 回调 / 网关转发
 * 是服务端被动收到的 —— 那类问题（签名不对、重试了三次、回调丢了字段）
 * 正向代理一条都看不见。这里起一个端口，收到什么就转发给配置的上游，
 * 记录链路与正向代理完全共用（规则 / 断点 / 脚本 / 弱网都照常生效）。
 */

const DEFAULT_PORT = 8090;

function normalize(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  let target = String(src.target || '').trim();
  // 只写 host:port 时按 http 补全；已经带了 scheme 的（哪怕是 ftp://）不要瞎补，
  // 否则会变成 http://ftp://a.com 这种「看着合法」的地址
  if (target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = 'http://' + target;
  let parsed = null;
  if (target) {
    try {
      const u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      parsed = u;
    } catch (_) {
      parsed = null;
    }
  }
  const port = Number(src.port) || DEFAULT_PORT;
  return {
    enabled: src.enabled === true,
    port: port > 0 && port < 65536 ? port : DEFAULT_PORT,
    target,
    // 目标地址不合法时开着也没意义，直接视为未就绪
    ready: Boolean(parsed),
  };
}

/** 上游基址（去掉末尾斜杠，拼路径时不会出现 //） */
function originOf(cfg) {
  const c = normalize(cfg);
  if (!c.ready) return '';
  const u = new URL(c.target);
  return u.origin + (u.pathname.replace(/\/+$/, '') === '/' ? '' : u.pathname.replace(/\/+$/, ''));
}

module.exports = { normalize, originOf, DEFAULT_PORT };
