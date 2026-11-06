'use strict';

/**
 * 从原始请求里派生出"人看得懂"的维度：设备 / 应用 / 接口结构。
 * 记录时算一次，读取老数据时也能按需补算（历史 flow 没有这些字段）。
 */

function clientIpOf(req) {
  let raw = '';
  const sock = (req && req.socket) || {};
  raw =
    sock.__reqliteClientIp ||
    sock.remoteAddress ||
    (sock.socket && sock.socket.remoteAddress) ||
    (sock._parent && sock._parent.remoteAddress) ||
    '';
  const ip = String(raw).replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  return ip || 'unknown';
}

/** 客户端源端口：MITM 时 req.socket 是 TLSSocket，真实端口在它包裹的原始 socket 上 */
function clientPortOf(req) {
  const s = (req && req.socket) || {};
  const p =
    s.__reqliteClientPort ||
    s.remotePort ||
    (s._parent && s._parent.remotePort) ||
    (s.socket && s.socket.remotePort) ||
    (s._handle && s._handle.remotePort) ||
    0;
  return Number(p) || 0;
}

function platformOf(ua) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/.test(s)) return 'iOS';
  if (/Android/.test(s)) return 'Android';
  if (/Macintosh|Mac OS X/.test(s)) return 'macOS';
  if (/Windows/.test(s)) return 'Windows';
  if (/Linux/.test(s)) return 'Linux';
  return '未知';
}

const BROWSER_UA = [
  [/Edg\/([\d.]+)/, 'Edge'],
  [/(?:Chrome|CriOS)\/([\d.]+)/, 'Chrome'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  [/Version\/([\d.]+)[^)]*Safari/, 'Safari'],
];

/** 解析设置里的「关键词=应用名」文本，供远程设备（拿不到进程）手动标注 */
function parseAppAliases(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      if (i < 0) return null;
      const match = line.slice(0, i).trim();
      const name = line.slice(i + 1).trim();
      return match && name ? { match, name: name.slice(0, 40) } : null;
    })
    .filter(Boolean);
}

function aliasOf(ua, aliases) {
  const s = String(ua || '');
  if (!s || !Array.isArray(aliases)) return null;
  for (const a of aliases) {
    const m = String((a && a.match) || '').trim();
    if (!m) continue;
    const hit = s.toLowerCase().includes(m.toLowerCase());
    if (hit) return String(a.name || m).slice(0, 40);
  }
  return null;
}

/** 从 UA 猜应用：Native App 一般形如 `echo/1.8.0 (iPhone; iOS 17.0)` */
function appOf(ua, aliases) {
  const alias = aliasOf(ua, aliases);
  if (alias) return alias;
  const s = String(ua || '').trim();
  if (!s) return '未知来源';

  for (const [re, name] of BROWSER_UA) {
    const m = s.match(re);
    if (m) return `${name} ${m[1].split('.')[0]}`;
  }
  const okhttp = s.match(/okhttp\/([\d.]+)/i);
  if (okhttp) return `OkHttp ${okhttp[1].split('.')[0]}`;
  const alamofire = s.match(/alamofire\/([\d.]+)/i);
  if (alamofire) return `Alamofire ${alamofire[1].split('.')[0]}`;
  if (/CFNetwork/i.test(s)) return 'CFNetwork';

  const first = s.split(/[\s;]/)[0].slice(0, 40);
  const m = first.match(/^([A-Za-z][\w.+-]*)\/([\d.]+)/);
  if (m && !/^Mozilla$/i.test(m[1])) {
    const version = m[2].length > 12 ? m[2].slice(0, 12) : m[2];
    return `${m[1]} ${version}`;
  }
  return first.slice(0, 26) || '未知来源';
}

/** 接口结构：把路径里的 id 类片段归一化，便于按"接口"聚合 */
function routeOf(method, pathname) {
  const clean = String(pathname || '/').split('?')[0];
  const segs = clean
    .split('/')
    .map((s) => {
      if (!s) return s;
      if (/^\d+$/.test(s)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ':uuid';
      if (/^[0-9a-f]{16,}$/i.test(s)) return ':hash';
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ':date';
      if (/^[A-Za-z0-9_-]{24,}$/.test(s) && /\d/.test(s)) return ':token';
      return s;
    })
    .join('/');
  // 连续多个占位段（日期、长 id 混排）压成一个 *，读起来更像一个接口
  const collapsed = segs.replace(/(:id|:uuid|:hash|:token|:date)(\/\1)+/g, '*');
  return `${method} ${collapsed || '/'}`;
}

module.exports = {
  clientIpOf,
  clientPortOf,
  platformOf,
  appOf,
  aliasOf,
  parseAppAliases,
  routeOf,
};
