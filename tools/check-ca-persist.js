'use strict';

/**
 * 自检：根证书档案化 / 固定目录 / 一键安装 / .p12 备份 / 状态卡 UI。
 *
 * 刻意不执行 POST /api/ca-trust {action:'install'} —— 那会真的改用户钥匙串。
 * install() 用注入的 runner 做单元测试，验证命令参数与 verify-cert 回读。
 * 不修改系统代理、不动真实 ~/.ireq/ca，全部落在临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CertificateAuthority, ARCHIVE_FILE } = require('../src/ca');
const { resolveCaDir, caCandidates } = require('../src/ca-dirs');
const { CaTrust } = require('../src/ca-trust');
const { UI } = require('./_env');

const checks = [];
const push = (name, ok) => checks.push([name, Boolean(ok)]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ireq-ca-persist-'));
const T = (...p) => path.join(tmp, ...p);

async function api(p, opts) {
  const r = await fetch(UI + p, opts);
  const ct = r.headers.get('content-type') || '';
  return {
    status: r.status,
    headers: r.headers,
    body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()),
  };
}

(async () => {
  try {
    // -------------------------------------------------- 1. CA 档案化与自愈
    const main = T('main');
    const a = new CertificateAuthority(main);
    push('首次生成标记 created=true / source=generated', a.created === true && a.info.source === 'generated');
    push('档案文件已落盘', fs.existsSync(path.join(main, ARCHIVE_FILE)));
    push('档案带指纹与创建时间', /^[0-9A-F]{40}$/.test(a.fingerprint) && Boolean(a.info.createdAt));
    push('档案权限为 0600', (fs.statSync(a.archivePath).mode & 0o777) === 0o600);
    push('散文件仍在（兼容 caPath / 下载端点）', fs.existsSync(a.caCertPath) && fs.existsSync(a.caKeyPath));

    const b = new CertificateAuthority(main);
    push('★ 二次启动不重建、指纹不变', b.created === false && b.fingerprint === a.fingerprint);
    push('二次启动从档案加载', b.info.source === 'archive');

    fs.unlinkSync(b.caCertPath);
    fs.unlinkSync(b.caKeyPath);
    const c = new CertificateAuthority(main);
    push('★ 散文件被删后从档案自愈', c.fingerprint === a.fingerprint && fs.existsSync(c.caCertPath));

    fs.unlinkSync(c.archivePath);
    const d = new CertificateAuthority(main);
    push('档案被删后从散文件补回', d.fingerprint === a.fingerprint && fs.existsSync(d.archivePath));

    const tampered = JSON.parse(fs.readFileSync(d.archivePath, 'utf8'));
    tampered.fingerprint = '0'.repeat(40);
    fs.writeFileSync(d.archivePath, JSON.stringify(tampered));
    const e = new CertificateAuthority(main);
    push('档案指纹被篡改时拒绝采用', e.fingerprint === a.fingerprint && e.info.source === 'files');

    // ---------------------------------------------------- 2. 旧目录迁移
    const old = T('old');
    const oldCa = new CertificateAuthority(old);
    const mig = new CertificateAuthority(T('new'), { candidates: [old, T('missing')] });
    push('★ 主档案缺失时从旧目录迁移（含私钥）', mig.migratedFrom === path.resolve(old) && mig.fingerprint === oldCa.fingerprint);
    push('迁移不算「新生成」', mig.created === false && mig.info.source === 'migrated');
    push('迁移后落地自己的档案', fs.existsSync(path.join(T('new'), ARCHIVE_FILE)));

    // ---------------------------------------------------- 3. .p12 往返
    const { der, password } = a.exportP12();
    push('导出 .p12 为非空 DER 且带密码', der.length > 1000 && password.length > 0);
    const target = new CertificateAuthority(T('p12'));
    const imported = target.importP12(der, password);
    push('★ .p12 导入后指纹一致', imported.fingerprint === a.fingerprint && target.fingerprint === a.fingerprint);
    push('导入后仍能签发叶子证书', Boolean(target.getSecureContext('example.com')));
    let rejected = false;
    try { target.importP12(der, 'definitely-wrong'); } catch (_) { rejected = true; }
    push('错误密码被拒绝且不破坏现有 CA', rejected && target.fingerprint === a.fingerprint);
    let rejectedBad = false;
    try { target.importP12(Buffer.from('not-a-p12'), ''); } catch (_) { rejectedBad = true; }
    push('非法 p12 内容被拒绝', rejectedBad);

    // ---------------------------------------------------- 4. 目录解析
    push('显式 caDir 优先', resolveCaDir({ caDir: T('explicit') }) === path.resolve(T('explicit')));
    const prev = process.env.REQLITE_CA_DIR;
    process.env.REQLITE_CA_DIR = T('env');
    push('环境变量可覆盖（自检隔离用）', resolveCaDir() === path.resolve(T('env')));
    if (prev === undefined) delete process.env.REQLITE_CA_DIR;
    else process.env.REQLITE_CA_DIR = prev;
    const cands = caCandidates({ dataDir: T('data'), repoDir: T('repo') });
    push('候选目录含旧 data/ca 且去重', cands.includes(path.resolve(T('data'), 'ca')) && new Set(cands).size === cands.length);

    // ---------------------------------------------------- 5. 一键安装（runner 注入，不碰钥匙串）
    const calls = [];
    const runner = (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'add-trusted-cert') return { ok: true, code: 0, out: '' };
      if (args[0] === 'verify-cert') return { ok: true, code: 0, out: '...certificate verification successful.' };
      if (args[0] === 'find-certificate') {
        if (args.includes('-p')) return { ok: true, code: 0, out: 'SHA-1 hash: X\n' + a.caPem };
        return { ok: true, code: 0, out: 'SHA-1 hash: ' + a.fingerprint };
      }
      return { ok: true, code: 0, out: '' };
    };
    const stateFile = T('trust-state.json');
    const mock = new CaTrust(a, { platform: 'darwin', home: os.homedir(), stateFile, runner });
    const cmds = mock.trustCommands();
    push('手动命令仍不含 -p ssl', !/-p\s+ssl/.test(cmds.user));
    push('手动命令用用户域 login.keychain', /login\.keychain-db/.test(cmds.user) && !/sudo/.test(cmds.user));
    const installed = mock.install();
    const add = calls.find(([, args]) => args[0] === 'add-trusted-cert');
    push('★ install() 真的执行了 add-trusted-cert -r trustRoot', Boolean(add) && add[1].includes('-r') && add[1].includes('trustRoot'));
    push('install() 传入当前 CA 的绝对路径', Boolean(add) && add[1].includes(path.resolve(a.caCertPath)));
    push('★ 安装后以 verify-cert 回读为准', installed.ok === true && calls.some(([, args]) => args[0] === 'verify-cert'));
    push('检测结论按指纹落盘', fs.existsSync(stateFile) && mock.state() && mock.state().sha1 === a.fingerprint);
    push('落盘状态可读回', mock.state().trusted === true);
    const other = new CaTrust(oldCa, { platform: 'darwin', home: os.homedir(), stateFile, runner });
    push('换了 CA 后旧状态自动作废', other.state() === null);
    const kc = mock.keychainInfo();
    push('keychainInfo 能解析出证书列表', Array.isArray(kc.certs) && kc.certs.length >= 1);

    // ---------------------------------------------------- 6. API 契约
    const status = await api('/api/status');
    push('GET /api/status 带 caInfo', Boolean(status.body.caInfo && status.body.caInfo.fingerprint));
    const archive = await api('/api/ca/archive');
    push('GET /api/ca/archive 返回档案元信息', archive.status === 200 && /^[0-9A-F]{40}$/.test(archive.body.fingerprint || ''));
    push('GET /api/ca/archive 返回钥匙串诊断', Array.isArray(archive.body.keychain && archive.body.keychain.certs));
    const p12res = await api('/api/ca/p12');
    push('GET /api/ca/p12 返回二进制与密码头', p12res.status === 200 && p12res.body.length > 1000 && Boolean(p12res.headers.get('x-ireq-p12-password')));
    const impRes = await api('/api/ca/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p12: p12res.body.toString('base64'), password: '' }),
    });
    push('★ 导出后直接导入（空密码回退）指纹不变', impRes.status === 200 && impRes.body.caInfo && impRes.body.caInfo.fingerprint === archive.body.fingerprint);
    const badRes = await api('/api/ca/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p12: Buffer.from('garbage').toString('base64'), password: '' }),
    });
    push('坏 p12 返回 400 且不破坏服务', badRes.status === 400 && Boolean(badRes.body.error));
    const check = await api('/api/ca-trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    push('POST ca-trust action=check 仍兼容', check.status === 200 && typeof check.body.trusted === 'boolean' && Boolean(check.body.caInfo));

    // ---------------------------------------------------- 7. UI
    let chromium, EXEC;
    try { ({ chromium, EXEC } = require('./_pw')); } catch (_) { push('Playwright 可用（跳过 UI 检查）', true); }
    if (chromium) {
      const browser = await chromium.launch({ executablePath: EXEC });
      const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(UI + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      for (const id of ['caStatusCard', 'caShield', 'caFingerprint', 'caArchivePath', 'caSource',
        'btnCaInstall', 'btnCaRecheck', 'btnCaExportP12', 'btnCaImportP12', 'caP12File',
        'caP12Password', 'lpInstallTrust']) {
        push('UI 元素 #' + id + ' 存在', (await page.$('#' + id)) !== null);
      }
      await page.click('#btnCa');
      await page.waitForTimeout(1400);
      const fp = await page.$eval('#caFingerprint', (el) => el.textContent.trim());
      push('★ 打开证书页后状态卡填上了指纹', /^[0-9A-F ]{8,}$/.test(fp));
      const archPath = await page.$eval('#caArchivePath', (el) => el.textContent.trim());
      push('状态卡显示档案绝对路径', archPath.startsWith('/'));

      const off = await page.evaluate(() => {
        renderCaStatus({ fingerprint: 'AABB', archivePath: '/tmp/x/ca-archive.json', source: 'archive' },
          { supported: true, trusted: false });
        return { cls: document.querySelector('#caShield').className,
          disabled: document.querySelector('#btnCaInstall').disabled,
          src: document.querySelector('#caSource').textContent };
      });
      push('★ 未信任时盾牌变红且一键安装可用', /off/.test(off.cls) && off.disabled === false);
      push('来源显示复用已有档案', /复用已有档案/.test(off.src));
      const on = await page.evaluate(() => {
        renderCaStatus({ fingerprint: 'AABB', archivePath: '/tmp/x/ca-archive.json', source: 'migrated' },
          { supported: true, trusted: true });
        return { cls: document.querySelector('#caShield').className,
          disabled: document.querySelector('#btnCaInstall').disabled,
          src: document.querySelector('#caSource').textContent };
      });
      push('★ 已信任时盾牌变绿且安装按钮禁用', /on/.test(on.cls) && on.disabled === true);
      push('来源显示从旧目录迁移', /从旧目录迁移/.test(on.src));

      await page.evaluate(() => {
        if (window.ReqLiteI18N) window.ReqLiteI18N.setLang('en');
        renderCaStatus({ fingerprint: 'AABB', archivePath: '/tmp/x/ca-archive.json', source: 'archive' },
          { supported: true, trusted: false });
        if (window.ReqLiteI18N) window.ReqLiteI18N.refresh();
      });
      await page.waitForTimeout(300);
      const en = await page.$eval('#caStatusCard', (el) => el.textContent);
      push('★ 英文界面状态卡无中文残留', !/[\u4e00-\u9fff]/.test(en), en.replace(/\s+/g, ' ').slice(0, 120));
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
