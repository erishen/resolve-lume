'use strict'
// Regression for the 2026-11-12 incident: the "建掘金草稿" example card was
// auto-matched to the article-write soul (triggers 含「文章」「草稿」), whose
// SKILL says "if no project was named, list candidates and ask the user to
// pick one". The agent therefore called article-write({}) and replied with six
// project names instead of building the draft. The sibling "掘金草稿上线" card
// landed on tech-comment-draft, whose allow-list has no publish tools at all,
// so the model spent 6 rounds hunting for a Makefile with read-file.
//
// These assertions pin the routing AND the allow-list together: fixing only
// one of them still leaves the model unable to call the queue tools.
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SOULS_DIR = path.join(ROOT, 'souls')
const PSE_ROLES = new Set(['planner', 'specialist', 'evaluator'])
const { matchTaskByMessage, isContinuation, ordinalOf, resolveChatTask } = require('./taskMatch')

const cases = []
function test(name, fn) { cases.push([name, fn]) }

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return data
}

// Mirror server.js buildTasks(): one task per soul dir with frontmatter,
// PSE role dirs skipped. Reading from disk keeps this in sync with the real
// matcher input instead of a hand-written fixture that can drift.
function tasks() {
  return fs.readdirSync(SOULS_DIR)
    .filter((id) => !PSE_ROLES.has(id))
    .map((id) => [id, path.join(SOULS_DIR, id, 'SOUL.md')])
    .filter(([, f]) => fs.existsSync(f))
    .map(([id, f]) => ({ id, triggers: (frontmatter(f) || {}).triggers || '' }))
}

function matched(message) {
  const t = matchTaskByMessage(message, tasks())
  return t ? t.id : null
}

const QUEUE_CARDS = [
  '帮我把下一篇未建草稿的文章建成掘金草稿（草稿=已发，同公众号口径；建完未发清单会自动把它标为已发并缩短队列）。',
  '草稿=已发后一般不必做；若要显式把已建草稿点上线（make juejin-publish），帮我对已建草稿的下一篇执行。',
  '帮我把下一篇未建草稿的文章建成微信公众号草稿箱草稿（建进草稿箱即视为已群发；建完未发清单会自动把它标为已群发并缩短队列）。',
  '帮我把下一篇未发布的文章发布到思否（用 Playwright 真浏览器）。',
  '帮我把下一篇未建草稿的文章建成掘金草稿',
]

test('every queue-driven publish card lands on publish-dispatch', () => {
  for (const prompt of QUEUE_CARDS) {
    assert.equal(matched(prompt), 'publish-dispatch', `mis-routed: ${prompt.slice(0, 30)}`)
  }
})

test('writing / commenting / WordPress publishing keep their own souls', () => {
  // A high-scoring new soul must not swallow neighbouring article intents.
  assert.equal(matched('帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。'), 'article-write')
  assert.equal(matched('帮我在这篇掘金文章下写条评论'), 'tech-comment-draft')
  assert.equal(
    matched('请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。'),
    'article-write',
  )
})

test('publish-dispatch pins only the five queue tools and no wandering inviter', () => {
  const fm = frontmatter(path.join(SOULS_DIR, 'publish-dispatch', 'SOUL.md'))
  assert.ok(fm, 'souls/publish-dispatch/SOUL.md is missing')
  const tools = (fm.tools || '').split(',').map((s) => s.trim()).filter(Boolean)
  // The five zero-arg queue tools only.
  for (const n of [
    'sidecar__build-juejin', 'sidecar__juejin-draft', 'sidecar__juejin-publish',
    'sidecar__wechat-draft', 'sidecar__sf-pw-publish',
  ]) assert.ok(tools.includes(n), `publish-dispatch must pin ${n}`)
  // `capabilities` used to be pinned and the model then probed it on every
  // round, spawning extra ReAct loops. It must stay out of the whitelist.
  assert.ok(!tools.includes('sidecar__capabilities'), 'publish-dispatch must NOT pin sidecar__capabilities')
  // These are what let the old failures happen: picking a project, or hunting
  // for a Makefile with the file/shell tools.
  for (const n of [
    'sidecar__article-write', 'sidecar__read-file', 'sidecar__shell',
    'sidecar__make', 'sidecar__write-file',
  ]) assert.ok(!tools.includes(n), `publish-dispatch must NOT pin ${n}`)
})

test('publish-dispatch soul states the zero-arg / draft=published contract', () => {
  const body = fs.readFileSync(path.join(SOULS_DIR, 'publish-dispatch', 'SOUL.md'), 'utf8')
  assert.match(body, /零参数/)
  assert.match(body, /草稿=已发/)
  assert.match(body, /不要问用户选哪篇文章/)
  assert.match(body, /严禁用 `read-file`/)
  assert.match(body, /不要自动追加调用 `juejin-publish`/)
})

const PENDING_CARDS = [
  '帮我列出掘金、思否、公众号、英文稿各平台还有哪些文章没发出去，以及每个下一步该做什么。',
  '帮我看一下各平台未发清单',
  'publish-pending 一下，看看哪些文章还没发',
  '还有哪些文章没发？下一步该做什么',
]

test('every pending-list card lands on publish-inventory (card had no tool before)', () => {
  for (const prompt of PENDING_CARDS) {
    assert.equal(matched(prompt), 'publish-inventory', `mis-routed: ${prompt.slice(0, 36)}`)
  }
})

test('queue/execute cards still land on publish-dispatch, not the read-only soul', () => {
  for (const prompt of QUEUE_CARDS) {
    assert.equal(matched(prompt), 'publish-dispatch', `mis-routed: ${prompt.slice(0, 36)}`)
  }
})

