'use strict'
// resolve-lume derives its task catalog from souls/ on disk, resolve-studio from
// a curated registry (packages/core/src/plugins/tasks.ts). Without an explicit
// copy table the lume UI showed the raw slug ("article-write") as the title and
// a whole skill-doc paragraph as the description, so the same task read
// differently depending on which bundle you opened. These assertions pin the
// studio-aligned wording.

const test = require('node:test')
const assert = require('node:assert')
const { TASK_COPY, SCOPES, taskCopy, renderSoulPrompt } = require('./taskCopy')

const BUSINESS = [
  'article-write',
  'hot-news-post',
  'weekly-investment',
  'code-review',
  'rust-review',
  'tech-comment-draft',
  'post-comment',
]

test('every business soul gets a Chinese task card instead of its slug', () => {
  for (const id of BUSINESS) {
    const copy = taskCopy(id)
    assert.ok(copy, `${id} has no card copy`)
    assert.match(copy.name, /[\u4e00-\u9fa5]/, `${id} name should be Chinese`)
    assert.ok(!/^[a-z][a-z-]*$/.test(copy.name), `${id} still shows the raw slug`)
    assert.ok(copy.description.length >= 20, `${id} description is too thin`)
    assert.ok(copy.description.length <= 120, `${id} description should stay one line`)
  }
})

test('wording matches resolve-studio where the task exists there', () => {
  assert.strictEqual(taskCopy('article-write').name, '技术文章写作与发布')
  assert.strictEqual(taskCopy('hot-news-post').name, '热点营销内容')
  assert.strictEqual(taskCopy('weekly-investment').name, '投资分析')
  assert.match(taskCopy('article-write').description, /crewai-pse/)
  assert.match(taskCopy('hot-news-post').description, /违禁词/)
})

test('dry technical copy is not reused as the card description', () => {
  // The soul frontmatter opens with tool plumbing ("为 projects.json 里的某一个
  // 项目…"); the card must read like a product task, not a tool manual.
  assert.ok(!taskCopy('article-write').description.includes('projects.json'))
})

test('task scopes mirror studio: core / files / web', () => {
  assert.deepStrictEqual(
    SCOPES.map((s) => s.id),
    ['core', 'files', 'web'],
  )
  assert.strictEqual(SCOPES[0].name, '仅核心工具')
  assert.strictEqual(SCOPES[1].name, '核心 + 文件')
  assert.strictEqual(SCOPES[2].name, '核心 + 联网')
  assert.deepStrictEqual(SCOPES[0].includeTools, ['read-file', 'write-file', 'shell', 'skill-run'])
  assert.ok(SCOPES[2].includeTools.includes('browser-open'))
})

test('unknown ids fall back to soul frontmatter (no invented copy)', () => {
  assert.strictEqual(taskCopy('some-new-soul'), undefined)
  assert.ok(Object.keys(TASK_COPY).length >= 8)
})

test('${SKILL_DIR} in a soul body becomes the real soul directory', () => {
  const body = 'run `node ${SKILL_DIR}/scripts/x.mjs`'
  assert.strictEqual(
    renderSoulPrompt(body, '/srv/souls', 'post-comment'),
    'run `node /srv/souls/post-comment/scripts/x.mjs`',
  )
})
