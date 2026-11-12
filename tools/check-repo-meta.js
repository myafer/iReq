'use strict';

/**
 * 静态自检：GitHub 仓库元数据
 *
 * 为什么单独一套：Issue Forms 的 YAML 写错时 GitHub 会**静默不显示模板**，
 * 页面上什么都不报，用户只是点不到「Bug 报告」——这类失败运行时完全看不出来。
 * 同理，分流 workflow 一旦拿到代码写权限，自动化就有了改主干的可能，必须用自检兜住。
 *
 * 覆盖：
 *  1. issue 模板存在、必备字段齐全、body 里 type 合法
 *  2. bug 模板强制收集 版本 / 平台 / 复现步骤（否则分流追问也没依据）
 *  3. config.yml 关闭空白 issue，只留排障入口
 *  4. triage workflow 只拿 issues 写权限，脚本里不得出现 git push / gh pr create
 *  5. 双语 README 都有反馈入口
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const checks = [];
const push = (name, ok, detail) => checks.push([name, !!ok, detail]);

/** 顶层 key（行首无缩进），用来判断 name / description / body 是否齐全 */
const topKeys = (y) => [...y.matchAll(/^([A-Za-z_]+):/gm)].map((m) => m[1]);
const bodyTypes = (y) => [...y.matchAll(/^\s*-\s*type:\s*([a-z]+)/gm)].map((m) => m[1]);
const bodyIds = (y) => [...y.matchAll(/^\s+id:\s*([A-Za-z0-9_-]+)/gm)].map((m) => m[1]);

const TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']);

/* ---------------- issue 模板 ---------------- */
for (const [file, needIds] of [
  ['bug.yml', ['version', 'platform', 'steps']],
  ['feature.yml', ['scene', 'weight']],
]) {
  const rel = `.github/ISSUE_TEMPLATE/${file}`;
  if (!exists(rel)) {
    push(`${file} 存在`, false, '文件缺失');
    continue;
  }
  const y = read(rel);
  const keys = topKeys(y);
  push(`${file} 有 name / description / title`, ['name', 'description', 'title'].every((k) => keys.includes(k)), keys.join(','));
  push(`${file} 有 body`, keys.includes('body'));

  const types = bodyTypes(y);
  push(`${file} 的 body 项类型合法`, types.length > 0 && types.every((t) => TYPES.has(t)), types.join(','));

  const ids = bodyIds(y);
  push(`${file} 必填项齐全`, needIds.every((i) => ids.includes(i)), `缺 ${needIds.filter((i) => !ids.includes(i)).join(',') || '无'}`);

  // 每个 input/textarea/dropdown 都要有 label，否则表单上是空白一栏
  const itemCount = types.filter((t) => t !== 'markdown').length;
  const labelCount = [...y.matchAll(/^\s+label:\s*\S/gm)].length;
  push(`${file} 每项都有 label`, labelCount >= itemCount, `项 ${itemCount} / label ${labelCount}`);
}

/* ---------------- config.yml ---------------- */
if (exists('.github/ISSUE_TEMPLATE/config.yml')) {
  const c = read('.github/ISSUE_TEMPLATE/config.yml');
  push('空白 issue 已关闭', /^blank_issues_enabled:\s*false/m.test(c));
  push('config 里有排障引导链接', /contact_links:/.test(c) && /github\.com\/myafer\/iReq/.test(c));
} else {
  push('config.yml 存在', false, '文件缺失');
}

/* ---------------- 分流 workflow 的护栏 ---------------- */
if (exists('.github/workflows/triage.yml')) {
  const w = read('.github/workflows/triage.yml');
  push('分流由 issue 打开事件触发', /^\s{2}issues:/m.test(w) && /types:\s*\[opened\]/.test(w));
  push('分流只拿 issues 写权限', /issues:\s*write/.test(w));
  push('分流没有代码写权限', !/contents:\s*write/.test(w) && !/pull-requests:\s*write/.test(w));
  push('分流不碰 pull-requests', !/pull-requests:/.test(w));
} else {
  push('triage.yml 存在', false, '文件缺失');
}

if (exists('.github/scripts/triage.js')) {
  const s = read('.github/scripts/triage.js');
  // 护栏可执行化：L0 只分类打标，任何写代码 / 开 PR 的动作都不允许出现在脚本里
  const forbidden = ['git push', 'git commit', 'gh pr create', 'git checkout'];
  const hit = forbidden.filter((f) => s.includes(f));
  push('分流脚本不做任何代码改动', hit.length === 0, hit.join(','));
  push('分流脚本能优雅跳过（无密钥不报错）', /if \(!KEY\)/.test(s));
} else {
  push('triage.js 存在', false, '文件缺失');
}

/* ---------------- README 反馈入口 ---------------- */
for (const f of ['README.md', 'README.zh-CN.md']) {
  const r = read(f);
  push(`${f} 有反馈入口`, /issues\/new/.test(r));
  push(`${f} 提到应用内入口`, /反馈与建议|Feedback & ideas/.test(r));
}

let fail = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} 项通过`);
process.exitCode = fail ? 1 : 0;
