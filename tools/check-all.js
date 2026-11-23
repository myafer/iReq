'use strict';

/**
 * 一键回归：顺序跑「只读 / 不改系统代理」的自检并汇总。
 *
 *   npm run check
 *   REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check
 *
 * 刻意排除：
 *  - check-local-proxy / check-local-ui / check-local-traffic：会短暂切 macOS 系统代理，
 *    只适合在明确知道后果时手动跑；
 *  - shot*.js / audit.js / verify-ui.js：截图与人工检查工具，不是断言脚本。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { UI } = require('./_env');

const SUITES = [
  ['仓库元数据', 'check-repo-meta.js'],
  ['i18n 字典', 'check-i18n.js'],
  // 自己起独立实例（独立数据目录）测首启引导，不碰外部环境的 onboarded 标记
  ['首启引导', 'check-onboard.js'],
  ['流量存储', 'check-store.js'],
  ['DOM 结构', 'check-dom.js'],
  ['代理转发', 'check-proxy.js'],
  ['设备识别', 'check-device.js'],
  ['应用名识别', 'check-app-name.js'],
  ['分组侧栏', 'check-sidebar.js'],
  ['应用勾选级联', 'check-app-cascade.js'],
  ['空状态', 'check-empty-state.js'],
  ['滚动条', 'check-scrollbar.js'],
  ['分栏拖动', 'check-splitters.js'],
  ['详情面板（按需打开 / 上下分割线 / 长域名展开）', 'check-detail-pane.js'],
  ['界面字号', 'check-scale.js'],
  ['Mock 编辑器', 'check-mock-editor.js'],
  ['规则工作区', 'check-rule-workspace.js'],
  // 自己造 TF* 目录做新建/改名/复制粘贴，结束时删干净
  ['文件树编辑', 'check-tree-fs.js'],
  // 自带上游 + 临时令牌，跑完把 MCP 关掉、令牌撤销
  ['MCP 接入', 'check-mcp.js'],
  ['MCP 新工具（断点 / 脚本 / 告警 / 映射 / 脱敏 / 派生列 / 标注 / 性能）', 'check-mcp-tools.js'],
  // 会清空流量并生成历史记录，跑完恢复内存上限、删掉自己造的历史
  ['历史记录与分页', 'check-history.js'],
  // 造上游流量验证「搜正文」与排序，跑完清掉历史
  ['正文搜索与排序', 'check-search.js'],
  // 断点会真的把连接挂起来，跑完把开关关掉、队列清空
  ['断点拦截', 'check-breakpoint.js'],
  // 自己起一个上游服务，验证映射真的改了目标地址；跑完关开关、清规则
  ['域名映射', 'check-hostmap.js'],
  // 导入 HAR 会生成一条历史记录，跑完删掉
  ['导入 HAR', 'check-har.js'],
  // 会清空流量并造一批带二进制响应的流量，跑完再清一次
  ['正文下载与图片预览', 'check-body.js'],
  ['应用图标', 'check-app-icon.js'],
  ['证书信任', 'check-ca-trust.js'],
  ['控制坞', 'check-dock.js'],
  ['筛选条', 'check-filterbar.js'],
  ['证书档案与一键信任', 'check-ca-persist.js'],
  ['代理地址', 'check-address.js'],
  // 会短暂切系统代理到 PAC 模式，脚本结束自己还原
  ['抓包范围（只抓指定域名）', 'check-scope.js'],
  ['精简交互', 'check-simple-ui.js'],
  // 会清空流量 / 诊断数据，必须排最后
  ['握手失败列表', 'check-tls-list.js'],
  ['握手失败处理后清除', 'check-tls-clear.js'],
  // 会改白名单配置 / 清诊断，脚本内部自己恢复现场
  ['握手失败自动跳过解密', 'check-passthrough-auto.js'],
  // 会改 networkSim 配置并清空流量，放最末；脚本结束会自己恢复现场
  ['网络模拟', 'check-network-sim.js'],
  ['断网/弱网即时生效', 'check-net-live.js'],
  // 会改 h2Enabled / mitmPorts / networkSim 并清空流量，脚本结束自己恢复现场
  ['HTTP/2 解密', 'check-http2.js'],
  // 会清空流量 / 诊断数据 + 自己起慢上游，必须最后跑
  ['发起即见与清空同步', 'check-instant.js'],
  // 会改派生列 / 告警 / 脚本配置并清空流量，结束时恢复现场
  ['派生列', 'check-columns.js'],
  // 会改告警规则、挂 SSE 收 alert，结束时恢复配置
  ['条件告警', 'check-alerts.js'],
  // 会改脚本规则并打真实请求，结束时恢复配置
  ['脚本规则', 'check-scripts.js'],
  // 会写 / 删自己的标注，结束时清空流量
  ['请求标注', 'check-annotations.js'],
  // 会临时占端口起反代，结束时关掉并恢复配置
  ['反向代理', 'check-reverse.js'],
  // 会改脱敏配置、清空流量，结束时恢复配置并删掉自己造的历史
  ['脱敏', 'check-redact.js'],
  // 造流量验总览与 Markdown 报告，结束时清空流量并删掉自己造的历史
  ['会话总览', 'check-overview.js'],
  // 造流量验证 WebSocket 帧 / SSE 消息，结束时清空流量并删掉自己造的历史
  ['WebSocket 帧', 'check-ws.js'],
  ['SSE 消息', 'check-sse.js'],
  // 造流量验证分阶段计时与性能聚合，结束时清空流量并删掉自己造的历史
  ['耗时分解', 'check-timing.js'],
  ['性能视图聚合', 'check-perf.js'],
];
/* e2e.js 是早期只打日志、不做断言的冒烟脚本，且仍按原生 textarea 填 #ruBody
 * （规则编辑器换成 Monaco 后该节点隐藏，必然超时）——暂不纳入一键回归，脚本保留，
 * 等改造成真正的断言脚本再收进来。 */

