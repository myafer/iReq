'use strict';

/**
 * 证书中心：首次运行自建根证书（CA），之后按访问的域名动态签发叶子证书。
 * 客户端只要信任一次根证书，就能解密所有 HTTPS 流量。
 *
 * v1.3.5 改动（对照成熟抓包工具的做法）：CA 不再是「目录里缺文件就随机重建」的临时产物，
 * 而是一份带 SHA-1 指纹的持久化档案：
 *   - 主档案 ca-archive.json 存 cert / key / leafKey / fingerprint / p12Password；
 *   - 散文件（reqlite-ca.pem 等）继续保留，兼容老的 caPath、下载端点与自检；
 *   - 档案丢了但散文件在 → 自动补档案；两者都丢 → 从候选旧目录迁移（含私钥）；
 *   - 只有全都找不到才生成新 CA，并在 info.created 里如实标记。
 * 覆盖安装 / 换 CLI 形态只要落在同一个 ~/.ireq/ca，就永远是同一张根证书。
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');

const CA_DAYS = 3650;
// Apple 平台（iOS 13+/macOS 10.15+）要求 TLS 证书有效期不超过 398 天
const LEAF_DAYS = 397;
const ARCHIVE_FILE = 'ca-archive.json';
const CN = 'iReq Root CA';

const ATTRS = [
  { name: 'commonName', value: CN },
  { name: 'organizationName', value: 'iReq' },
  { name: 'organizationalUnitName', value: 'Local Debugging' },
  { name: 'countryName', value: 'CN' },
];

function sha1(pem) {
  try {
    return new crypto.X509Certificate(pem).fingerprint.replace(/:/g, '').toUpperCase();
  } catch (_) {
    return '';
  }
}

function serial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0+/, '') || '01';
}

function altNames(host) {
  if (net.isIP(host)) return [{ type: 7, ip: host }];
  const names = [{ type: 2, value: host }];
  const parts = host.split('.');
  if (parts.length >= 2) names.push({ type: 2, value: '*.' + parts.slice(1).join('.') });
  return names;
}

function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

function writeIfChanged(p, text, mode) {
  try {
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) return;
  } catch (_) {
    /* 读不了就直接覆盖写 */
  }
  fs.writeFileSync(p, text, mode ? { mode } : undefined);
}

