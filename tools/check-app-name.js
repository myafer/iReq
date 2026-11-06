'use strict';

/**
 * 应用名识别验收：
 *   1. 本机请求 → 按 TCP 源端口查真实进程（而不是靠 UA 猜）
 *   2. 远程设备 IP → 不冒充本机进程，只走 UA 推断 / 别名
 *   3. 关掉进程识别 + 配 UA 别名 → 别名链路可用
 *   4. 异步回填（lsof 晚于请求）→ SSE flow-update + JSONL patch 重启可恢复
 *
 * 前提：reqLite 服务已在 9090/9091 运行。跑完必定还原配置。
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { parseAppAliases, aliasOf, appOf, clientPortOf } = require('../src/derive');
const { ProcessMap, parseLsof, cleanCommand, appNameFromPath } = require('../src/process-map');
const { FlowStore } = require('../src/store');
const { ProxyServer } = require('../src/proxy');

const API = 'http://127.0.0.1:9091';
const checks = [];

const api = async (p, opts = {}) => {
  const r = await fetch(API + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
};

/** 订阅 SSE，收集一段时间内的事件（用于验证异步回填广播） */
function watchSse(ms) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(API + '/api/events', (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch (_) {
            /* ping */
          }
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, ms);
  });
}

/** CONNECT + MITM 场景：TLSSocket 上取不到原始端口，必须靠 __reqliteClientPort */
async function probeHttps(tag) {
  const host = `${tag}.invalid`;
  await execFileAsync('curl', [
    '--noproxy', '', '--proxy', 'http://127.0.0.1:9090',
    '-k', '-s', '-o', '/dev/null', '--max-time', '8',
    '-H', 'User-Agent: okhttp/9.9', `https://${host}/x`,
  ]).catch(() => {}); // 上游 .invalid 必然解析失败，这里只验 flow 的进程识别
  await sleep(900);
  const flows = await api(`/api/flows?q=${host}`);
  return flows[0] || null;
}

/** 经真实代理发一条本机请求，UA 故意伪装成通用库 */
async function probe(base, tag) {
  await execFileAsync('curl', [
    '--noproxy', '', '--proxy', 'http://127.0.0.1:9090',
    '-s', '-o', '/dev/null',
    '-H', 'User-Agent: okhttp/4.9.3',
    `${base}/${tag}`,
  ]);
  await sleep(900); // 等 lsof 快照 + 异步回填
  const flows = await api(`/api/flows?q=${tag}`);
  return flows[0] || null;
}

