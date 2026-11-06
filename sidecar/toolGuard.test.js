'use strict'
// Regression tests for the "identical failed tool call" guard and the shared
// PSE --provider whitelist. Both target the 2026-11-06 run that burned 8 rounds
// on article-write -> hot-news x4 (provider="llamaindex-pse", always failing).
// Run with `make check`. Zero external dependencies.
const assert = require('node:assert/strict')
const G = require('./toolGuard')
const H = require('./business-helpers')

const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

test('signature is stable under object key order', () => {
  assert.equal(
    G.signature('hot-news', { topic: 'x', platform: 'xiaohongshu' }),
    G.signature('hot-news', { platform: 'xiaohongshu', topic: 'x' }),
  )
  assert.notEqual(
    G.signature('hot-news', { topic: 'x' }),
    G.signature('hot-news', { topic: 'y' }),
  )
})

test('identical call that just failed is refused with the previous reason', () => {
  G._reset()
  const args = { topic: 'x', provider: 'llamaindex-pse' }
  assert.equal(G.check('hot-news', args), null)
  G.record('hot-news', args, { result: 'tool error: provider 不存在' })
  const refusal = G.check('hot-news', args)
  assert.match(refusal, /拒绝重复执行/)
  assert.match(refusal, /provider 不存在/)
  assert.match(refusal, /请勿用相同参数重试/)
})

test('normalizeToolError prefix counts as a failure', () => {
  G._reset()
  const args = { project: 'resolve-lume' }
  G.record('article-write', args, { result: 'tool error: 未生成可发布文章' })
  assert.ok(G.check('article-write', args))
})

test('successful calls are never refused (explicit re-run stays possible)', () => {
  G._reset()
  const args = { add: false }
  G.record('article-discover', args, { result: '> 7 个可写项目' })
  assert.equal(G.check('article-discover', args), null)
})

test('a changed argument is not a repeat', () => {
  G._reset()
  G.record('hot-news', { topic: 'x', provider: 'bad' }, { error: 'boom' })
  assert.equal(G.check('hot-news', { topic: 'x', provider: 'free' }), null)
})

test('runPseTask rejects a framework name used as provider before spawning', async () => {
  const r = await H.runPseTask({
    tool: 'hot-news',
    framework: 'llamaindex',
    task: 'hot-news',
    args: ['--topic=x', '--provider=llamaindex-pse'],
    taskDir: '/definitely/not/a/real/dir',
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /不支持 provider="llamaindex-pse"/)
  assert.match(r.error, /free \/ deepseek/)
})

test('runPseTask accepts free / deepseek provider values', async () => {
  for (const p of ['free', 'deepseek', 'DEEPSEEK']) {
    const r = await H.runPseTask({
      tool: 'hot-news',
      framework: 'llamaindex',
      task: 'hot-news',
      args: [`--provider=${p}`],
      taskDir: '/definitely/not/a/real/dir',
    })
    assert.equal(r.ok, false)
    assert.doesNotMatch(r.error, /不支持 provider/)
  }
})

;(async () => {
  let failed = 0
  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`PASS  ${name}`)
    } catch (e) {
      failed++
      console.log(`FAIL  ${name}\n      ${e.message}`)
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`)
  process.exit(failed ? 1 : 0)
})()
