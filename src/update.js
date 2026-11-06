'use strict';

/**
 * 自动检查更新：对比 GitHub Releases 最新 tag 与当前版本。
 * 网络策略：先直连 api.github.com，失败后自动改走自家代理端口
 * （工具本身就在本机 9090 开着 HTTP 代理，国内环境直连 GitHub 大概率不通）。
 * 开关存 config.autoUpdate，可通过设置面板关闭。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const FIRST_DELAY_MS = 8 * 1000;
const TIMEOUT_MS = 8 * 1000;

function normalizeTag(tag) {
  return String(tag || '').trim().replace(/^v/i, '');
}

/** 1.2.3 > 1.2.2；位数不齐按 0 补；非数字段忽略比较（如 -beta 视为同版本） */
function isNewerVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

class UpdateChecker {
  constructor({ owner, repo, version, proxyPort, config } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.version = String(version || '0.0.0');
    this.proxyPort = proxyPort;
    this.config = config || {};
    this.state = {
      checking: false,
      checkedAt: null,
      latest: null, // { version, url, publishedAt }
      hasUpdate: false,
      error: null,
    };
    this.timers = [];
  }

  start() {
    if (!this.owner || !this.repo) return;
    const t1 = setTimeout(() => this.checkOnce().catch(() => {}), FIRST_DELAY_MS);
    const t2 = setInterval(() => this.checkOnce().catch(() => {}), CHECK_INTERVAL_MS);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
    this.timers.push(t1, t2);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers = [];
  }

  status() {
    return {
      enabled: this.config.autoUpdate !== false,
      current: this.version,
      ...this.state,
    };
  }

  async checkOnce(force = false) {
    if (!this.owner || !this.repo) return this.status();
    if (this.state.checking) return this.status();
    if (this.config.autoUpdate === false && !force) return this.status();
    this.state.checking = true;
    this.state.error = null;
    try {
      const latest = await this._fetchLatest();
      this.state.latest = latest;
      this.state.hasUpdate = isNewerVersion(latest.version, this.version);
      this.state.checkedAt = Date.now();
    } catch (err) {
      this.state.error = String((err && err.message) || err);
    } finally {
      this.state.checking = false;
    }
    return this.status();
  }

  async _fetchLatest() {
    const path = `/repos/${this.owner}/${this.repo}/releases/latest`;
    const headers = {
      'user-agent': `iReq/${this.version}`,
      accept: 'application/vnd.github+json',
    };
    let body;
    try {
      body = await this._directGet(path, headers);
    } catch (directErr) {
      // 直连失败 → 走自家代理（本机 9090 本来就开着）
      body = await this._proxyGet(path, headers);
      if (!body) throw directErr;
    }
    const json = JSON.parse(body);
    if (!json.tag_name) throw new Error('响应里没有 tag_name');
    return {
      version: normalizeTag(json.tag_name),
      url: json.html_url || `https://github.com/${this.owner}/${this.repo}/releases`,
      publishedAt: json.published_at || null,
    };
  }

  _directGet(path, headers) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: 'api.github.com', path, headers, timeout: TIMEOUT_MS },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`GitHub API ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('timeout', () => req.destroy(new Error('直连 api.github.com 超时')));
      req.on('error', reject);
    });
  }

  /** 通过自家 HTTP 代理发起 CONNECT 隧道，再走 TLS 请求 GitHub API */
  _proxyGet(path, headers) {
    return new Promise((resolve) => {
      if (!this.proxyPort) return resolve(null);
      const connect = http.request({
        host: '127.0.0.1',
        port: this.proxyPort,
        method: 'CONNECT',
        path: 'api.github.com:443',
        timeout: TIMEOUT_MS,
      });
      connect.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return resolve(null);
        }
        const tlsSocket = tls.connect({ socket, servername: 'api.github.com' }, () => {
          tlsSocket.write(
            `GET ${path} HTTP/1.1\r\nhost: api.github.com\r\nconnection: close\r\n` +
              Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\r\n') +
              '\r\n\r\n'
          );
        });
        let raw = '';
        tlsSocket.on('data', (c) => (raw += c.toString('utf8')));
        tlsSocket.on('end', () => {
          const i = raw.indexOf('\r\n\r\n');
          if (i < 0 || !/^HTTP\/1\.[01] 200/.test(raw)) return resolve(null);
          resolve(raw.slice(i + 4));
        });
        tlsSocket.on('error', () => resolve(null));
      });
      connect.on('timeout', () => connect.destroy());
      connect.on('error', () => resolve(null));
      connect.end();
    });
  }
}

module.exports = { UpdateChecker, isNewerVersion, normalizeTag };
