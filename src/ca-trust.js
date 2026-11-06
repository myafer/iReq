'use strict';

/**
 * 本机根证书信任状态。
 *
 * 抓本机 HTTPS 之前必须把 iReq 的根证书加进 macOS 钥匙串并设为信任，
 * 否则 Chrome / Safari 会报「您的连接不是私密连接」。以前这一步只写在弹窗里，
 * 用户点「接管本机」时工具照常解密，结果把所有 HTTPS 站点都搞成证书错误。
 *
 * 判据（已实测）：security verify-cert -c <ca.pem> -p basic -L
 *   退出码 0 = 系统信任（用户域 add-trusted-cert 装的也算，Reqable CA 即如此）
 *   退出码 1 = CSSMERR_TP_NOT_TRUSTED
 * 注意别用 -p ssl：根证书没有对应 EKU，会误报 "Invalid Extended Key Usage"。
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL = 30 * 1000;

function run(cmd, args) {
  try {
    return {
      ok: true,
      code: 0,
      out: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 4000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      code: err.status === undefined ? -1 : Number(err.status),
      out: `${err.stdout || ''}${err.stderr || ''}`,
    };
  }
}

function fingerprint(pem) {
  try {
    return new crypto.X509Certificate(pem).fingerprint.replace(/:/g, '').toUpperCase();
  } catch (_) {
    return '';
  }
}

function subjectCN(pem) {
  try {
    const c = new crypto.X509Certificate(pem);
    const line = String(c.subject).split('\n').find((s) => /^CN=/.test(s));
    return line ? line.slice(3) : 'iReq Root CA';
  } catch (_) {
    return 'iReq Root CA';
  }
}

class CaTrust {
  constructor(ca, { platform = process.platform, home = os.homedir() } = {}) {
    this.ca = ca;
    this.platform = platform;
    this.home = home;
    this.cached = null;
    this.checkedAt = 0;
  }

  get supported() {
    return this.platform === 'darwin';
  }

  get caPath() {
    return this.ca && this.ca.caCertPath ? path.resolve(this.ca.caCertPath) : null;
  }

  /** 用户域信任（通常免 sudo，可能弹一次钥匙串授权）与系统域备用命令 */
  trustCommands() {
    const p = this.caPath || path.resolve('data/ca/reqlite-ca.pem');
    const userKc = path.join(this.home, 'Library/Keychains/login.keychain-db');
    return {
      user: `security add-trusted-cert -r trustRoot -k "${userKc}" "${p}"`,
      admin: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${p}"`,
      remove: `security delete-certificate -Z ${fingerprint(this.ca.caPem)} "${userKc}"`,
    };
  }

  /** 强制重新检测（会跑一次 security 子进程，别放在轮询里） */
  refresh() {
    const base = {
      supported: this.supported,
      platform: this.platform,
      caPath: this.caPath,
      checkedAt: Date.now(),
      commands: this.supported ? this.trustCommands() : {},
    };
    if (!this.supported) {
      this.cached = { ...base, trusted: null, installed: null, reason: '当前平台不提供自动检测，请手动确认根证书已信任' };
      this.checkedAt = base.checkedAt;
      return this.cached;
    }

    let pem = '';
    try {
      pem = this.ca.caPem;
    } catch (_) {
      /* 文件被删了也要给个明确结果 */
    }
    const sha1 = fingerprint(pem);
    const cn = subjectCN(pem);

    // 是否已安装到钥匙串（不论是否设为信任）
    let installed = false;
    let keychain = '';
    for (const kc of [
      path.join(this.home, 'Library/Keychains/login.keychain-db'),
      '/Library/Keychains/System.keychain',
    ]) {
      if (!fs.existsSync(kc)) continue;
      const r = run('security', ['find-certificate', '-a', '-c', cn, '-Z', kc]);
      if (r.ok && sha1 && r.out.toUpperCase().includes(sha1)) {
        installed = true;
        keychain = kc;
        break;
      }
      // 有些版本 -Z 输出的是 SHA-1 hash 行，按 CN 匹配也够用
      if (r.ok && r.out.includes('SHA-1 hash:') && r.out.includes(cn)) {
        installed = true;
        keychain = kc;
        break;
      }
    }

    // 是否被系统真正信任 —— 这是浏览器视角的权威判据
    const v = this.caPath
      ? run('security', ['verify-cert', '-c', this.caPath, '-p', 'basic', '-L'])
      : { code: -1, out: '根证书文件不存在' };
    const trusted = v.code === 0;

    let reason;
    if (trusted) reason = '本机已信任 iReq 根证书，HTTPS 可以正常解密';
    else if (installed) reason = '根证书已装进钥匙串，但还没设为「始终信任」';
    else reason = '本机还没安装并信任 iReq 根证书';

    this.cached = {
      ...base,
      trusted,
      installed,
      keychain,
      sha1,
      subject: cn,
      reason,
      verifyOutput: trusted ? '' : String(v.out || '').split('\n').slice(0, 2).join(' ').trim(),
    };
    this.checkedAt = base.checkedAt;
    return this.cached;
  }

  /** 带缓存的状态读取，供 5 秒一次的 /api/status 使用 */
  status(force = false) {
    if (force || !this.cached || Date.now() - this.checkedAt > TTL) return this.refresh();
    return this.cached;
  }
}

module.exports = { CaTrust, fingerprint, subjectCN, run };