test('list-query triggers do not steal writing / WP-list intents', () => {
  assert.equal(matched('帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。'), 'article-write')
  assert.equal(
    matched('请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。'),
    'article-write',
  )
})

test('publish-inventory exposes ONLY read-only tools (query cannot execute)', () => {
  // On 2026-11-12 the inventory card shared a soul with the queue tools; the
  // model saw juejin-draft, called it, and only the human approval gate stopped
  // a real draft from being created on a pure query. Split the allow-list.
  for (const id of ['publish-inventory', 'publish-dispatch']) {
    const fm = frontmatter(path.join(SOULS_DIR, id, 'SOUL.md'))
    assert.ok(fm && fm.tools, `${id} is missing its tools line`)
  }
  const inv = frontmatter(path.join(SOULS_DIR, 'publish-inventory', 'SOUL.md'))
  const invTools = inv.tools.split(',').map((s) => s.trim()).filter(Boolean)
  assert.ok(invTools.includes('sidecar__publish-pending'))
  for (const n of [
    'sidecar__juejin-draft', 'sidecar__juejin-publish', 'sidecar__wechat-draft',
    'sidecar__sf-pw-publish', 'sidecar__build-juejin', 'sidecar__article-write',
    'sidecar__shell', 'sidecar__make', 'sidecar__read-file',
  ]) assert.ok(!invTools.includes(n), `inventory must NOT expose ${n}`)

  const dispatch = frontmatter(path.join(SOULS_DIR, 'publish-dispatch', 'SOUL.md'))
  const dispatchTools = dispatch.tools.split(',').map((s) => s.trim()).filter(Boolean)
  assert.ok(dispatchTools.includes('sidecar__juejin-draft'))
  assert.ok(!dispatchTools.includes('sidecar__publish-pending'), 'execute soul stays execute-only')

  for (const f of ['SOUL.md', 'SKILL.md']) {
    const body = fs.readFileSync(path.join(SOULS_DIR, 'publish-inventory', f), 'utf8')
    assert.match(body, /没有任何写工具/)
    assert.match(body, /不是让你执行的授权/)
    assert.match(body, /严禁在最终答案里复述工具调用行/)
  }
})

// 2026-11-15 incident: after a numbered project list, the user replied "6" and
// the run lost its task (no trigger keyword), so article-write's soul and tool
// allow-list were dropped and the model re-ran article-discover instead of
// writing the picked project. Studio has the same structural gap
// (TasksService.resolve only inspects the latest message); the extra rule here
// keeps the session's task for a pure pick, and nothing else.
const REGISTRY = [
  { id: 'general', triggers: '' },
  { id: 'article-write', triggers: '文章,写作,技术文章,稿子' },
  { id: 'code-review', triggers: '审查代码,代码审查' },
]

test('isContinuation accepts pure picks, not ordinary sentences', () => {
  for (const m of ['6', ' 6 ', '第 6 个', '选6吧', '我写 6', '6号', '就它', '就这个吧', '3。']) {
    assert.equal(isContinuation(m), true, `should be a continuation: ${JSON.stringify(m)}`)
  }
  for (const m of ['帮我写一篇技术文章', '6 篇文章都要', 'lume-qt', '2026', '这个怎么样', '']) {
    assert.equal(isContinuation(m), false, `should NOT be a continuation: ${JSON.stringify(m)}`)
  }
  assert.equal(ordinalOf('第 6 个'), 6)
  assert.equal(ordinalOf('6号'), 6)
  assert.equal(ordinalOf('就它'), undefined)
})

test('forced taskId beats intent matching and continuation', () => {
  const r = resolveChatTask({
    taskId: 'code-review',
    messages: [{ role: 'user', content: '帮我写一篇技术文章' }],
    tasks: REGISTRY,
    lastTaskId: 'article-write',
  })
  assert.equal(r.source, 'explicit')
  assert.equal(r.task.id, 'code-review')
})

test('a bare ordinal keeps the session previous task', () => {
  const r = resolveChatTask({
    messages: [{ role: 'user', content: '6' }],
    tasks: REGISTRY,
    lastTaskId: 'article-write',
  })
  assert.equal(r.source, 'continuation')
  assert.equal(r.task.id, 'article-write')
})

test('no previous task means no continuation guess', () => {
  const r = resolveChatTask({ messages: [{ role: 'user', content: '6' }], tasks: REGISTRY })
  assert.equal(r.source, 'none')
  assert.equal(r.task, undefined)
})

test('ordinary prose still auto-matches and never inherits the session task', () => {
  const auto = resolveChatTask({
    messages: [{ role: 'user', content: '帮我审查代码' }],
    tasks: REGISTRY,
    lastTaskId: 'article-write',
  })
  assert.equal(auto.source, 'auto')
  assert.equal(auto.task.id, 'code-review')

  const none = resolveChatTask({
    messages: [{ role: 'user', content: '这个怎么样，可以吗' }],
    tasks: REGISTRY,
    lastTaskId: 'article-write',
  })
  assert.equal(none.source, 'none')
  assert.equal(none.task, undefined)
})

test('real souls: "6" alone matches nothing, but keeps the article-write session task', () => {
  // The gap itself: no soul trigger fires on a bare ordinal.
  assert.equal(matched('6'), null)
  const r = resolveChatTask({
    messages: [{ role: 'user', content: '6' }],
    tasks: tasks(),
    lastTaskId: 'article-write',
  })
  assert.equal(r.source, 'continuation')
  assert.equal(r.task.id, 'article-write')
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