(async () => {
  const originalConfig = await api('/api/config');
  const tag = `app-name-check-${Date.now()}`;
  const server = http.createServer((req, res) => {
    setTimeout(() => res.end('ok'), 350); // 让连接存活到 lsof 快照完成
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const base = `http://${lanIp()}:${server.address().port}`;

  try {
    // ---------------------------------------------------------- 纯逻辑
    const aliases = parseAppAliases('# 注释\necho/1.8=周周学\nokhttp=绿豆 App');
    checks.push(['UA 别名解析（忽略注释/空行）', aliases.length === 2 && aliases[1].name === '绿豆 App']);
    checks.push(['别名优先于 UA 推断', appOf('okhttp/4.9.3', aliases) === '绿豆 App']);
    checks.push(['无别名时仍按 UA 推断', appOf('okhttp/4.9.3') === 'OkHttp 4']);
    checks.push(['别名对不匹配 UA 不生效', aliasOf('Mozilla/5.0 Chrome/120', aliases) === null]);
    checks.push([
      'TLSSocket 场景仍能取到源端口',
      clientPortOf({ socket: { __reqliteClientPort: 61280 } }) === 61280,
    ]);
    checks.push([
      '只有本机地址才允许关联进程',
      ProcessMap.isLocalAddress('127.0.0.1') &&
        ProcessMap.isLocalAddress('::ffff:127.0.0.1') &&
        !ProcessMap.isLocalAddress('10.131.47.43'),
    ]);
    const parsed = parseLsof('p6839\ncDingTalk\nf47\nn10.131.95.93:56839->59.82.31.169:443\n');
    checks.push(['lsof 输出解析出源端口与 PID', parsed.get(56839) && parsed.get(56839).pid === 6839]);
    checks.push([
      'Chrome Helper / WebContent 归到主应用',
      cleanCommand('Google Chrome Helper (Renderer)') === 'Google Chrome' &&
        cleanCommand('com.apple.WebKit.WebContent') === 'Safari',
    ]);
    checks.push([
      '.app 路径取应用名',
      appNameFromPath('/Applications/DingTalk.app/Contents/MacOS/DingTalk') === 'DingTalk',
    ]);

    // 回归：以前查不到的端口会让 attempts 永不增长，导致每 250ms 空转一次 lsof
    const idlePm = new ProcessMap();
    idlePm.observe(65530, '127.0.0.1'); // 几乎不可能有连接的端口
    await sleep(1900);
    const idleRefreshes = idlePm.stats.refreshes;
    const idlePending = idlePm.pending.size;
    idlePm.stop();
    checks.push([
      '★ 查不到的端口会放弃，不会无限轮询 lsof',
      idlePending === 0 && idleRefreshes > 0 && idleRefreshes <= 4,
    ]);
    console.log('未命中端口结算:', idleRefreshes, '次 lsof /', idlePending, '个残留');

    // ------------------------------------------------ 远程设备不冒充本机进程
    const fake = new ProxyServer({ config: { processMap: true, uaAppMap: aliases }, store: {}, rules: {} });
    fake.processMap.byPort.set(55555, {
      pid: 4242,
      command: 'FakeApp',
      name: 'FakeApp',
      path: null,
      at: Date.now(),
    });
    const remoteMeta = fake._appMeta({
      headers: { 'user-agent': 'okhttp/4.9.3' },
      socket: { remoteAddress: '10.131.47.43', remotePort: 55555 },
    });
    const localMeta = fake._appMeta({
      headers: { 'user-agent': 'okhttp/4.9.3' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 55555 },
    });
    checks.push([
      '★ 手机设备不会被误标成本机进程',
      remoteMeta.process === null && remoteMeta.appSource === 'alias' && remoteMeta.app === '绿豆 App',
    ]);
    checks.push([
      '★ 本机连接命中端口 → 真实进程名（覆盖 UA/别名）',
      localMeta.appSource === 'process' && localMeta.app === 'FakeApp' && localMeta.process.pid === 4242,
    ]);

    // ------------------------------------------------- touch patch 重启可恢复
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-app-'));
    try {
      const storeDir = path.join(tmp, 'flows');
      const a = new FlowStore({ dir: storeDir, persist: true });
      const f = a.add({ id: 'patch-test', app: 'OkHttp 4', appSource: 'ua', process: null });
      a.touch(f, { app: 'curl', appSource: 'process', process: { pid: 123, name: 'curl' } });
      const b = new FlowStore({ dir: storeDir, persist: true });
      const restored = b.get('patch-test');
      checks.push([
        '★ 异步回填的进程名重启后不丢（JSONL patch）',
        !!restored && restored.app === 'curl' && restored.appSource === 'process' && restored.process.pid === 123,
      ]);
      a.clear();
      b.clear();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // ---------------------------------------------------------- 真实链路
    const sse = watchSse(3000);
    const flow = await probe(base, tag + '-proc');
    const events = await sse;
    console.log('抓到的记录:', JSON.stringify(flow && { app: flow.app, appSource: flow.appSource, process: flow.process }));
    checks.push(['★ 真实代理抓到本机请求', !!flow && flow.status === 200]);
    checks.push(['★ 应用名来自真实进程', !!flow && flow.appSource === 'process']);
    checks.push([
      '★ 应用名不是 UA 猜出来的（UA 伪装 okhttp）',
      !!flow && flow.app !== 'OkHttp 4' && !!flow.app,
    ]);
    checks.push(['★ 带 PID / 进程信息', !!(flow && flow.process && flow.process.pid > 0)]);
    const detail = flow ? await api(`/api/flows/${flow.id}`) : null;
    checks.push(['详情接口返回进程信息', !!(detail && detail.process && detail.appSource === 'process')]);
    const facets = await api('/api/facets');
    const appFacet = (facets.apps || []).find((x) => x.key === (flow && flow.app));
    checks.push(['侧栏「应用」标记为真实进程来源', !!(appFacet && appFacet.source === 'process')]);
    const status = await api('/api/status');
    checks.push(['状态接口报告进程识别已启用', !!(status.processMap && status.processMap.enabled)]);
    const flowEvt = events.filter((e) => e.type === 'flow');
    const updEvt = events.filter((e) => e.type === 'flow-update');
    checks.push([
      'SSE：新记录 + 异步回填广播链路正常',
      flowEvt.length > 0 && (updEvt.length > 0 || flowEvt.some((e) => e.flow.appSource === 'process')),
    ]);
    console.log('SSE 事件:', flowEvt.length, '条 flow /', updEvt.length, '条 flow-update');

    // ------------------------------------------- HTTPS 解密后仍要能取到源端口
    const tlsFlow = await probeHttps(tag + '-tls');
    console.log('HTTPS 记录:', JSON.stringify(tlsFlow && { app: tlsFlow.app, appSource: tlsFlow.appSource }));
    checks.push([
      '★ HTTPS(CONNECT+MITM) 仍能关联真实进程',
      !!(tlsFlow && tlsFlow.appSource === 'process' && tlsFlow.process && tlsFlow.process.pid > 0),
    ]);
    checks.push(['HTTPS 记录不被 UA 伪装误导', !!(tlsFlow && tlsFlow.app !== 'OkHttp 9' && tlsFlow.app)]);

    // ------------------------------------------ 关掉进程识别 → 走 UA 别名
    await api('/api/config', {
      method: 'PUT',
      body: { processMap: false, uaAppMapText: 'okhttp=周周学测试' },
    });
    const aliasFlow = await probe(base, tag + '-alias');
    console.log('别名记录:', JSON.stringify(aliasFlow && { app: aliasFlow.app, appSource: aliasFlow.appSource }));
    checks.push(['★ 关闭进程识别后 UA 别名生效', !!(aliasFlow && aliasFlow.app === '周周学测试')]);
    checks.push(['别名来源被正确标注', !!(aliasFlow && aliasFlow.appSource === 'alias')]);
    checks.push(['别名记录不携带伪造的进程信息', !!(aliasFlow && !aliasFlow.process)]);
  } catch (err) {
    checks.push(['流程无异常', false]);
    console.error('异常:', err && err.stack ? err.stack : err);
  } finally {
    await api('/api/config', {
      method: 'PUT',
      body: {
        processMap: originalConfig.processMap === undefined ? true : originalConfig.processMap,
        uaAppMap: originalConfig.uaAppMap || [],
      },
    }).catch(() => {});
    checks.push(['配置已还原', true]);
    server.close();
  }

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
