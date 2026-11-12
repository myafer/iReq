'use strict';

/**
 * 本机根证书信任状态。
 *
 * 抓本机 HTTPS 之前必须把 iReq 的根证书加进 macOS 钥匙串并设为信任，
 * 否则 Chrome / Safari 会报「您的连接不是私密连接」。以前这一步只写在弹窗里，
 * 用户点「接管本机」时工具照常解密，结果把所有 HTTPS 站点都搞成证书错误。
 *
 * 判据（已实测）：security verify-cert -c <ca.pem> -p basic -L
 *   退出码 0 = 系统信任（用户域 add-trusted-cert 装的也算，同类工具装的 CA 即如此）
 *   退出码 1 = CSSMERR_TP_NOT_TRUSTED
 * 注意别用 -p ssl：根证书没有对应 EKU，会误报 "Invalid Extended Key Usage"。
 *
 * v1.3.5：
 *   - install() 在 app 内真正执行用户域 add-trusted-cert，成功后 verify-cert 回读；
 *     失败仍把命令返回给前端降级展示（一键安装 + 失败降级手动）。
 *   - 检测结果按 CA 指纹落盘到 trust-state.json，启动时可复用上一次结论，
 *     不会因为一次钥匙串抖动就让用户重装证书。
 *   - keychainInfo() 列出钥匙串里遗留的同名旧 CA，便于诊断「为什么又要装一次」。
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL = 30 * 1000;
const CNS = ['iReq Root CA', 'reqLite Root CA'];
const DEFAULT_CN = CNS[0];

function run(cmd, args, timeout = 4000) {
  try {
    return {
      ok: true,
      code: 0,
      out: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
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
    return line ? line.slice(3) : DEFAULT_CN;
  } catch (_) {
    return DEFAULT_CN;
  }
}

class CaTrust {
  constructor(ca, {
    platform = process.platform,
    home = os.homedir(),
    stateFile = null,
    runner = null,
  } = {}) {
    this.ca = ca;
    this.platform = platform;
    this.home = home;
    this.stateFile = stateFile;
    this.runner = runner || run;
    this.cached = null;
    this.checkedAt = 0;
  }

  get supported() {
    return this.platform === 'darwin';
  }

  get caPath() {
    return this.ca && this.ca.caCertPath ? path.resolve(this.ca.caCertPath) : null;
  }

  get loginKeychain() {
    return path.join(this.home, 'Library/Keychains/login.keychain-db');
  }

  /** 用户域信任（通常免 sudo，可能弹一次钥匙串授权）与系统域备用命令 */
  trustCommands() {
    const p = this.caPath || path.resolve('data/ca/reqlite-ca.pem');
    const userKc = this.loginKeychain;
    return {
      user: `security add-trusted-cert -r trustRoot -k "${userKc}" "${p}"`,
      admin: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${p}"`,
      remove: `security delete-certificate -Z ${fingerprint(this.ca.caPem)} "${userKc}"`,
    };
  }

  _readState() {
    if (!this.stateFile) return null;
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return j && typeof j === 'object' ? j : null;
    } catch (_) {
      return null;
    }
  }

  _writeState(st) {
    if (!this.stateFile) return;
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({
          sha1: st.sha1,
          trusted: st.trusted,
          installed: st.installed,
          checkedAt: st.checkedAt,
        }, null, 2) + '\n',
        { mode: 0o600 }
      );
    } catch (_) {
      /* 磁盘只读也不影响主功能 */
    }
  }

  /** 上一次确认过的结论（指纹必须一致，否则说明换了 CA，缓存作废） */
  state() {
    const j = this._readState();
    if (!j || !j.sha1 || j.sha1 !== fingerprint(this.ca.caPem)) return null;
    return j;
  }

  /** 一键安装：app 内执行用户域 add-trusted-cert，成功后回读 verify-cert */
  install() {
    if (!this.supported) {
      return { ok: false, error: '当前平台不支持自动安装，请按下面的命令手动执行', commands: this.trustCommands() };
    }
    const p = this.caPath;
    if (!p || !fs.existsSync(p)) {
      return { ok: false, error: '根证书文件不存在，无法自动安装', commands: this.trustCommands() };
    }
    const r = this.runner(
      'security',
      ['add-trusted-cert', '-r', 'trustRoot', '-k', this.loginKeychain, p],
      20000
    );
    // 不管 add-trusted-cert 返回什么，浏览器视角的 verify-cert 才是权威判据
    const st = this.refresh();
    const ok = st.trusted === true;
    return {
      ok,
      code: r.code,
      output: String(r.out || '').trim().slice(0, 400),
      trusted: st.trusted,
      installed: st.installed,
      reason: st.reason,
      error: ok ? '' : (r.code === 0 ? '命令执行完成但系统仍未信任，可能需要手动确认钥匙串授权' : String(r.out || '命令执行失败').trim().slice(0, 300)),
      commands: this.trustCommands(),
    };
  }

  /** 钥匙串里同名但指纹不同的旧 CA —— 覆盖安装反复装证书的历史痕迹。
   *  结果按指纹缓存 60s：每次要跑 4 个 security 子进程（2 个 CN × 登录/系统钥匙串），
   *  首启主进程忙时不该被它反复拖住；装/删证书会换指纹或走强制刷新。 */
  keychainInfo(force = false) {
    if (!this.supported) return { supported: false, cn: DEFAULT_CN, certs: [], stale: [] };
    const current = fingerprint(this.ca.caPem);
    if (!force && this._kcCache && this._kcCache.fp === current && Date.now() - this._kcCache.at < 60000) {
      return this._kcCache.val;
    }
    const certs = [];
    for (const cn of CNS) {
      const r = this.runner('security', ['find-certificate', '-a', '-c', cn, '-Z', '-p', this.loginKeychain], 8000);
      const pems = String(r.out || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      for (const pem of pems) {
        const fp = fingerprint(pem);
        if (fp && !certs.some((c) => c.sha1 === fp)) {
          certs.push({ sha1: fp, subject: subjectCN(pem), current: fp === current });
        }
      }
      const sys = this.runner('security', ['find-certificate', '-a', '-c', cn, '-Z', '-p', '/Library/Keychains/System.keychain'], 8000);
      const sysPems = String(sys.out || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      for (const pem of sysPems) {
        const fp = fingerprint(pem);
        if (fp && !certs.some((c) => c.sha1 === fp)) {
          certs.push({ sha1: fp, subject: subjectCN(pem), current: fp === current, system: true });
        }
      }
    }
    const val = {
      supported: true,
      cn: DEFAULT_CN,
      keychain: this.loginKeychain,
      certs,
      stale: certs.filter((c) => !c.current),
    };
    this._kcCache = { fp: current, at: Date.now(), val };
    return val;
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
    for (const kc of [this.loginKeychain, '/Library/Keychains/System.keychain']) {
      if (!fs.existsSync(kc)) continue;
      const r = this.runner('security', ['find-certificate', '-a', '-c', cn, '-Z', kc]);
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
      ? this.runner('security', ['verify-cert', '-c', this.caPath, '-p', 'basic', '-L'])
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
    this._writeState(this.cached);
    return this.cached;
  }

  /** 带缓存的状态读取，供 5 秒一次的 /api/status 使用 */
  status(force = false) {
    if (force || !this.cached || Date.now() - this.checkedAt > TTL) return this.refresh();
    return this.cached;
  }
}

module.exports = { CaTrust, fingerprint, subjectCN, run, CNS };
