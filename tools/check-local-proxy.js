'use strict';
const { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST } = require('./_env');

/**
 * 自检：本机系统代理接管。
 *
 * 会短暂把 macOS 系统代理切到 127.0.0.1:9090（约 1 秒），用 `scutil --proxy`
 * 确认系统层面真的生效，再走两条恢复路径，最后必须把原始配置精确还原。
 * backup 写在临时目录，不碰真实 data/。
 *
 * 注意：跑之前确保 reqLite 服务在监听 9090，否则这 1 秒里本机网页会打不开。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SystemProxy, BYPASS } = require('../src/system-proxy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-sysproxy-'));
const sp = new SystemProxy({ proxyPort: PROXY_PORT, dataDir: dir });
const checks = [];
const add = (name, ok) => checks.push([name, !!ok]);

function scutilProxy() {
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 4000 });
    const kv = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    return kv;
  } catch (_) {
    return {};
  }
}

function sameState(a, b) {
  return (
    a.web.enabled === b.web.enabled &&
    a.web.host === b.web.host &&
    a.web.port === b.web.port &&
    a.secure.enabled === b.secure.enabled &&
    a.secure.host === b.secure.host &&
    a.secure.port === b.secure.port &&
    JSON.stringify(a.bypass) === JSON.stringify(b.bypass)
  );
}

if (!sp.supported) {
  console.log('⚠️ 非 macOS，跳过系统代理往返测试（命令生成仍可用）');
  console.log(sp.commands().on);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const svc = sp.primaryService();
const original = sp.snapshot(svc);
console.log('原始状态:', JSON.stringify(original));
add('能识别网络服务', !!svc);
add('初始状态可读', typeof original.web.enabled === 'boolean');

let changed = false;
try {
  // ---- 路径一：开启 -> 系统层生效 -> 服务退出自动恢复 ----
  const on1 = sp.enable(svc);
  changed = true;
  add('开启成功', on1.ok);
  const st1 = sp.status(svc);
  console.log('开启后:', JSON.stringify({ web: st1.web, secure: st1.secure, bypass: st1.bypass }));
  add('状态识别为 reqLite 接管', st1.ours);
  add('managed 标记为 true', st1.managed);
  add('HTTP 与 HTTPS 都指向 PROXY_PORT', st1.web.port === PROXY_PORT && st1.secure.port === PROXY_PORT);
  add('本机回环域名全部绕过（防控制台自环）', BYPASS.every((d) => st1.bypass.includes(d)));

  const sc = scutilProxy();
  console.log('scutil --proxy:', JSON.stringify({ HTTPEnable: sc.HTTPEnable, HTTPPort: sc.HTTPPort, HTTPSEnable: sc.HTTPSEnable, HTTPSPort: sc.HTTPSPort }));
  add('系统层面 HTTP 代理已生效', sc.HTTPEnable === '1' && Number(sc.HTTPPort) === PROXY_PORT);
  add('系统层面 HTTPS 代理已生效', sc.HTTPSEnable === '1' && Number(sc.HTTPSPort) === PROXY_PORT);

  const auto1 = sp.autoRestore();
  console.log('服务退出自动恢复:', JSON.stringify(auto1));
  add('autoRestore 执行了恢复', auto1.restored === true && auto1.skipped !== true);
  add('自动恢复后回到原始配置', sameState(sp.snapshot(svc), original));
  add('自动恢复后清掉 backup', !fs.existsSync(sp.backupFile));
  changed = false;

  // ---- 路径二：开启 -> 用户点「释放」-> 精确恢复 ----
  const on2 = sp.enable(svc);
  changed = true;
  add('二次开启成功', on2.ok && on2.status.ours);
  const off2 = sp.disable(svc);
  console.log('用户主动关闭:', JSON.stringify({ ok: off2.ok, restored: off2.restored }));
  add('关闭返回 restored', off2.ok && off2.restored === true);
  add('关闭后回到原始配置', sameState(sp.snapshot(svc), original));
  add('关闭后状态不再是 ours', sp.status(svc).ours === false);
  changed = false;

  // ---- 路径三：没有 backup 时不应乱动系统设置 ----
  const idle = sp.autoRestore();
  add('无 backup 时 autoRestore 跳过', idle.skipped === true);
  add('跳过后系统配置未变', sameState(sp.snapshot(svc), original));
} catch (err) {
  add('执行过程无异常', false);
  console.error('异常:', err && err.stack ? err.stack : err);
} finally {
  // 兜底：无论中途哪里出错，都必须把系统代理还原
  if (changed) {
    console.log('… 兜底恢复中');
    try {
      sp.disable(svc);
    } catch (e) {
      console.error('兜底恢复失败，请手动执行：\n' + sp.commands(svc).off);
    }
  }
  const final = sp.snapshot(svc);
  add('★ 最终系统代理与运行前完全一致', sameState(final, original));
  console.log('最终状态:', JSON.stringify(final));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- 结果 ---');
for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
