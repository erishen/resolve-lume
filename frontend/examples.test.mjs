// Behavioural gate for skill cards. 2026-11-12 audit: /api/skills returned the
// literal `---` as every soul's description, so the frontend generated generic
// prompts; 6 of 17 skill cards then auto-matched ANOTHER soul. With the C-side
// task allow-list now hard-enforced, those cards would have their real tools
// refused. Cards must pin their own task and use the real description instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExamples, filterExamplesForTask } from './src/examples.ts'

const skills = [
  { name: 'article-write', description: '扫描 github 项目、生成中英双语技术文章草稿并发布。' },
  { name: 'hot-news-post', title: '热点营销内容', description: '抓取热门新闻素材、生成小红书热点文案并校验合规。' },
  { name: 'deep-review', description: '用付费 DeepSeek 模型跑深度投资复盘流水线。' },
  { name: 'post-comment', description: '在 WordPress 站点提交一条文章评论。' },
  { name: 'tech-comment-draft', description: '为掘金 / 思否文章写一条带站内链接的评论草稿。' },
  { name: 'rust-review', description: '按 Rust 团队惯例检查所有权与错误处理。' },
  { name: 'weekly-investment', description: '投资组合数据体检 + PSE 三角色周报。' },
  { name: 'planner', description: '你是 Planner，PSE 工作流的第一棒。' },
  { name: 'specialist', description: '你是 Specialist。' },
  { name: 'evaluator', description: '你是 Evaluator。' },
  { name: 'publish-inventory', description: '只读汇总各平台未发文章。' },
  { name: 'publish-dispatch', description: '按未发清单队列执行建草稿与发布。' },
  { name: 'investment-tools', description: '三个独立投资分析工具。' },
]

const grouped = buildExamples([], skills)
const cards = Object.values(grouped).flat()
const skillCards = cards.filter((c) => c.id.startsWith('skill:'))

test('every skill card pins its own soul id in `task`', () => {
  assert.deepEqual(
    skillCards.map((c) => c.id).sort(),
    [
      'skill:article-write',
      'skill:deep-review',
      'skill:hot-news-post',
      'skill:post-comment',
      'skill:rust-review',
      'skill:tech-comment-draft',
      'skill:weekly-investment',
    ],
    'unexpected skill-card set (did a soul get filtered or added?)',
  )
  for (const c of skillCards) {
    const soul = c.id.slice('skill:'.length)
    assert.equal(c.task, soul, `${c.id} must pin its own soul`)
    assert.match(c.prompt, /请使用 .* 技能：/)
  }
})

test('skill prompts carry the real description, not a generic fallback', () => {
  const hot = skillCards.find((c) => c.id === 'skill:hot-news-post')
  assert.match(hot.prompt, /小红书热点文案/)
  assert.doesNotMatch(hot.prompt, /完成文章相关的操作/)
  // The registry's Chinese business name replaces the slug "hot news post".
  assert.equal(hot.title, '热点营销内容')
  const comment = skillCards.find((c) => c.id === 'skill:post-comment')
  assert.match(comment.prompt, /WordPress/)
})

test('PSE roles and internal task souls produce no skill cards', () => {
  for (const id of ['planner', 'specialist', 'evaluator', 'publish-inventory', 'publish-dispatch', 'investment-tools']) {
    assert.ok(!skillCards.some((c) => c.id === `skill:${id}`), `${id} should not be a skill card`)
  }
})

test('a pinned task keeps only its own skill card', () => {
  const pinned = Object.values(
    filterExamplesForTask(grouped, { id: 'hot-news-post', includeTools: ['sidecar__hot-news'] }),
  ).flat()
  const pinnedSkills = pinned.filter((c) => c.id.startsWith('skill:'))
  assert.deepEqual(pinnedSkills.map((c) => c.id), ['skill:hot-news-post'])
  // No task -> the full set comes back unchanged.
  assert.equal(
    Object.values(filterExamplesForTask(grouped, null)).flat().length,
    cards.length,
  )
})