function probe() {
  return fetch(UI + '/api/status')
    .then((r) => r.ok)
    .catch(() => false);
}

(async () => {
  // 跑之前记下系统代理，跑完不管哪套漏了都拉回来 —— 不能让自检把用户机器留在
  // 「所有流量发往 9090」的状态里（这个坑真踩过：一条断言失败就断了网）
  const sysProxy = (() => {
    try {
      const { SystemProxy } = require('../src/system-proxy');
      const sp = new SystemProxy({ proxyPort: Number(process.env.REQLITE_PROXY_PORT) || 9090 });
      if (!sp.supported) return null;
      const svc = sp.primaryService();
      return { sp, svc, snap: sp.snapshot(svc) };
    } catch (_) {
      return null;
    }
  })();
  if (!(await probe())) {
    console.error(`✗ 控制台不可达：${UI}`);
    console.error('  先启动服务，或用 REQLITE_UI_PORT / REQLITE_PROXY_PORT 指向已运行的实例。');
    process.exit(1);
  }
  console.log(`控制台 ${UI}\n`);
  // 首启引导会盖住整页、挡住后面所有 UI 套件的点击 —— 回归实例不是真实首启，
  // 先把它标记成「看过了」。首启路径本身由 check-onboard.js 自起干净实例来测。
  try {
    await fetch(UI + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onboarded: true }),
    });
  } catch (_) {
    /* 标不上就让对应套件自己报错，不在这里掩盖 */
  }
  const results = [];
  for (const [label, file] of SUITES) {
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
      encoding: 'utf8',
      // 个别脚本跑完输出后仍挂着 SSE 连接，超时收尾按输出判定
      timeout: file === 'check-ca-trust.js' ? 20000 : 90000,
      env: process.env,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const fails = (out.match(/❌|FAIL|失败：/g) || []).length;
    const timedOutButClean = r.signal === 'SIGTERM' && fails === 0 && /\d+\/\d+ 通过|通过：|✅/.test(out);
    const ok = r.status === 0 || timedOutButClean;
    const m = out.match(/(\d+)\s*\/\s*(\d+)\s*通过/);
    const detail = m ? `${m[1]}/${m[2]}` : ok ? '通过' : `失败(${fails})`;
    results.push([label, ok, detail]);
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(14)} ${detail}${timedOutButClean ? ' (超时收尾)' : ''}`);
    if (!ok) {
      console.log(`   status=${r.status} signal=${r.signal || '-'} fails=${fails}`);
      console.log(out.split('\n').filter((l) => /❌|FAIL|Error|失败/.test(l)).slice(0, 4).join('\n'));
      console.log('   --- tail ---\n' + out.trim().split('\n').slice(-4).join('\n'));
    }
  }
  // 跑完统一拉回系统代理：哪套漏了都不该把用户的机器留在「代理指向 9090」的状态
  if (sysProxy) {
    try {
      const now = sysProxy.sp.snapshot(sysProxy.svc);
      if (JSON.stringify(now) !== JSON.stringify(sysProxy.snap)) {
        sysProxy.sp.restore(sysProxy.snap, sysProxy.svc);
        console.log('\n⚠️ 系统代理被某个套件改动过，已还原成跑之前的样子');
      }
    } catch (_) {
      /* 还原失败不阻塞结果输出 */
    }
  }
  const passed = results.filter((r) => r[1]).length;
  console.log(`\n汇总：${passed}/${results.length} 套通过`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
