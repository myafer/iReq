'use strict';

/**
 * 静态自检：app.js 里用到的 #id 是否都存在于 index.html。
 * 改了弹窗结构却忘了改 JS 时，这类错误只会在运行时抛 TypeError（表现为“按钮点不动”）。
 */

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set(
  [
    ...js.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g),
    ...js.matchAll(/querySelector\(\s*'#([A-Za-z0-9_-]+)'/g),
    // 通过 helper 传 id 的写法，例如 sync('#stAddrFull', text)
    ...js.matchAll(/\bsync\(\s*'#([A-Za-z0-9_-]+)'/g),
  ].map((m) => m[1])
);
// 动态拼接出来的选择器（如 `#filters button`）不在此列

// 由 renderDetail() / 规则树面包屑动态插入的元素，不在 index.html 静态结构中
const DYNAMIC = new Set([
  'tabs', 'actReplay', 'actMock', 'actCurl', 'actStar', 'actNet', 'actBreak', 'rtCrumbBack',
]);

const missing = [...usedIds].filter((id) => !htmlIds.has(id) && !DYNAMIC.has(id));
const unused = [...htmlIds].filter((id) => !usedIds.has(id) && !/^(modal|search|list|detail)/.test(id));

console.log('html ids:', htmlIds.size, '| js 引用:', usedIds.size);
if (missing.length) {
  console.log('❌ JS 引用了不存在的元素:', missing.join(', '));
} else {
  console.log('✅ JS 引用的 #id 全部存在');
}
if (unused.length) console.log('ℹ️ HTML 中未被 JS 直接引用的 id:', unused.join(', '));

process.exitCode = missing.length ? 1 : 0;
