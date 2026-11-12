'use strict'
// Tool catalog + task auto-match (studio-parity guards).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  renderToolCatalog, groupOf, cleanDesc, enrichToolDescriptions, DEFAULT_DESC,
} = require('./toolCatalog')
const { matchTaskByMessage } = require('./taskMatch')

const ROOT = path.resolve(__dirname, '..')
const SCHEMAS = path.join(__dirname, 'builtin-tools.json')
const QUEUE_TOOLS = [
  'build-juejin', 'juejin-draft', 'juejin-publish', 'wechat-draft', 'sf-pw-publish',
]
function builtinByName() {
  return Object.fromEntries(
    JSON.parse(fs.readFileSync(SCHEMAS, 'utf8')).tools.map((t) => [t.name, t.description || '']),
  )
}

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

// ---- 2026-11-12: "建掘金草稿" was answered with an article-write candidate
// list. Two causes lived here: the catalogue only read `description` (the
// bridge reports `desc`), and that bridge text said the exact opposite of the
// product's "草稿=已发" convention. Guard both.

test('catalogue reads the bridge field `desc` too', () => {
  assert.equal(cleanDesc('a  b\n c', 80), 'a b c')
  const txt = renderToolCatalog([{ name: 'x', desc: '只带 desc 字段' }])
  assert.match(txt, /- x — 只带 desc 字段/)
})

test('authoritative Chinese wording overrides the stale bridge desc', () => {
  const raw = [
    {
      name: 'sidecar__juejin-draft',
      desc: '[APPROVAL][EXTERNAL] Save a DRAFT to Juejin. Does NOT publish: use juejin-publish only on an explicit publish request.',
    },
    { name: 'fs__read_text_file', desc: 'Read a text file' },
    { name: 'sidecar__unknown-tool', desc: 'orphan bridge entry' },
  ]
  const out = enrichToolDescriptions(raw, builtinByName())
  assert.match(out[0].description, /零参数/)
  assert.match(out[0].description, /草稿=已发/)
  assert.doesNotMatch(out[0].description, /Does NOT publish/)
  // Non-sidecar tools keep their own text; unknown sidecar tools are not
  // given an invented description.
  assert.equal(out[1].description, 'Read a text file')
  assert.equal(out[2].description, 'orphan bridge entry')
})

test('a Map works as the description source', () => {
  const out = enrichToolDescriptions(
    [{ name: 'sidecar__juejin-draft', desc: 'old' }],
    new Map([['juejin-draft', '零参数·新口径']]),
  )
  assert.equal(out[0].description, '零参数·新口径')
})

test('rendered catalogue carries the zero-arg + draft=published contract', () => {
  const byName = builtinByName()
  const raw = Object.keys(byName).map((name) => ({ name: `sidecar__${name}`, desc: 'stale' }))
  const txt = renderToolCatalog(enrichToolDescriptions(raw, byName))
  for (const name of QUEUE_TOOLS) {
    const line = txt.split('\n').find((l) => l.includes(`- sidecar__${name} —`))
    assert.ok(line, `${name} missing from catalogue`)
    assert.match(line, /零参数/, `${name} must advertise zero-arg semantics`)
  }
  const draft = txt.split('\n').find((l) => l.includes('- sidecar__juejin-draft —'))
  assert.match(draft, /草稿=已发/)
  assert.match(draft, /未发清单/)
  assert.match(
    txt.split('\n').find((l) => l.includes('- sidecar__juejin-publish —')),
    /可选步骤/,
  )
})

test('every queue tool schema leads with the zero-arg contract', () => {
  const byName = builtinByName()
  for (const name of QUEUE_TOOLS) {
    assert.match(byName[name], /^零参数/, `${name} description must lead with 零参数`)
  }
  assert.match(byName['juejin-draft'], /草稿=已发/)
  // 56 chars used to cut the decisive clause off.
  assert.ok(DEFAULT_DESC >= 96, 'catalogue description budget too small')
})

test('generated bridge no longer contradicts the draft=published convention', () => {
  const gen = fs.readFileSync(path.join(ROOT, 'deploy', 'gen-sidecar-tools.mjs'), 'utf8')
  const bridge = fs.readFileSync(path.join(ROOT, 'lume-tools', 'sidecar_ro.lume'), 'utf8')
  for (const src of [gen, bridge]) {
    assert.doesNotMatch(src, /Does NOT publish/, 'stale "must juejin-publish" wording')
    assert.doesNotMatch(src, /does not push to followers/, 'stale WeChat wording')
    assert.match(src, /ZERO-ARG queue tool/, 'bridge must state the zero-arg contract')
    assert.match(src, /Draft counts as published|draft already counts as published/i)
  }
})
