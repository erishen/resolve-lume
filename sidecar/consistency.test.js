'use strict'
// Regression tests for the four-way tool-chain consistency guard.
// Pure Node, no running services. Run with `make check` / `make test-gateway`.
const assert = require('node:assert/strict')
const { computeDrift, readToolChain, checkToolChain } = require('./consistency')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${name}: ${err.message}`)
  }
}

// A minimal, fully consistent fixture (computeDrift is pure).
const base = () => ({
  schemaNames: ['echo', 'capabilities', 'article-write', 'shell'],
  allow: ['echo', 'capabilities', 'article-write'],
  bridge: ['echo', 'capabilities', 'article-write'],
  implemented: ['echo', 'capabilities', 'article-write', 'shell'],
})

test('consistent chain produces no problems', () => {
  assert.deepStrictEqual(computeDrift(base()), [])
})

test('detects DEFAULT_ALLOW referencing a missing schema', () => {
  const x = base()
  x.allow.push('ghost')
  x.bridge.push('ghost')
  x.implemented.push('ghost')
  assert.ok(computeDrift(x).some((p) => /schema 里不存在/.test(p) && /ghost/.test(p)))
})

test('detects a stale generated bridge (the exact 11-04 failure mode)', () => {
  const x = base()
  x.bridge = x.bridge.filter((n) => n !== 'article-write')
  assert.ok(computeDrift(x).some((p) => /生成物与 DEFAULT_ALLOW 不一致/.test(p) && /make tools-lume/.test(p)))
})

test('detects an exposed tool with no real implementation', () => {
  const x = base()
  x.implemented = x.implemented.filter((n) => n !== 'echo')
  assert.ok(computeDrift(x).some((p) => /没有真实实现/.test(p) && /echo/.test(p)))
})

test('detects schema/implementation drift in both directions', () => {
  const a = base()
  a.schemaNames = a.schemaNames.filter((n) => n !== 'shell')
  assert.ok(computeDrift(a).some((p) => /有实现但没有 schema/.test(p)))
  const b = base()
  b.schemaNames.push('placeholder')
  assert.ok(computeDrift(b).some((p) => /有 schema 但没有实现/.test(p)))
})

test('detects duplicates and a missing capabilities escape hatch', () => {
  const d = base()
  d.allow.push('echo')
  assert.ok(computeDrift(d).some((p) => /重复工具名/.test(p)))
  const c = base()
  c.allow = c.allow.filter((n) => n !== 'capabilities')
  c.bridge = c.bridge.filter((n) => n !== 'capabilities')
  assert.ok(computeDrift(c).some((p) => /capabilities 必须对 Agent 开放/.test(p)))
})

test('the real checked-in chain is consistent', () => {
  const r = checkToolChain()
  assert.deepStrictEqual(r.problems, [])
  assert.strictEqual(r.ok, true)
  assert.ok(r.stats.allow >= 20 && r.stats.allow === r.stats.bridge)
  assert.strictEqual(r.stats.schema, r.stats.implemented)
})

test('article-write and capabilities really are in the generated bridge', () => {
  const disk = readToolChain()
  for (const n of ['article-write', 'capabilities']) {
    assert.ok(disk.allow.includes(n), `${n} missing from DEFAULT_ALLOW`)
    assert.ok(disk.bridge.includes(n), `${n} missing from sidecar_ro.lume (run make tools-lume)`)
  }
})

console.log(`\nconsistency: ${passed}/${passed + failed} passed`)
if (failed) process.exit(1)
