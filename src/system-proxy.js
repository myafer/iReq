'use strict';

/**
 * 本机系统代理接管。
 *
 * HTTP 代理不是透明的：手机要手动填 Wi-Fi 代理，本机也必须设置「系统代理」，
 * 否则浏览器 / GUI App 的流量根本不会经过 9090（这正是 Charles / 同类抓包工具启动时
 * 替你做的那一步）。环境变量 HTTP_PROXY 只影响 curl / node 这类 CLI，对 Safari、
 * Chrome、桌面 App 无效。
 *
 * macOS 用 networksetup（实测无需 sudo 即可执行），其它平台不自动改系统设置，
 * 只生成可复制的命令。
 *
 * 安全：开启前把原始配置完整备份到 data/system-proxy-backup.json；
 * 关闭或进程正常退出时精确恢复，避免「工具停了，机器也断网了」。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCAL_HOST = '127.0.0.1';
/** 必须绕过：控制台自己、本机回环、Bonjour，否则请求会绕回代理造成自环 */
const BYPASS = ['localhost', '127.0.0.1', '::1', '*.local'];

function exec(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseKeyValue(out) {
  const obj = {};
  for (const line of String(out || '').split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    obj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return obj;
}

class SystemProxy {
  constructor({ proxyPort = 9090, dataDir }) {
    this.proxyPort = proxyPort;
    this.platform = process.platform;
    this.backupFile = path.join(dataDir || path.join(process.cwd(), 'data'), 'system-proxy-backup.json');
  }

  get supported() {
    return this.platform === 'darwin';
  }

  /** 可用的网络服务；带 * 前缀的是已禁用，跳过 */
  services() {
    if (!this.supported) return [];
    try {
      const out = exec('networksetup', ['-listallnetworkservices']);
      return out
        .split('\n')
        .slice(1) // 首行是说明文字
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('*'));
    } catch (_) {
      return [];
    }
  }

  /** 优先 Wi-Fi，其次第一个可用服务 */
  primaryService() {
    const list = this.services();
    return list.find((s) => /wi-?fi/i.test(s)) || list[0] || '';
  }

  _readProxy(service, secure) {
    const out = exec('networksetup', [secure ? '-getsecurewebproxy' : '-getwebproxy', service]);
    const kv = parseKeyValue(out);
    return {
      enabled: /^yes$/i.test(kv.enabled || ''),
      host: kv.server || '',
      port: Number(kv.port) || 0,
    };
  }

  _readBypass(service) {
    try {
      const out = exec('networksetup', ['-getproxybypassdomains', service]);
      if (/There aren't any/i.test(out)) return [];
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  snapshot(service) {
    return {
      service,
      web: this._readProxy(service, false),
      secure: this._readProxy(service, true),
      bypass: this._readBypass(service),
    };
  }

  /** 只读状态，UI 每次打开设置时拉一次 */
  status(service) {
    const svc = service || this.primaryService();
    const base = {
      supported: this.supported,
      platform: this.platform,
      service: svc,
      services: this.services(),
      proxyPort: this.proxyPort,
      managed: false,
      on: false,
      ours: false,
      error: '',
    };
    if (!this.supported) {
      base.error = '当前平台暂不支持自动设置，请复制下方命令在终端执行';
      return base;
    }
    if (!svc) return { ...base, error: '没找到可用的网络服务' };
    try {
      const snap = this.snapshot(svc);
      const ours =
        snap.web.enabled && snap.secure.enabled &&
        snap.web.port === this.proxyPort && snap.secure.port === this.proxyPort &&
        ['127.0.0.1', 'localhost'].includes(snap.web.host.toLowerCase()) &&
        ['127.0.0.1', 'localhost'].includes(snap.secure.host.toLowerCase());
      const b = this._backup();
      return {
        ...base,
        web: snap.web,
        secure: snap.secure,
        bypass: snap.bypass,
        on: snap.web.enabled || snap.secure.enabled,
        ours,
        managed: !!(b && b.managedByUs && b.service === svc),
      };
    } catch (e) {
      return { ...base, error: String((e && e.message) || e) };
    }
  }

  _backup() {
    try {
      return JSON.parse(fs.readFileSync(this.backupFile, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  _saveBackup(snap) {
    fs.mkdirSync(path.dirname(this.backupFile), { recursive: true });
    fs.writeFileSync(
      this.backupFile,
      JSON.stringify({ ...snap, managedByUs: true, at: Date.now(), proxyPort: this.proxyPort }, null, 2)
    );
  }

  _clearBackup() {
    try {
      fs.unlinkSync(this.backupFile);
    } catch (_) {
      /* 没有备份文件不算错 */
    }
  }

  /** 把原始快照写回系统；返回是否完全恢复 */
  restore(snap, service) {
    const svc = service || snap.service;
    const apply = (entries, secure) => {
      const setCmd = secure ? '-setsecurewebproxy' : '-setwebproxy';
      const stateCmd = secure ? '-setsecurewebproxystate' : '-setwebproxystate';
      // 关键：关闭态下 macOS 仍会保留 Server/Port 字段。只把 state 置 off 的话，
      // 字段会残留 127.0.0.1:9090，用户下次手动开代理就会连到已经停掉的 iReq。
      // 所以无论开还是关，都先把 host/port 写回快照里的原值，再设开关。
      exec('networksetup', [setCmd, svc, entries.host || '', String(entries.port || 0)]);
      exec('networksetup', [stateCmd, svc, entries.enabled ? 'on' : 'off']);
    };
    apply(snap.web, false);
    apply(snap.secure, true);
    this._restoreBypass(svc, snap.bypass || []);
    const now = this.snapshot(svc);
    return (
      now.web.enabled === snap.web.enabled &&
      now.web.host === snap.web.host &&
      now.web.port === snap.web.port &&
      now.secure.enabled === snap.secure.enabled &&
      now.secure.host === snap.secure.host &&
      now.secure.port === snap.secure.port &&
      JSON.stringify(now.bypass) === JSON.stringify(snap.bypass || [])
    );
  }

  _restoreBypass(svc, domains) {
    if (domains.length) {
      exec('networksetup', ['-setproxybypassdomains', svc, ...domains]);
    } else {
      // 传一个空域名才会把列表清空；不带参数调用在这版 macOS 上是 no-op
      exec('networksetup', ['-setproxybypassdomains', svc, '']);
    }
  }

  enable(service) {
    if (!this.supported) return { ok: false, error: '当前平台请改用命令行开启' };
    const svc = service || this.primaryService();
    if (!svc) return { ok: false, error: '没找到可用的网络服务' };
    try {
      const before = this.snapshot(svc);
      // 已经是别的代理时先备份，关闭时可精确还原，避免覆盖用户原有配置
      this._saveBackup(before);
      exec('networksetup', ['-setwebproxy', svc, LOCAL_HOST, String(this.proxyPort)]);
      exec('networksetup', ['-setsecurewebproxy', svc, LOCAL_HOST, String(this.proxyPort)]);
      exec('networksetup', ['-setwebproxystate', svc, 'on']);
      exec('networksetup', ['-setsecurewebproxystate', svc, 'on']);
      // 保留用户原有的 bypass，再补上本机回环，避免控制台自环
      const merged = [...new Set([...(before.bypass || []), ...BYPASS])];
      exec('networksetup', ['-setproxybypassdomains', svc, ...merged]);
      return { ok: true, status: this.status(svc) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  disable(service) {
    if (!this.supported) return { ok: false, error: '当前平台请改用命令行关闭' };
    const svc = service || this.primaryService();
    const backup = this._backup();
    try {
      if (backup) {
        const restored = this.restore(backup, svc);
        this._clearBackup();
        return { ok: true, restored, status: this.status(svc) };
      }
      // 没有备份（例如直接执行 `ireq local off`）：按「全空快照」恢复，
      // 顺手把可能残留的 127.0.0.1:9090 和绕过域名也清干净
      const restored = this.restore(
        {
          service: svc,
          web: { enabled: false, host: '', port: 0 },
          secure: { enabled: false, host: '', port: 0 },
          bypass: [],
        },
        svc
      );
      return { ok: true, restored, status: this.status(svc) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 进程正常退出时调用：只恢复「由我们开启」的代理，别去动用户自己的设置 */
  autoRestore() {
    const backup = this._backup();
    if (!this.supported || !backup || !backup.managedByUs) return { skipped: true };
    try {
      const restored = this.restore(backup, backup.service);
      this._clearBackup();
      return { restored };
    } catch (e) {
      return { restored: false, error: String((e && e.message) || e) };
    }
  }

  /** 给用户复制的命令（跨平台；失败时可在终端手动执行） */
  commands(service) {
    const svc = service || this.primaryService() || 'Wi-Fi';
    const port = this.proxyPort;
    if (this.platform === 'darwin') {
      return {
        on: [
          `networksetup -setwebproxy "${svc}" 127.0.0.1 ${port}`,
          `networksetup -setsecurewebproxy "${svc}" 127.0.0.1 ${port}`,
          `networksetup -setproxybypassdomains "${svc}" localhost 127.0.0.1 ::1 '*.local'`,
        ].join('\n'),
        off: [
          `networksetup -setwebproxystate "${svc}" off`,
          `networksetup -setsecurewebproxystate "${svc}" off`,
        ].join('\n'),
        note: '如果提示没有权限，每条命令前加 sudo。',
      };
    }
    if (this.platform === 'win32') {
      const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      return {
        on: [
          `Set-ItemProperty -Path '${key}' -Name ProxyServer -Value '127.0.0.1:${port}'`,
          `Set-ItemProperty -Path '${key}' -Name ProxyEnable -Value 1`,
        ].join('\n'),
        off: `Set-ItemProperty -Path '${key}' -Name ProxyEnable -Value 0`,
        note: '在 PowerShell 里执行；改完重开浏览器。',
      };
    }
    return {
      on: [
        "gsettings set org.gnome.system.proxy mode 'manual'",
        `gsettings set org.gnome.system.proxy.http host '127.0.0.1'`,
        `gsettings set org.gnome.system.proxy.http port ${port}`,
        `gsettings set org.gnome.system.proxy.https host '127.0.0.1'`,
        `gsettings set org.gnome.system.proxy.https port ${port}`,
        `gsettings set org.gnome.system.proxy ignore-hosts "['localhost', '127.0.0.0/8', '::1']"`,
      ].join('\n'),
      off: "gsettings set org.gnome.system.proxy mode 'none'",
      note: 'GNOME 有效；其它桌面环境请在网络设置里手动填代理。',
    };
  }
}

module.exports = { SystemProxy, BYPASS };
