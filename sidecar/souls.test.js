'use strict'
// Guardrail for the per-task tool lists: a soul that pins tools the backend
// never registers narrows the model to nothing (the chat body's "tools" array
// only exposes exact registry matches). These assertions catch typos at test
// time instead of in a live chat.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOULS_DIR = path.join(__dirname, '..', 'souls')
const BUILTIN = new Set(
  require('./builtin-tools.json').tools.map((t) => `sidecar__${t.name}`),
)
// MCP bridges registered by agent-httpd: <serverId>__<tool>. Keep this to the
// servers resolve-lume actually mounts.
const MCP_NAME = /^(fs|fetch|git|memory|think)__[A-Za-z0-9_]+$/

function frontmatter(file) {
  const txt = fs.readFileSync(file, 'utf8')
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return data
}

function souls() {
  return fs
    .readdirSync(SOULS_DIR)
    .map((id) => [id, path.join(SOULS_DIR, id, 'SOUL.md')])
    .filter(([, f]) => fs.existsSync(f))
    .map(([id, f]) => [id, frontmatter(f)])
    .filter(([, fm]) => fm)
}

test('ported studio tasks exist and declare tools', () => {
  const want = {
    devstats: 'sidecar__dev-stats',
    foundation: 'sidecar__analyze-dir',
    privacy: 'sidecar__privacy-audit',
    documents: 'sidecar__doc-library-search',
    recruiting: 'sidecar__resume-tailor',
    web: 'sidecar__browser-open',
    'deep-review': 'sidecar__pse-review',
  }
  const byId = new Map(souls())
  for (const [id, tool] of Object.entries(want)) {
    const fm = byId.get(id)
    assert.ok(fm, `souls/${id}/SOUL.md is missing`)
    assert.ok(fm.tools && fm.tools.includes(tool), `${id} should pin ${tool}`)
    assert.match(fm.name, /[\u4e00-\u9fa5]/, `${id} name should be Chinese`)
    assert.ok(fm.triggers && fm.triggers.length > 10, `${id} needs triggers for auto-match`)
  }
})

test('every pinned tool name is a real registry name', () => {
  for (const [id, fm] of souls()) {
    if (!fm.tools) continue
    const names = fm.tools.split(',').map((s) => s.trim()).filter(Boolean)
    assert.ok(names.length <= 32, `${id} pins ${names.length} tools, cap is 32`)
    assert.strictEqual(new Set(names).size, names.length, `${id} has duplicate tool names`)
    for (const n of names) {
      assert.ok(n.length <= 64, `${id}: ${n} is longer than 64 bytes`)
      const known = BUILTIN.has(n) || MCP_NAME.test(n)
      assert.ok(known, `${id} pins unknown tool "${n}"`)
    }
  }
})

test('souls without a tool list stay open (all tools), as before', () => {
  const byId = new Map(souls())
  for (const id of ['article-write', 'hot-news-post', 'weekly-investment']) {
    const fm = byId.get(id)
    assert.ok(fm, `${id} missing`)
    assert.ok(!fm.tools, `${id} should not pin tools yet`)
  }
})
