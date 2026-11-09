'use strict';

/**
 * 自检：英文字典覆盖率（只读，不改任何文件）
 *
 *  1. 孤儿键：字典里有、但源码里已经找不到对应中文文案的条目。
 *     UI 精简 / 改文案后最容易留下一堆，dictionnary 越攒越脏。
 *  2. 未覆盖：源码里的中文 UI 文本没有对应字典键（英文模式会残留中文）。
 *     动态拼接的句子会误报，所以只报告、不做失败断言。
 *
 * 用法：node tools/check-i18n.js [--json]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DICT = path.join(ROOT, 'public', 'i18n-en.js');

/* 这些句子由运行时拼出来（带数字 / IP / 变量名），源码里没有整句，属于正常条目 */
const WHITELIST = new Set([
  'lsof 快照 0 次 · 解析到 0 个连接 · 未命中 0',
  '当前 v1.2.3，已是最新。上次检查 2026/11/9 09:46:25。',
  '网络服务  : Wi-Fi Web 代理  : 127.0.0.1:7897 安全 Web  : 127.0.0.1:7897 绕过域名  : 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, *.crashlytics.com, <local> 根证书    : 根证书已装进钥匙串，但还没设为「始终信任」 解密模式  : 正常',
  '根证书已装进钥匙串，但还没设为「始终信任」（Cert Verify Result: CSSMERR_TP_NOT_TRUSTED）',
  '自动 · 文本',
  '本机 · 回环地址与本机所有网卡 IP 都算本机',
  '局域网 · en1',
  '本机回环 · lo0',
  '复制端口 9193（Wi-Fi 代理的「端口」）',
  'demo-app/2.0=我的App okhttp=另一个App CFNetwork=我的 iOS 客户端',
  '行 1 · 列 1',
  '0 条',
]);

function loadDict() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(DICT, 'utf8'), sandbox, { filename: 'i18n-en.js' });
  return sandbox.window.ReqLiteI18N_EN || {};
}

/* 只把尖括号换成空格，保留标签内部的属性文本（title / placeholder 也要算源码依据）；
 * HTML 实体先解码，否则证书弹窗里的 &amp;&amp; 会被误判成孤儿键。 */
const norm = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;|&gt;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const HAN = /[\u4e00-\u9fff]/;

function sourceFiles() {
  const out = [];
  const skipDirs = new Set(['vendor', 'node_modules', 'data', 'release', 'dist', '.git']);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (!skipDirs.has(name)) walk(p);
      } else if (/\.(html|js)$/.test(name) && name !== 'i18n-en.js' && name !== 'check-i18n.js') {
        out.push(p);
      }
    }
  };
  for (const d of ['public', 'src', 'electron']) walk(path.join(ROOT, d));
  return out;
}

/* 从 index.html 抽中文文本节点 + 中文属性值，作为「未覆盖」的输入 */
function uiTexts(html) {
  const texts = [];
  const re = />([^<>]*[\u4e00-\u9fff][^<>]*)</g;
  let m;
  while ((m = re.exec(html))) texts.push(norm(m[1]));
  const attrRe = /(?:title|placeholder|aria-label|alt|data-title)="([^"]*[\u4e00-\u9fff][^"]*)"/g;
  while ((m = attrRe.exec(html))) texts.push(norm(m[1]));
  return texts.filter(Boolean);
}

(async () => {
  const dict = loadDict();
  const keys = Object.keys(dict);
  const files = sourceFiles();
  const blobs = files.map((f) => ({ file: f, text: norm(fs.readFileSync(f, 'utf8')) }));
  const all = blobs.map((b) => b.text).join('\n');

  const orphans = keys.filter((k) => !WHITELIST.has(k) && !all.includes(norm(k)));
  const exact = new Set(keys.map(norm));
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const uncovered = [...new Set(uiTexts(indexHtml))].filter((t) => HAN.test(t) && !exact.has(t));

  const result = {
    dictKeys: keys.length,
    sourceFiles: files.length,
    orphans,
    uncovered,
    ok: orphans.length === 0,
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`字典 ${keys.length} 条 / 扫描源码 ${files.length} 个文件`);
    console.log(`孤儿键 ${orphans.length} 条${orphans.length ? ':' : ' ✅'}`);
    orphans.forEach((k) => console.log('  - ' + k));
    console.log(`未覆盖的中文 UI 文本 ${uncovered.length} 条（动态文案会误报，仅供参考）`);
    uncovered.slice(0, 12).forEach((t) => console.log('  ? ' + t));
    console.log(result.ok ? '\n通过：字典无孤儿键' : '\n失败：字典存在孤儿键');
  }
  process.exitCode = result.ok ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
