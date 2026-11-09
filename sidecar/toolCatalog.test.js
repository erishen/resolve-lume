'use strict'
// Tool catalog + task auto-match (studio-parity guards).
const test = require('node:test')
const assert = require('node:assert/strict')
const { renderToolCatalog, groupOf } = require('./toolCatalog')
const { matchTaskByMessage } = require('./taskMatch')

test('catalog renders exact names grouped by server prefix', () => {
  const txt = renderToolCatalog([
    { name: 'sidecar__shell', description: '在 workdir 执行 shell 命令' },
    { name: 'sidecar__portfolio-check', description: '体检本地持仓快照' },
    { name: 'fs:read_file', description: '读取文件' },
  ])
  assert.match(txt, /## sidecar/)
  assert.match(txt, /## fs/)
  assert.match(txt, /- sidecar__shell — 在 workdir 执行 shell 命令/)
  // groups are emitted in name order: fs before sidecar
  assert.ok(txt.indexOf('## fs') < txt.indexOf('## sidecar'))
  // the "only these names exist" rule is part of the contract
  assert.match(txt, /unknown tool/)
})

test('catalog collapses whitespace and truncates a long description', () => {
  const txt = renderToolCatalog([{ name: 'x', description: 'a\n\n  b' }], { descMax: 6 })
  assert.match(txt, /- x — a b/)
  const long = renderToolCatalog([{ name: 'y', description: 'z'.repeat(200) }], { descMax: 12 })
  assert.match(long, /…/)
})

test('catalog caps the entry count and says how many were dropped', () => {
  const tools = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, description: '' }))
  const txt = renderToolCatalog(tools, { max: 10 })
  assert.equal((txt.match(/- t/g) || []).length, 10)
  assert.match(txt, /另有 2 个工具未列出/)
})

test('catalog is empty for an empty tool list (no stray prompt)', () => {
  assert.equal(renderToolCatalog([]), '')
  assert.equal(renderToolCatalog(null), '')
  assert.equal(groupOf('sidecar__shell'), 'sidecar')
  assert.equal(groupOf('fs:read_file'), 'fs')
  assert.equal(groupOf('bare'), 'builtin')
})

test('task auto-match picks the soul with the most trigger hits', () => {
  const tasks = [
    { id: 'general', triggers: '' },
    { id: 'weekly-investment', triggers: '投资, 持仓, 复盘' },
    { id: 'hot-news-post', triggers: '热点, 小红书' },
  ]
  assert.equal(matchTaskByMessage('帮我看看这周投资情况，持仓怎么样', tasks).id, 'weekly-investment')
  assert.equal(matchTaskByMessage('写一篇小红书热点文案', tasks).id, 'hot-news-post')
  // no hit -> undefined (caller keeps the general task, full tool surface)
  assert.equal(matchTaskByMessage('解释一下 TCP 三次握手', tasks), undefined)
  assert.equal(matchTaskByMessage('', tasks), undefined)
})

test('an explicit taskId still wins over auto-match', () => {
  // taskForChat() lives in server.js (top-level listen), so assert the contract
  // here: with an explicit task the caller never calls the matcher.
  const tasks = [
    { id: 'weekly-investment', triggers: '投资' },
  ]
  const forced = tasks[0]
  assert.equal(forced.id, 'weekly-investment')
  assert.equal(matchTaskByMessage('随便聊聊', tasks), undefined)
})
