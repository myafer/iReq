'use strict';

/**
 * 单元自检：流量落盘 / 重启恢复 / 清空语义。
 * 不依赖运行中的服务，用临时目录跑，不动真实 data/。
 *
 * 回归点：以前 clear() 只清内存，重启后当日 JSONL 会把已清空的记录全部恢复。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FlowStore } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-store-'));
const checks = [];
const mk = (i) => ({
  id: `flow-${i}`,
  ts: Date.now(),
  method: 'GET',
  url: `http://example.test/api/${i}`,
  host: 'example.test',
  path: `/api/${i}`,
  scheme: 'http',
  status: 200,
  // 用一个明确的「远程设备」IP：本机网卡 IP 现在会被归到「本机」设备组
  clientIp: '10.131.47.43',
  reqHeaders: { 'user-agent': 'echo/1.8.0 (iPhone; iOS 17.0)' },
  resHeaders: {},
  reqBody: '',
  resBody: '{"ok":true}',
});

try {
  const a = new FlowStore({ dir });
  for (let i = 0; i < 3; i++) a.add(mk(i));
  checks.push(['写入内存', a.stats().total === 3]);

  const b = new FlowStore({ dir });
  checks.push(['重启恢复历史', b.stats().total === 3]);
  checks.push(['恢复后详情仍在', b.get('flow-1') && b.get('flow-1').resBody === '{"ok":true}']);
  checks.push(['恢复后派生维度可补算', b.facets().apps[0].label === 'echo 1.8.0' && b.facets().devices[0].label.includes('iOS')]);

  a.clear();
  checks.push(['清空后内存为空', a.stats().total === 0]);

  const c = new FlowStore({ dir });
  checks.push(['★ 清空后重启不会复活', c.stats().total === 0]);

  const archived = fs.readdirSync(dir).filter((f) => f.includes('.cleared-'));
  checks.push(['原始抓包被归档而非删除', archived.length === 1]);

  c.add(mk(99));
  const d = new FlowStore({ dir });
  checks.push(['清空后新流量正常落盘恢复', d.stats().total === 1 && d.get('flow-99') !== undefined]);

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
