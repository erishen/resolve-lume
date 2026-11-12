'use strict'
// Business-facing copy for the soul-derived task cards.
//
// resolve-studio keeps a curated task registry (packages/core/src/plugins/tasks.ts):
// Chinese business names plus a one-line description. resolve-lume derives its
// catalog from souls/ on disk, so the UI used to show the raw directory slug
// ("article-write") as the title and the whole skill-doc paragraph as the
// description — same tasks, wildly different copy depending on which bundle you
// opened. This table restores studio's wording for the souls that have an
// equivalent task there, and gives the lume-only souls the same shape (short
// Chinese name + one sentence that says what you get).
//
// The system prompt still comes from SOUL.md; only the card text changes.

const TASK_COPY = {
  'article-write': {
    name: '技术文章写作与发布',
    description:
      '扫描 github 项目、用 crewai-pse 三角色流水线生成中英双语技术文章草稿、校验并发布到 WordPress（掘金/思否/微信草稿）。',
  },
  'publish-dispatch': {
    name: '平台草稿与发布队列',
    description:
      '按未发清单队列自动执行建掘金草稿 / 公众号草稿 / 思否发布 / 掘金草稿上线；每次处理下一篇，无需选项目。',
  },
  'hot-news-post': {
    name: '热点营销内容',
    description:
      '抓取热门新闻素材、列候选话题、生成小红书等热点文案、校验合规（限值/违禁词/AI 声明）。',
  },
  'weekly-investment': {
    name: '投资分析',
    description:
      '投资组合数据体检 + PSE 三角色周报：先刷新快照并扫描异常，再产出组合概览、收益点评、风险警示与调仓建议。注意：会把持仓明细发送给所选模型服务商。',
  },
  'code-review': {
    name: '代码审查',
    description: '审查代码文件并输出结构化报告：问题清单、严重度分级与具体修改建议。',
  },
  'rust-review': {
    name: 'Rust 代码审查',
    description: '按 Rust 团队惯例检查代码质量：所有权与错误处理、API 设计、可读性，逐条给出修改建议。',
  },
  'tech-comment-draft': {
    name: '技术社区评论草稿',
    description:
      '为掘金 / 思否文章写一条真诚具体、带自然站内链接的评论草稿；只出草稿，不代发。',
  },
  'post-comment': {
    name: 'WordPress 文章评论',
    description: '在 WordPress 站点随机取一篇已发布文章提交一条评论，用于验证站内互动。',
  },
  'pse-review': {
    name: 'PSE 三角色评审',
    description:
      '用 PSE 多智能体流水线（Planner / Specialist / Evaluator）做多视角评审，产出带证据与自检的结论。',
  },
  // Ported from resolve-studio's registry so the task list matches 1:1.
  devstats: {
    name: '开发数据统计',
    description:
      '查掘金/思否文章阅读数据、汇总双平台传播对比、巡检各仓库 GitHub Actions CI 状态、导出仓库统计 CSV（dev-stats 项目）。',
  },
  foundation: {
    name: '通用分析目录',
    description:
      '分析文件或代码目录的结构、内容与依赖，理解一个代码库/文件夹后再回答；提供系统信息与通用计算。',
  },
  privacy: {
    name: '隐私与合规自查',
    description:
      '审计当前 repo 是否有隐私泄露（.gitignore 覆盖/硬编码密钥/历史提交敏感文件等 9 项检查），PDF 转 Markdown。',
  },
  documents: {
    name: '文档与资料库检索',
    description:
      '在本地 markdown 文档库全文检索、查照片重复、批量 Word 转 Markdown，基于本地只读服务。',
  },
  recruiting: {
    name: '简历与求职',
    description: '定制简历、生成面试题、记录 CRM 求职任务。',
  },
  web: {
    name: '联网调研',
    description: '浏览网页、抓取并总结外部信息。',
  },
  'deep-review': {
    name: '深度投资复盘',
    description:
      '用付费 DeepSeek 模型驱动 autogen-pse 多智能体团队（Planner/Specialist/Evaluator + 个人知识库检索）跑完整组合复盘流水线，生成深度周报；付费模型、会触发审批，适合周度正式复盘。注意：会把持仓明细发送给所选模型服务商。',
  },
  general: {
    name: '通用对话',
    description: '默认模式：单 agent 直接对话（不启用 PSE 三角色）。',
  },
}

// Tool-scope cards. Studio defines these in the same registry; lume only renders
// them, so the wording (and the presence of the `web` tier) is copied verbatim.
const SCOPES = [
  {
    id: 'core',
    name: '仅核心工具',
    description: '只注入 read-file / write-file / shell / skill-run 四个基础工具。',
    includeTools: ['read-file', 'write-file', 'shell', 'skill-run'],
  },
  {
    id: 'files',
    name: '核心 + 文件',
    description: '核心工具 + 文件系统（fs 前缀）。',
    includeTools: ['read-file', 'write-file', 'shell', 'skill-run', 'fs'],
  },
  {
    id: 'web',
    name: '核心 + 联网',
    description: '核心工具 + 文件系统 + 浏览器（浏览/截图）。',
    includeTools: [
      'read-file',
      'write-file',
      'shell',
      'skill-run',
      'fs',
      'browser-open',
      'browser-screenshot',
    ],
  },
]

// A soul body is written like a skill doc: `${SKILL_DIR}/scripts/x.mjs`.
// The model has no shell variable for it, so it used to run the literal path and
// fail ("node: /scripts/..." ). Substitute the soul's real directory — shell and
// file tools execute on the sidecar host, which is where SOULS_DIR points.
function renderSoulPrompt(body, soulsDir, id) {
  return String(body || '').replace(/\${SKILL_DIR}/g, `${soulsDir}/${id}`)
}

// Card copy for a task id; unknown ids fall back to whatever the soul declares.
function taskCopy(id) {
  return TASK_COPY[id]
}

module.exports = { TASK_COPY, SCOPES, taskCopy, renderSoulPrompt }
