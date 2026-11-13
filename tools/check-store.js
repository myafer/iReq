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
  clientIp: '192.0.2.43',
  reqHeaders: { 'user-agent': 'demo-app/2.0.0 (iPhone; iOS 17.0)' },
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
  checks.push(['恢复后派生维度可补算', b.facets().apps[0].label === 'demo-app 2.0.0' && b.facets().devices[0].label.includes('iOS')]);

  a.clear();
  checks.push(['清空后内存为空', a.stats().total === 0]);

  const c = new FlowStore({ dir });
  checks.push(['★ 清空后重启不会复活', c.stats().total === 0]);

  const archived = fs.readdirSync(dir).filter((f) => f.includes('.cleared-'));
  checks.push(['原始抓包被归档而非删除', archived.length === 1]);

  c.add(mk(99));
  const d = new FlowStore({ dir });
  checks.push(['清空后新流量正常落盘恢复', d.stats().total === 1 && d.get('flow-99') !== undefined]);

  // 清空归档不能无限堆：每点一次清空就是一份完整拷贝，实测能攒到几百 MB
  for (let i = 0; i < 8; i++) {
    d.add(mk(300 + i));
    d.clear();
  }
  const archLeft = fs.readdirSync(dir).filter((f) => f.includes('.cleared-'));
  checks.push(['★ 连续清空 8 次只留 3 份归档', archLeft.length === 3]);

  // 日文件只读今天那份，更老的纯占地方：只留最近 7 份
  for (let i = 1; i <= 9; i++) {
    const day = `2026-09-${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, `flows-${day}.jsonl`), '');
  }
  new FlowStore({ dir });
  const dailyLeft = fs
    .readdirSync(dir)
    .filter((f) => /^flows-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  checks.push(['★ 日文件只留最近 7 份', dailyLeft.length === 7 && dailyLeft[6] === 'flows-2026-09-09.jsonl']);

  // 归档还有总量上限：3 个 20MB 的归档只留得下 2 个
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-store-big-'));
  try {
    for (let i = 1; i <= 3; i++) {
      const f = path.join(dir2, `flows-2026-08-${String(i).padStart(2, '0')}.jsonl.cleared-${2000 + i}`);
      fs.writeFileSync(f, Buffer.alloc(20 * 1024 * 1024));
    }
    new FlowStore({ dir: dir2 });
    const bigLeft = fs.readdirSync(dir2).filter((f) => f.includes('.cleared-'));
    checks.push(['归档总量超 50MB 时按最旧删', bigLeft.length === 2]);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // 日文件还有总量上限：单日几百 MB 时，7 份能叠到上 GB
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlite-store-daily-'));
  try {
    for (let i = 1; i <= 3; i++) {
      const f = path.join(dir3, `flows-2026-07-${String(i).padStart(2, '0')}.jsonl`);
      fs.writeFileSync(f, Buffer.alloc(80 * 1024 * 1024));
    }
    new FlowStore({ dir: dir3 });
    const left3 = fs
      .readdirSync(dir3)
      .filter((f) => /^flows-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    checks.push(['日文件总量超 200MB 时删最旧', left3.length === 2 && left3[1] === 'flows-2026-07-03.jsonl']);
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  console.log('\n--- 结果 ---');
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
