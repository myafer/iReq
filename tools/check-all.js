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
  ['界面字号', 'check-scale.js'],
  ['Mock 编辑器', 'check-mock-editor.js'],
  ['规则工作区', 'check-rule-workspace.js'],
  // 自己造 TF* 目录做新建/改名/复制粘贴，结束时删干净
  ['文件树编辑', 'check-tree-fs.js'],
  // 自带上游 + 临时令牌，跑完把 MCP 关掉、令牌撤销
  ['MCP 接入', 'check-mcp.js'],
  // 会清空流量并生成历史记录，跑完恢复内存上限、删掉自己造的历史
  ['历史记录与分页', 'check-history.js'],
  ['应用图标', 'check-app-icon.js'],
  ['证书信任', 'check-ca-trust.js'],
  ['控制坞', 'check-dock.js'],
  ['筛选条', 'check-filterbar.js'],
  ['证书档案与一键信任', 'check-ca-persist.js'],
  ['代理地址', 'check-address.js'],
  ['精简交互', 'check-simple-ui.js'],
  // 会清空流量 / 诊断数据，必须排最后
  ['握手失败列表', 'check-tls-list.js'],
  ['握手失败处理后清除', 'check-tls-clear.js'],
  // 会改白名单配置 / 清诊断，脚本内部自己恢复现场
  ['跳过解密管理列表', 'check-passthrough-manager.js'],
  // 会改 networkSim 配置并清空流量，放最末；脚本结束会自己恢复现场
  ['网络模拟', 'check-network-sim.js'],
  ['断网/弱网即时生效', 'check-net-live.js'],
  // 会改 h2Enabled / mitmPorts / networkSim 并清空流量，脚本结束自己恢复现场
  ['HTTP/2 解密', 'check-http2.js'],
  // 会清空流量 / 诊断数据 + 自己起慢上游，必须最后跑
  ['发起即见与清空同步', 'check-instant.js'],
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
  const passed = results.filter((r) => r[1]).length;
  console.log(`\n汇总：${passed}/${results.length} 套通过`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
