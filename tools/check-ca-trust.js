'use strict';

/**
 * 自检：根证书信任检测 + 未信任时的「安全模式」。
 *
 * 回归点（真实事故）：
 *  1. 用户双击 .pem 把 CA 导入钥匙串就算「装好了」，但没设「始终信任」，
 *     接管系统代理后 Chrome 报「您的连接不是私密连接」。
 *  2. 用 `add-trusted-cert -p ssl` 会生成「仅 SSL 策略」的受限信任，
 *     verify-cert 仍判未信任 —— 命令里不能带 -p。
 *  3. 安全模式把本机 HTTPS 原样透传却不记录 flow，用户以为工具坏了、
 *     「看不到请求进来」。现在透传也要留一条带「透传」标记的记录。
 *
 * 不修改系统代理、不动真实 data/，可在服务运行时安全执行。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { CertificateAuthority } = require('../src/ca');
const { CaTrust } = require('../src/ca-trust');
const { ProxyServer } = require('../src/proxy');
const { ProcessMap } = require('../src/process-map');
const { FlowStore } = require('../src/store');
const { RuleEngine } = require('../src/rules');

const ROOT = path.join(__dirname, '..');
const CA_DIR = path.join(ROOT, 'data', 'ca');
const UI = 'http://127.0.0.1:9091';
const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-catrust-'));

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
}

function probeWith(port, url) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '--noproxy', '', '--proxy', `http://127.0.0.1:${port}`, '-k', '--max-time', '5', '-o', '/dev/null', url],
      { timeout: 8000 },
      () => resolve()
    );
  });
}

(async () => {
  try {
    // ------------------------------------------------------------ 1. 检测模块
    const ca = new CertificateAuthority(CA_DIR);
    const trust = new CaTrust(ca);
    const st = trust.refresh();
    push('检测模块在 macOS 可用', st.supported === true);
    push('能算出 CA 的 SHA-1 指纹', /^[0-9A-F]{40}$/.test(st.sha1 || ''));
    push('信任状态是布尔值', typeof st.trusted === 'boolean');
    push('★ 信任命令不含 -p ssl（否则浏览器仍不认）', !/-p\s+ssl/.test(st.commands.user));
    push('信任命令写入绝对路径', String(st.commands.user).includes(path.resolve(CA_DIR)));
    push('提供 sudo 备用命令', String(st.commands.admin).startsWith('sudo '));
    push('状态带 TTL 缓存（连续读取不重复跑子进程）', trust.status() === trust.status());
    push('强制刷新返回新对象', trust.status(true) !== st);

    const linux = new CaTrust(ca, { platform: 'linux' }).refresh();
    push('非 macOS 优雅降级（不阻断解密）', linux.supported === false && linux.trusted === null);

    // 临时目录里造一个肯定没被信任的 CA，验证未信任分支
    const fresh = new CertificateAuthority(path.join(tmp, 'ca'));
    const untrusted = new CaTrust(fresh).refresh();
    push('未信任的自签 CA 被判为未信任', untrusted.trusted === false);
    push('未信任时给出可读原因', typeof untrusted.reason === 'string' && untrusted.reason.length > 4);
    push('未信任时带 verify-cert 证据', /NOT_TRUSTED|not trusted/i.test(untrusted.verifyOutput || ''));

    // ------------------------------------------------- 2. _shouldDecrypt 分支
    const mkProxy = (cfg) =>
      new ProxyServer({
        port: 0,
        host: '127.0.0.1',
        ca,
        store: new FlowStore({ dir: path.join(tmp, 'flows'), persist: false }),
        rules: new RuleEngine(path.join(tmp, 'rules')),
        config: { capture: true, passthrough: [], mitmPorts: [443], ...cfg },
        processMap: new ProcessMap({ enabled: false }),
      });
    const p = mkProxy({ caTrusted: false, localProxyOurs: true });
    const d = (host, port, ip) => p._shouldDecrypt(host, port, ip);
    push('★ 未信任 + 接管 + 本机 → 安全透传', d('example.com', 443, '127.0.0.1').reason === 'untrusted-ca');
    push('本机 IPv4-mapped 回环也识别', d('example.com', 443, '::ffff:127.0.0.1').reason === 'untrusted-ca');
    push('★ 手机/远程设备不受影响，照常解密', d('example.com', 443, '192.0.2.43').decrypt === true);
    push('★ 显式 --proxy（未接管系统代理）照常解密', mkProxy({ caTrusted: false, localProxyOurs: false })._shouldDecrypt('example.com', 443, '127.0.0.1').decrypt === true);
    push('证书已信任后恢复解密', mkProxy({ caTrusted: true, localProxyOurs: true })._shouldDecrypt('example.com', 443, '127.0.0.1').decrypt === true);
    push('非 443 端口始终裸隧道', d('example.com', 8883, '127.0.0.1').reason === 'port');
    push('透传白名单优先', mkProxy({ caTrusted: true, localProxyOurs: true, passthrough: ['example.com'] })._shouldDecrypt('git.example.com', 443, '127.0.0.1').reason === 'passthrough');

    // ------------------------------------- 3. 安全模式透传也要留下 flow 记录
    const live = mkProxy({ caTrusted: false, localProxyOurs: true });
    const livePort = await live.start();
    const before = live.store.flows.length;
    await probeWith(livePort, 'https://untrusted-probe.invalid/');
    await new Promise((r) => setTimeout(r, 300));
    const rec = live.store.flows.find((f) => f.tunneled);
    push('★ 安全透传仍产生一条 flow（不再是空列表）', Boolean(rec));
    push('该记录标记为 CONNECT / 透传', Boolean(rec && rec.method === 'CONNECT' && rec.tunneled === true));
    push('该记录带可读的修复说明', Boolean(rec && /始终信任|重新检测/.test(rec.note || '')));
    push('该记录不影响 stats.total 正常累加', live.store.flows.length === before + 1);
    await live.stop();

    // --------------------------------------------------------- 4. API 契约
    const getSt = await api('/api/ca-trust');
    push('GET /api/ca-trust 返回信任状态', typeof getSt.trusted === 'boolean');
    push('GET /api/ca-trust 返回命令', Boolean(getSt.commands && getSt.commands.user));
    push('GET /api/ca-trust 返回 safeMode', typeof getSt.safeMode === 'boolean');
    const postSt = await api('/api/ca-trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    push('POST /api/ca-trust 强制刷新成功', postSt.checkedAt >= getSt.checkedAt);
    const status = await api('/api/status');
    push('/api/status 带 caTrust', Boolean(status.caTrust && typeof status.caTrust.trusted === 'boolean'));
    push('/api/status 带 safeMode', typeof status.safeMode === 'boolean');
    const sp = await api('/api/system-proxy');
    push('/api/system-proxy 带 caTrust / safeMode', Boolean(sp.caTrust) && typeof sp.safeMode === 'boolean');
    const diag = await api('/api/diagnostics');
    push('/api/diagnostics 带 safeTunneled 统计', typeof diag.safeTunneled === 'number');

    // ------------------------------------------------------------ 5. UI
    let chromium, EXEC;
    try {
      ({ chromium, EXEC } = require('./_pw'));
    } catch (_) {
      push('Playwright 可用（跳过 UI 检查）', true);
    }
    if (chromium) {
      const browser = await chromium.launch({ executablePath: EXEC });
      const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(UI + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await page.click('#btnSettings');
      await page.waitForTimeout(600);
      push('设置弹窗含信任引导卡片', (await page.$('#lpCaWarn')) !== null);
      push('设置弹窗含信任徽标', (await page.$('#lpTrustBadge')) !== null);
      push('复制信任命令按钮存在', (await page.$('#lpCopyTrust')) !== null);
      push('重新检测按钮存在', (await page.$('#lpRecheckTrust')) !== null);

      // 注入「未信任」状态，验证警告确实会出现且不把面板撑破
      const injected = await page.evaluate(() => {
        const t = {
          supported: true,
          trusted: false,
          installed: true,
          reason: '根证书已装进钥匙串，但还没设为「始终信任」',
          verifyOutput: 'CSSMERR_TP_NOT_TRUSTED',
          commands: { user: 'security add-trusted-cert -r trustRoot -k /tmp/kc /tmp/ca.pem' },
        };
        S.localProxy = { ...(S.localProxy || {}), caTrust: t, safeMode: true };
        renderLocalProxy();
        const warn = document.querySelector('#lpCaWarn');
        const body = document.querySelector('#modalSettings .modal-body');
        return {
          visible: !warn.hidden,
          reason: document.querySelector('#lpCaReason').textContent,
          cmd: document.querySelector('#lpCaCmd').textContent,
          overflow: body ? body.scrollWidth - body.clientWidth : 999,
        };
      });
      push('★ 未信任时警告卡片自动出现', injected.visible);
      push('警告里写明「已安装但未信任」', /始终信任/.test(injected.reason));
      push('警告里给出可复制的命令', /add-trusted-cert/.test(injected.cmd));
      push('警告卡片不造成横向溢出', injected.overflow <= 2);

      // 设置弹窗会拦截顶栏的「证书」按钮，先关掉再点
      await page.evaluate(() => closeModals());
      await page.waitForTimeout(200);
      await page.click('#btnCa');
      await page.waitForTimeout(400);
      const caCmd = await page.$eval('#caCmdMac', (el) => el.textContent);
      push('★ 证书弹窗命令不带 -p ssl', !/-p\s+ssl\s/.test(caCmd.replace(/#.*$/gm, '')));
      push('证书弹窗提供免 sudo 命令', /add-trusted-cert/.test(caCmd) && /推荐/.test(caCmd));
      push('无 JS 运行时错误', errs.length === 0, errs.join(';'));
      await browser.close();
    }
  } catch (err) {
    push('自检执行未抛异常: ' + err.message, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  if (failed) process.exitCode = 1;
})();
