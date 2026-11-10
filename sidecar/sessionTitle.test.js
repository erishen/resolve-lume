'use strict'
// Session-title regression tests. The left rail shows this string, so it has to
// stay short and meaningful: the task's display name when the conversation is
// pinned to a task (or matches one on its opening message), otherwise a
// one-line slice. Derived server-side so old rows and new rows agree.
const assert = require('node:assert/strict')
const { sessionTitle, SESSION_TITLE_MAX } = require('./sessionTitle')

const tasks = [
  { id: 'weekly-investment', name: '投资分析', triggers: '投资,组合,调仓' },
  { id: 'article-write', name: '技术文章写作与发布', triggers: '文章,写作' },
]

const longPrompt = '帮我做一份深度投资组合分析，用 autogen-pse 的 PSE 三角色流水线'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`      ${err.message}`)
  }
}

test('pinned task wins, resolved from the catalog', () => {
  const rec = { taskMode: 'weekly-investment', title: longPrompt, messages: [{ role: 'user', content: longPrompt }] }
  assert.equal(sessionTitle(rec, tasks), '投资分析')
})

test('pinned task not in the live catalog still gets its studio copy', () => {
  const rec = { taskMode: 'article-write', title: '随便聊聊', messages: [{ role: 'user', content: '随便聊聊' }] }
  assert.equal(sessionTitle(rec, tasks), '技术文章写作与发布')
})

test('auto mode: the matched task name beats the raw prompt', () => {
  const rec = { taskMode: 'auto', title: longPrompt, messages: [{ role: 'user', content: longPrompt }] }
  assert.equal(sessionTitle(rec, tasks), '投资分析')
})

test('auto mode without a task hit: short one-line slice, whitespace collapsed', () => {
  const rec = {
    taskMode: 'auto',
    title: 'ignored',
    messages: [{ role: 'user', content: '帮我看一下\n  这个仓库的  目录结构' }],
  }
  assert.equal(sessionTitle(rec, tasks), '帮我看一下 这个仓库的 目录结构')
})

test('a long non-task prompt is cut to the cap with an ellipsis', () => {
  const text = '一'.repeat(SESSION_TITLE_MAX + 10)
  const rec = { taskMode: 'auto', title: text, messages: [{ role: 'user', content: text }] }
  const got = sessionTitle(rec, tasks)
  assert.equal(got.length, SESSION_TITLE_MAX + 1)
  assert.equal(got, `${text.slice(0, SESSION_TITLE_MAX)}…`)
})

test('a pinned id nobody can resolve falls back to the prompt, not the slug', () => {
  const rec = { taskMode: 'ghost-task', title: '看看这个项目', messages: [{ role: 'user', content: '看看这个项目' }] }
  assert.equal(sessionTitle(rec, tasks), '看看这个项目')
})

test('stored title is the fallback when messages were never saved', () => {
  const rec = { taskMode: 'auto', title: '帮我审计一下当前 repo 有没有隐私泄露', messages: [] }
  assert.equal(sessionTitle(rec, tasks), '帮我审计一下当前 repo 有没有隐私泄…')
})

test('nothing to show stays Untitled', () => {
  assert.equal(sessionTitle({ taskMode: 'auto', title: '', messages: [] }, tasks), 'Untitled')
  assert.equal(sessionTitle({ messages: [{ role: 'assistant', content: '好' }] }, tasks), 'Untitled')
})

// A session that archived an article used to read "技术文章写作与发布" (the soul the
// opening message matches), which says nothing about what actually happened. The
// tool calls are recorded on the assistant messages, so derive from them instead.
const archiveMessages = [
  { role: 'user', content: '帮我归档一篇文章，重建各平台副本并更新关键词索引。' },
  {
    role: 'assistant',
    content: '要归档哪一篇？',
    toolCalls: [{ name: 'article-archive', arguments: { confirm: true } }],
  },
  { role: 'user', content: '7' },
  {
    role: 'assistant',
    content: '已归档 resolve-lume',
    toolCalls: [{ name: 'article-archive', arguments: { project: '7', confirm: true } }],
  },
]

test('the tool that actually ran names the session, not the broad task', () => {
  const rec = { taskMode: 'auto', title: '帮我归档一篇文章', messages: archiveMessages }
  assert.equal(sessionTitle(rec, tasks), '归档文章')
})

test('article-write alone reads as 撰写文章 instead of the soul title', () => {
  const rec = {
    taskMode: 'auto',
    title: '帮我写一篇关于 Lume 的文章',
    messages: [
      { role: 'user', content: '帮我写一篇关于 Lume 的文章' },
      { role: 'assistant', content: '好', toolCalls: [{ name: 'article-write', arguments: { project: 'resolve-lume' } }] },
    ],
  }
  assert.equal(sessionTitle(rec, tasks), '撰写文章 · resolve-lume')
})

test('a positional number from the call never becomes the subject', () => {
  const rec = {
    taskMode: 'auto',
    title: '帮我归档一篇文章',
    messages: [
      {
        role: 'assistant',
        content: '已归档',
        toolCalls: [{ name: 'article-archive', arguments: { project: '7', confirm: true } }],
      },
    ],
  }
  assert.equal(sessionTitle(rec, tasks), '归档文章')
})

test('the last real action wins when a session moves on to publishing', () => {
  const rec = {
    taskMode: 'auto',
    title: '帮我写并发布文章',
    messages: [
      {
        role: 'assistant',
        content: '写好了',
        toolCalls: [{ name: 'article-write', arguments: { project: 'resolve-lume' } }],
      },
      {
        role: 'assistant',
        content: '发布了',
        toolCalls: [{ name: 'article-publish', arguments: { project: 'resolve-lume' } }],
      },
    ],
  }
  assert.equal(sessionTitle(rec, tasks), '发布文章 · resolve-lume')
})

test('read-only tools do not retitle a session', () => {
  const rec = {
    taskMode: 'auto',
    title: longPrompt,
    messages: [
      { role: 'user', content: longPrompt },
      { role: 'assistant', content: '查了', toolCalls: [{ name: 'read-file', arguments: { path: '/a' } }] },
    ],
  }
  assert.equal(sessionTitle(rec, tasks), '投资分析')
})

console.log(`\ntitle: ${passed}/${passed + failed} passed`)
if (failed) process.exit(1)
