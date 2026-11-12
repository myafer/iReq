'use strict';

/**
 * Issue 自动分流（L0 级）
 *
 * 做三件事，别的什么都不做：
 *   1. 读 issue，判类型（bug / 建议 / 使用问题 / 重复）和优先级
 *   2. 打标签：bug / enhancement / question / duplicate / P0-P3 / needs-info
 *   3. 缺关键信息时贴一条追问评论；信息齐了就给一句「已收到」+ 预期节奏
 *
 * 硬约束：不写代码、不开分支、不关 issue、不改标题。哪怕整条链路挂了也只打日志退出，
 * 绝不让用户看到「自动机器人报错」——用户提 issue 的意愿比自动化重要得多。
 *
 * 环境变量：
 *   LLM_API_KEY     没配置就直接跳过（默认状态，零成本）
 *   LLM_BASE_URL    OpenAI 兼容网关，默认 https://api.openai.com/v1
 *   LLM_MODEL       默认 gpt-4o-mini
 *   ISSUE_NUMBER / GITHUB_REPOSITORY  由 workflow 注入
 */
const { execFileSync } = require('child_process');

const KEY = process.env.LLM_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const REPO = process.env.GITHUB_REPOSITORY || '';
const NUM = process.env.ISSUE_NUMBER || '';

/** 只允许打这些标签，避免模型编出奇怪的名字把仓库搞乱 */
const ALLOWED = new Set([
  'bug', 'enhancement', 'question', 'duplicate',
  'P0', 'P1', 'P2', 'P3', 'needs-info',
]);

const LABEL_COLOR = {
  bug: 'd73a4a', enhancement: 'a2eeef', question: 'd876e3', duplicate: 'cfd3d7',
  P0: 'b60205', P1: 'd93f0b', P2: 'fbca04', P3: '0e8a16', 'needs-info': '5319e7',
};

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ensureLabel(name) {
  try {
    gh(['label', 'create', name, '--color', LABEL_COLOR[name] || 'ededed', '--force']);
  } catch (_) {
    /* 已经存在 / 没权限，都不影响主流程 */
  }
}

const SYSTEM = `你在给一个开源的 macOS/Windows 抓包调试工具（iReq）做 issue 分流。
只输出 JSON，不要解释、不要代码块围栏。字段：
{
  "kind": "bug" | "feature" | "question" | "duplicate",
  "priority": "P0" | "P1" | "P2" | "P3",
  "missing": ["version" | "platform" | "steps" | "expect"],
  "reason": "一句话说明判断依据",
  "reply": "给用户看的中文回复，2-3 句，语气平实，不要客套话不要 emoji"
}
判断标准：
- bug：说了「应该正常但没正常」的具体现象
- feature：想要现在没有的能力，或现有交互用着别扭
- question：在问怎么用、怎么配，没有指向具体缺陷
- duplicate：明显是已有 issue 的重复（没有把握就选 bug/feature，别猜）
- priority：阻塞工作且无绕过 = P0/P1；影响效率有绕过 = P2；锦上添花 = P3
- missing：bug 缺少复现步骤/版本/平台时列出来；建议类通常留空数组
- reply：bug 且缺信息时明确问缺的那几项；信息齐了就说已收到、会先复现；建议类说明会按场景评估、不一定照搬方案`;

async function classify(issue) {
  const body = [
    `标题：${issue.title}`,
    `正文：\n${(issue.body || '(空)').slice(0, 4000)}`,
  ].join('\n\n');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: body },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(json);
}

(async () => {
  if (!KEY) {
    console.log('未配置 LLM_API_KEY，跳过自动分流（这是默认状态）');
    return;
  }
  if (!REPO || !NUM) {
    console.log('缺少 ISSUE_NUMBER / GITHUB_REPOSITORY，跳过');
    return;
  }

  const issue = JSON.parse(gh(['api', `repos/${REPO}/issues/${NUM}`]));
  // 机器人自己的评论会触发 issue_comment 之外的事件；这里只处理人提的
  if (issue.pull_request) {
    console.log('是 PR 不是 issue，跳过');
    return;
  }

  let out;
  try {
    out = await classify(issue);
  } catch (err) {
    console.warn('分类失败，保持原样：', err.message);
    return;
  }

  const labels = [];
  const kind = ['bug', 'feature', 'question', 'duplicate'].includes(out.kind) ? out.kind : 'bug';
  labels.push({ bug: 'bug', feature: 'enhancement', question: 'question', duplicate: 'duplicate' }[kind]);
  if (kind === 'bug' && ['P0', 'P1', 'P2', 'P3'].includes(out.priority)) {
    labels.push(out.priority);
  }
  if (kind === 'bug' && Array.isArray(out.missing) && out.missing.length) {
    labels.push('needs-info');
  }

  for (const l of labels) {
    if (!ALLOWED.has(l)) continue;
    ensureLabel(l);
  }
  try {
    gh(['issue', 'edit', String(NUM), '--repo', REPO, '--add-label', labels.join(',')]);
  } catch (err) {
    console.warn('打标签失败：', err.message);
  }

  const reply = String(out.reply || '').trim();
  if (reply) {
    try {
      const suffix = kind === 'question' ? '\n\n---\n\nREADME 的「排障」一节里也有常见问题的自助处理方式。' : '';
      gh([
        'issue', 'comment', String(NUM), '--repo', REPO,
        '--body', `${reply}${suffix}\n\n<!-- triage:auto -->`,
      ]);
    } catch (err) {
      console.warn('评论失败：', err.message);
    }
  }

  console.log(`已分流：#${NUM} → ${labels.join(', ')}（${out.reason || ''}）`);
})().catch((err) => {
  // 任何意外都不让 workflow 变红
  console.warn('分流异常，已忽略：', err && err.message);
});