class CertificateAuthority {
  /**
   * @param {string} dir 主档案目录（打包/CLI/dev 都指向同一个 ~/.ireq/ca）
   * @param {object} opts candidates: 旧版数据目录，找不到主档案时从这里迁移
   */
  constructor(dir, opts = {}) {
    this.dir = path.resolve(dir);
    this.home = opts.home || os.homedir();
    this.candidates = (opts.candidates || [])
      .map((d) => path.resolve(d))
      .filter((d) => d && d !== this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.caCertPath = path.join(this.dir, 'reqlite-ca.pem');
    this.caKeyPath = path.join(this.dir, 'reqlite-ca.key');
    this.leafKeyPath = path.join(this.dir, 'reqlite-leaf.key');
    this.archivePath = path.join(this.dir, ARCHIVE_FILE);
    this.created = false;
    this.migratedFrom = '';
    this.source = '';
    this.archive = null;
    this._pem = '';
    this._der = null;
    this._cache = new Map();
    this._load();
  }

  /** 读档案并按指纹自校验，损坏/被改过一律不认 */
  _readArchive(file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || !j.cert || !j.key) return null;
      const fp = sha1(j.cert);
      if (!fp || (j.fingerprint && j.fingerprint !== fp)) return null;
      return { ...j, fingerprint: fp };
    } catch (_) {
      return null;
    }
  }

  /** 旧目录里找一份完整的 cert + key（含私钥，才能真正复用同一张 CA） */
  _findCandidate() {
    for (const dir of this.candidates) {
      const arc = this._readArchive(path.join(dir, ARCHIVE_FILE));
      if (arc) {
        return {
          dir,
          cert: arc.cert,
          key: arc.key,
          leaf: arc.leafKey || '',
          createdAt: arc.createdAt,
          p12Password: arc.p12Password,
        };
      }
      const cert = readIf(path.join(dir, 'reqlite-ca.pem'));
      const key = readIf(path.join(dir, 'reqlite-ca.key'));
      if (cert && key && sha1(cert)) {
        return { dir, cert, key, leaf: readIf(path.join(dir, 'reqlite-leaf.key')) };
      }
    }
    return null;
  }

  _generate() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 864e5);
    cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 864e5);
    cert.setSubject(ATTRS);
    cert.setIssuer(ATTRS);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  _generateLeaf() {
    const leaf = forge.pki.rsa.generateKeyPair(2048);
    return {
      leaf: forge.pki.privateKeyToPem(leaf.privateKey),
      leafPub: forge.pki.publicKeyToPem(leaf.publicKey),
    };
  }

  /** key 与 cert 必须是同一对，否则签出来的叶子证书客户端不会认 */
  _matches(certPem, keyPem) {
    try {
      const cert = forge.pki.certificateFromPem(certPem);
      const key = forge.pki.privateKeyFromPem(keyPem);
      return cert.publicKey.n.compareTo(key.n) === 0 && cert.publicKey.e.compareTo(key.e) === 0;
    } catch (_) {
      return false;
    }
  }

  _load() {
    this.created = false;
    this.migratedFrom = '';
    this.source = '';

    let certPem = '';
    let keyPem = '';
    let leafPem = '';
    let leafPubPem = '';
    let createdAt = '';
    let p12Password = '';

    const arc = this._readArchive(this.archivePath);
    if (arc && arc.cert && arc.key && this._matches(arc.cert, arc.key)) {
      certPem = arc.cert;
      keyPem = arc.key;
      leafPem = arc.leafKey || '';
      createdAt = arc.createdAt || '';
      p12Password = arc.p12Password || '';
      this.source = 'archive';
    } else {
      const c = readIf(this.caCertPath);
      const k = readIf(this.caKeyPath);
      if (c && k && sha1(c) && this._matches(c, k)) {
        certPem = c;
        keyPem = k;
        leafPem = readIf(this.leafKeyPath);
        this.source = 'files';
      } else {
        const found = this._findCandidate();
        if (found && this._matches(found.cert, found.key)) {
          certPem = found.cert;
          keyPem = found.key;
          leafPem = found.leaf || '';
          createdAt = found.createdAt || '';
          p12Password = found.p12Password || '';
          this.migratedFrom = found.dir;
          this.source = 'migrated';
        }
      }
    }

    if (!certPem || !keyPem) {
      const g = this._generate();
      certPem = g.cert;
      keyPem = g.key;
      createdAt = new Date().toISOString();
      p12Password = crypto.randomUUID();
      this.created = true;
      this.migratedFrom = '';
      this.source = 'generated';
    }
    if (!leafPem) {
      const l = this._generateLeaf();
      leafPem = l.leaf;
      leafPubPem = l.leafPub;
    }

    // 散文件与档案双向补齐：以后无论谁删了哪一份，都能自愈
    writeIfChanged(this.caCertPath, certPem);
    writeIfChanged(this.caKeyPath, keyPem, 0o600);
    writeIfChanged(this.leafKeyPath, leafPem, 0o600);
    if (leafPubPem) writeIfChanged(this.leafKeyPath + '.pub', leafPubPem, 0o600);

    const archive = {
      version: 1,
      cert: certPem,
      key: keyPem,
      leafKey: leafPem,
      fingerprint: sha1(certPem),
      createdAt: createdAt || new Date().toISOString(),
      p12Password: p12Password || crypto.randomUUID(),
      subject: CN,
    };
    if (!this.archive || this.archive.fingerprint !== archive.fingerprint || this.archive.key !== archive.key) {
      fs.writeFileSync(this.archivePath, JSON.stringify(archive, null, 2) + '\n', { mode: 0o600 });
    }
    this.archive = archive;
    this._pem = certPem;

    this.caCert = forge.pki.certificateFromPem(certPem);
    this.caKey = forge.pki.privateKeyFromPem(keyPem);
    // 所有叶子证书共用一对密钥 —— 省掉每个域名一次 RSA 生成（否则首包会卡几百毫秒）
    this.leafKey = forge.pki.privateKeyFromPem(leafPem);
    this.leafPublicKey = forge.pki.setRsaPublicKey(this.leafKey.n, this.leafKey.e);
    this._cache.clear();
    this._der = null;
  }

  /** 导入 .p12 后原地重载，proxy / server 持有的 ca 引用不用换 */
  reload() {
    this._load();
    return this.info;
  }

  get caPem() {
    return this._pem;
  }

  get fingerprint() {
    return (this.archive && this.archive.fingerprint) || sha1(this._pem);
  }

  /** 给 UI 与 /api/ca/archive 用的档案元信息（不含私钥） */
  get info() {
    return {
      dir: this.dir,
      archivePath: this.archivePath,
      caCertPath: this.caCertPath,
      fingerprint: this.fingerprint,
      createdAt: (this.archive && this.archive.createdAt) || '',
      source: this.source,
      created: this.created,
      migratedFrom: this.migratedFrom,
      subject: CN,
    };
  }

  /** DER 二进制（.cer）—— iOS/Android 的证书安装入口对 DER 兼容性最好 */
  get der() {
    if (!this._der) {
      const asn1 = forge.pki.certificateToAsn1(this.caCert);
      this._der = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
    }
    return this._der;
  }

  /** 导出 PKCS#12（含根证书 + 私钥），用于备份/迁移/多形态共用 */
  exportP12(password) {
    const pwd = password || (this.archive && this.archive.p12Password) || 'ireq';
    const asn1 = forge.pkcs12.toPkcs12Asn1(this.caKey, this.caCert, pwd, {
      algorithm: '3des',
      generateLocalKeyId: true,
    });
    return {
      der: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'),
      password: pwd,
    };
  }

  /** 导入 .p12：优先挑 CA 证书，校验私钥与证书配对后覆盖档案并 reload */
  importP12(der, password) {
    const bytes = Buffer.isBuffer(der) ? der.toString('binary') : String(der);
    let p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes), password || '');
    } catch (err) {
      throw new Error('p12 解析失败，请确认文件与密码（' + ((err && err.message) || err) + '）');
    }
    const types = [forge.pki.oids.certBag, forge.pki.oids.keyBag, forge.pki.oids.pkcs8ShroudedKeyBag];
    let certPem = '';
    let keyPem = '';
    for (const type of types) {
      const bags = (p12.getBags({ bagType: type }) || {})[type] || [];
      for (const bag of bags) {
        if (bag.cert) {
          const pem = forge.pki.certificateToPem(bag.cert);
          const ext = bag.cert.getExtension('basicConstraints');
          if (!certPem || (ext && ext.cA)) certPem = pem;
        }
        if (bag.key && !keyPem) keyPem = forge.pki.privateKeyToPem(bag.key);
      }
    }
    if (!certPem || !keyPem) throw new Error('p12 里没有同时包含根证书和私钥');
    if (!this._matches(certPem, keyPem)) throw new Error('p12 里的证书与私钥不匹配');

    const archive = {
      version: 1,
      cert: certPem,
      key: keyPem,
      leafKey: (this.archive && this.archive.leafKey) || this._generateLeaf().leaf,
      fingerprint: sha1(certPem),
      createdAt: new Date().toISOString(),
      p12Password: password || crypto.randomUUID(),
      subject: CN,
      imported: true,
    };
    fs.writeFileSync(this.archivePath, JSON.stringify(archive, null, 2) + '\n', { mode: 0o600 });
    this.archive = null; // 强制 _load 重读档案
    return this.reload();
  }

  /** 域名 -> SecureContext，带缓存 */
  getSecureContext(host) {
    const key = String(host || 'unknown').toLowerCase();
    let ctx = this._cache.get(key);
    if (ctx) return ctx;

    const cert = forge.pki.createCertificate();
    cert.publicKey = this.leafPublicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 864e5);
    cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 864e5);
    cert.setSubject([{ name: 'commonName', value: key }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: altNames(key) },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    ctx = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(this.leafKey),
      cert: forge.pki.certificateToPem(cert),
    });
    this._cache.set(key, ctx);
    return ctx;
  }
}

module.exports = { CertificateAuthority, ARCHIVE_FILE, CN, sha1 };
