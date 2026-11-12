'use strict'
// Example cards -> auto-matched task. On 2026-11-12 an audit of all 71 cards
// found three real mis-routes: 归档一篇文章 landed on publish-inventory
// (trigger 「各平台」 also matched 「各平台副本」), dev-stats(segmentfault)
// landed on tech-comment-draft (plural loose triggers beat 「文章数据」 by one
// point), and the build-juejin fallback card said 「建成掘金草稿」 and landed on
// article-write, whose SKILL asks the user to pick a project. This gate keeps
// the card text and the soul triggers honest about each other.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { matchTaskByMessage } = require('./taskMatch')

const ROOT = path.join(__dirname, '..')
const SOULS = path.join(ROOT, 'souls')
const EXAMPLES = path.join(ROOT, 'frontend/src/examples.ts')
const PSE_ROLES = new Set(['planner', 'specialist', 'evaluator'])

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const d = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) d[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return d
}

function tasks() {
  return fs.readdirSync(SOULS)
    .filter((n) => !PSE_ROLES.has(n) && fs.existsSync(path.join(SOULS, n, 'SOUL.md')))
    .map((id) => {
      const fm = frontmatter(path.join(SOULS, id, 'SOUL.md'))
      if (!fm) return null
      return {
        id,
        triggers: fm.triggers || '',
        tools: (fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean),
      }
    })
    .filter(Boolean)
}

const TASKS = tasks()
const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]))
const matched = (p) => {
  const t = matchTaskByMessage(p, TASKS)
  return t ? t.id : null
}
const allows = (taskId, tool) => {
  const t = byId[taskId]
  if (!t) return false
  return t.tools.some((n) => n === tool || n === `sidecar__${tool}` || n.endsWith(`__${tool}`))
}

// Pull `CURATED` out of the TypeScript source by text so this gate needs no
// bundler: every entry is `'tool-name': { title, prompt, category }`.
function curatedCards() {
  const src = fs.readFileSync(EXAMPLES, 'utf8')
  const from = src.indexOf('const CURATED:')
  const to = src.indexOf('\n  }', from)
  assert.ok(from > 0 && to > from, 'CURATED block not found in examples.ts')
  const block = src.slice(from, to)
  const out = []
  const re = /^\s*'([a-z0-9_-]+)':\s*\{([\s\S]*?)^\s*\},/gm
  let m
  while ((m = re.exec(block))) {
    const pm = m[2].match(/prompt:\s*'([^']*)'/)
    if (pm) out.push({ tool: m[1], prompt: pm[1] })
  }
  return out
}

test('every curated tool card auto-matches a task that can actually run it', () => {
  const cards = curatedCards()
  assert.ok(cards.length >= 15, `only ${cards.length} curated cards parsed — parser drifted`)
  // Generic core tools are shared by most tasks and are not routed by name.
  const GENERIC = new Set(['read-file', 'write-file', 'shell', 'skill-run', 'echo', 'calculator', 'hello', 'system-info', 'make'])
  const wrong = []
  for (const c of cards) {
    if (GENERIC.has(c.tool)) continue
    const id = matched(c.prompt)
    if (!id) continue // no task matched => full tool surface, still callable
    if (!allows(id, c.tool)) wrong.push(`${c.tool} -> ${id} (prompt: ${c.prompt.slice(0, 34)})`)
  }
  assert.deepStrictEqual(wrong, [], `card/tool mismatch:\n  ${wrong.join('\n  ')}`)
})

// These are the exact card prompts that regressed. Keep them in sync with
// examples.ts: a text edit that changes routing must be reviewed here too.
// [card id, tool the card declares, exact prompt, expected task]
const PINNED = [
  ['tool:article-archive', 'article-archive', '帮我归档一篇文章，重建各平台副本并更新关键词索引。', 'article-write'],
  ['tool:dev-stats-segmentfault', 'dev-stats', '用 dev-stats 工具（target=segmentfault）查思否文章数据，按日均阅读排序取前 5 篇。', 'devstats'],
  ['tool:build-juejin', 'build-juejin', '帮我用 build-juejin 为队列里下一篇缺副本的稿子生成本地副本（只写本地掘金版 md，不建草稿）。', 'publish-dispatch'],
  ['tool:publish-pending', 'publish-pending', '帮我列出掘金、思否、公众号、英文稿各平台还有哪些文章没发出去，以及每个下一步该做什么。', 'publish-inventory'],
  ['tool:juejin-draft', 'juejin-draft', '帮我把下一篇未建草稿的文章建成掘金草稿（草稿=已发，同公众号口径；建完未发清单会自动把它标为已发并缩短队列）。', 'publish-dispatch'],
  ['tool:sf-pw-publish', 'sf-pw-publish', '帮我把下一篇未发布的文章发布到思否（用 Playwright 真浏览器）。', 'publish-dispatch'],
  ['tool:article-write', 'article-write', '帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。', 'article-write'],
]

test('the seven card prompts that regressed stay on their intended task', () => {
  const src = fs.readFileSync(EXAMPLES, 'utf8')
  for (const [cardId, tool, prompt, want] of PINNED) {
    assert.ok(src.includes(prompt), `examples.ts no longer contains the ${cardId} card prompt — update this gate`)
    assert.equal(matched(prompt), want, `${cardId} mis-routed`)
    assert.ok(allows(want, tool), `${want} must whitelist ${tool}`)
  }
})

test('negative intents must not be captured by the publish tasks', () => {
  const negatives = [
    ['写评论', '帮我在这篇掘金文章下写条评论', 'tech-comment-draft'],
    ['评论2', '这篇思否文章怎么评论', 'tech-comment-draft'],
    ['WP 清单', '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。', 'article-write'],
  ]
  for (const [label, p, want] of negatives) assert.equal(matched(p), want, label)
})

test('the two internal queue souls no longer produce generic skill cards', () => {
  const src = fs.readFileSync(EXAMPLES, 'utf8')
  assert.match(src, /INTERNAL_QUEUE_SOULS/)
  for (const id of ['publish-dispatch', 'publish-inventory']) {
    assert.match(src, new RegExp(`'${id}'`), `${id} must stay in the filter set`)
  }
})
