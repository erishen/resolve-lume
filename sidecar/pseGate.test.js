'use strict'
// The builtin pse-review used to honour provider="deepseek" without checking
// autogen-pse's PSE_ALLOW_PAID switch, so a task prompt could spend real money
// silently. This pins the switch parsing.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { __pseAllowPaid: pseAllowPaid } = require('./business-pse')

function tmpEnv(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-gate-'))
  fs.writeFileSync(path.join(dir, '.env'), body)
  return dir
}

test('unset / empty switch keeps the paid route closed', async () => {
  assert.equal(await pseAllowPaid(tmpEnv('PSE_ALLOW_PAID=\n')), false)
  assert.equal(await pseAllowPaid(tmpEnv('OPENAI_API_KEY=x\n')), false)
  assert.equal(await pseAllowPaid(path.join(os.tmpdir(), 'does-not-exist-pse')), false)
})

test('explicit 1 opens it, with quotes or spaces tolerated', async () => {
  assert.equal(await pseAllowPaid(tmpEnv('PSE_ALLOW_PAID=1\n')), true)
  assert.equal(await pseAllowPaid(tmpEnv('PSE_ALLOW_PAID = "1"\n')), true)
  assert.equal(await pseAllowPaid(tmpEnv('PSE_ALLOW_PAID=\'true\'\n')), true)
})

test('comments and other values do not open it', async () => {
  assert.equal(await pseAllowPaid(tmpEnv('# PSE_ALLOW_PAID=1\n')), false)
  assert.equal(await pseAllowPaid(tmpEnv('PSE_ALLOW_PAID=0\n')), false)
})
