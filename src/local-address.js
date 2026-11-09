'use strict';

/**
 * 判断一个客户端 IP 是不是「这台电脑自己」。
 *
 * 以前只认 127.x，于是同一台机器会从两个入口冒出来：
 *   - 系统代理 / curl / 本机浏览器 → 127.0.0.1
 *   - 访问本机局域网 IP（192.168.1.23、192.168.x…）或 VPN 虚拟网卡 → 那个网卡 IP
 * 侧栏就会显示成两台设备；而且标签用 UA 猜平台，无 UA 的请求先到就写成
 * 「未知 127.0.0.1」，下一条带 UA 的又变回「iOS 127.0.0.1」，看起来像闪跳。
 *
 * 这里把回环 + 本机所有网卡地址统一归到一个设备 key='local' / 标签='本机'，
 * 标签不再依赖 UA，任何时刻都稳定。远程设备的 IP 不会出现在 networkInterfaces 里。
 */

const os = require('os');

const LOCAL_KEY = 'local';
const LOCAL_LABEL = '本机';
const CACHE_TTL = 5000; // 切 Wi-Fi / 插拔 VPN 后最多 5 秒感知到新地址

/** 统一写法：去掉 ::ffff: 前缀、IPv6 zone 后缀，::1 归一到 127.0.0.1 */
function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s || s === 'unknown') return '';
  s = s.replace(/^::ffff:/, '').replace(/%[a-z0-9._-]+$/, '');
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return s;
}

function isLoopback(ip) {
  const s = normalizeIp(ip);
  return s === '127.0.0.1' || s.startsWith('127.');
}

let cache = { at: 0, set: null };

function localIpSet() {
  if (cache.set && Date.now() - cache.at < CACHE_TTL) return cache.set;
  const set = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      const ip = normalizeIp(nic && nic.address);
      if (ip) set.add(ip);
    }
  }
  cache = { at: Date.now(), set };
  return set;
}

function isLocalClientIp(ip) {
  const s = normalizeIp(ip);
  return !!s && (isLoopback(s) || localIpSet().has(s));
}

/** 侧栏分组 / 筛选用的稳定 key */
function deviceKeyOf(ip) {
  if (isLocalClientIp(ip)) return LOCAL_KEY;
  return normalizeIp(ip) || 'unknown';
}

/** 展示用的稳定标签：本机不再拼 UA 平台；远程没有 UA 就只显示 IP，不写「未知」 */
function deviceLabelOf(ip, platform) {
  if (isLocalClientIp(ip)) return LOCAL_LABEL;
  const s = normalizeIp(ip);
  if (!s || s === 'unknown') return '未知设备';
  const p = String(platform || '').trim();
  return p && p !== '未知' ? `${p} ${s}` : s;
}

module.exports = {
  LOCAL_KEY,
  LOCAL_LABEL,
  normalizeIp,
  isLoopback,
  isLocalClientIp,
  deviceKeyOf,
  deviceLabelOf,
};
