'use strict';

/**
 * 证书中心：首次运行自建根证书（CA），之后按访问的域名动态签发叶子证书。
 * 客户端只要信任一次根证书，就能解密所有 HTTPS 流量。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const forge = require('node-forge');

const CA_DAYS = 3650;
// Apple 平台（iOS 13+/macOS 10.15+）要求 TLS 证书有效期不超过 398 天
const LEAF_DAYS = 397;

const ATTRS = [
  { name: 'commonName', value: 'iReq Root CA' },
  { name: 'organizationName', value: 'iReq' },
  { name: 'organizationalUnitName', value: 'Local Debugging' },
  { name: 'countryName', value: 'CN' },
];

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

class CertificateAuthority {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.caCertPath = path.join(dir, 'reqlite-ca.pem');
    this.caKeyPath = path.join(dir, 'reqlite-ca.key');
    this.leafKeyPath = path.join(dir, 'reqlite-leaf.key');
    this.created = false;
    this._cache = new Map();
    this._load();
  }

  _load() {
    const needCa = !fs.existsSync(this.caCertPath) || !fs.existsSync(this.caKeyPath);
    if (needCa) {
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
      fs.writeFileSync(this.caCertPath, forge.pki.certificateToPem(cert));
      fs.writeFileSync(this.caKeyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
      this.created = true;
    }

    this.caCert = forge.pki.certificateFromPem(fs.readFileSync(this.caCertPath, 'utf8'));
    this.caKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.caKeyPath, 'utf8'));

    // 所有叶子证书共用一对密钥 —— 省掉每个域名一次 RSA 生成（否则首包会卡几百毫秒）
    if (!fs.existsSync(this.leafKeyPath)) {
      const leaf = forge.pki.rsa.generateKeyPair(2048);
      fs.writeFileSync(this.leafKeyPath, forge.pki.privateKeyToPem(leaf.privateKey), { mode: 0o600 });
      fs.writeFileSync(
        this.leafKeyPath + '.pub',
        forge.pki.publicKeyToPem(leaf.publicKey),
        { mode: 0o600 }
      );
    }
    this.leafKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.leafKeyPath, 'utf8'));
    this.leafPublicKey = forge.pki.setRsaPublicKey(
      this.leafKey.n,
      this.leafKey.e
    );
  }

  get caPem() {
    return fs.readFileSync(this.caCertPath, 'utf8');
  }

  /** DER 二进制（.cer）—— iOS/Android 的证书安装入口对 DER 兼容性最好 */
  get der() {
    if (!this._der) {
      const asn1 = forge.pki.certificateToAsn1(this.caCert);
      this._der = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
    }
    return this._der;
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

module.exports = { CertificateAuthority };
