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

// 2026-11-12 (later): publish-wechat.mjs exits 1 on a WeChat API error
// (errcode=45003, title too long) via console.error + process.exit, with no
// `error:` prefix and without throwing. The make runner resolves and the result
// only carries a literal "[exit code: 1]" marker, so the guard must detect that
// and refuse the byte-identical retry — otherwise the model re-issues
// wechat-draft({}) on the next round.
test('a non-zero exit-code marker is a terminal failure without a tool error: prefix', () => {
  G._reset()
  const args = {}
  const raw =
    '$ make -C wordpress-tools wechat-draft\n' +
    '❌ 建草稿失败 errcode=45003 errmsg=标题长度超出限制\n' +
    '[exit code: 1]'
  assert.equal(G.check('wechat-draft', args), null)
  G.record('wechat-draft', args, { result: raw })
  const refusal = G.check('wechat-draft', args)
  assert.match(refusal, /拒绝重复执行/)
  assert.match(refusal, /请勿用相同参数重试/)
  assert.match(refusal, /45003/)
})

test('a zero exit code marker is NOT treated as a failure', () => {
  G._reset()
  G.record('shell', { command: 'true' }, { result: 'ok\n[exit code: 0]' })
  assert.equal(G.check('shell', { command: 'true' }), null)
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

// 2026-11-12: an empty publishing queue is a SUCCESS, so the old failure-only
// guard let the model re-run juejin-draft({}) four times and ask about --force.
test('an empty queue result makes the identical retry terminal', () => {
  G._reset()
  const empty = { result: '> [QUEUE_EMPTY] 掘金草稿 完成：队列为空，本轮没有可处理的文章。' }
  assert.equal(G.check('juejin-draft', {}), null)
  G.record('juejin-draft', {}, empty)
  const refusal = G.check('juejin-draft', {})
  assert.match(refusal, /队列为空/)
  assert.match(refusal, /不要加 --force/)
  assert.match(refusal, /结束本轮/)
})

test('a real draft creation stays repeatable (user may ask for several)', () => {
  G._reset()
  G.record('juejin-draft', {}, { result: '> 掘金草稿 完成\n  ✅ 草稿 draft_id = 123' })
  assert.equal(G.check('juejin-draft', {}), null)
})

test('a fresh success clears the empty-queue refusal', () => {
  G._reset()
  G.record('juejin-draft', {}, { result: '> [QUEUE_EMPTY] 队列为空' })
  assert.ok(G.check('juejin-draft', {}))
  G.record('juejin-draft', {}, { result: '> 掘金草稿 完成\n  ✅ 草稿 draft_id = 456' })
  assert.equal(G.check('juejin-draft', {}), null)
})

test('the empty-queue marker only affects the five queue tools', () => {
  G._reset()
  G.record('echo', {}, { result: '> [QUEUE_EMPTY] quoted for documentation' })
  assert.equal(G.check('echo', {}), null)
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
