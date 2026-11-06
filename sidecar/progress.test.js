'use strict'
// Regression tests for the tool-progress bus. Run with `make check`.
//
// These protect the 2026-11-06 fix where a 15-minute article-write looked
// frozen: child stdout existed but never reached the live chat SSE stream.
const assert = require('node:assert/strict')
const P = require('./progress')
const H = require('./business-helpers')
const B = require('./builtin-exec')

const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

function fakeClock() {
  let t = 1000
  let nextId = 1
  const timers = new Map()
  return {
    opts: {
      now: () => t,
      setTimer: (fn) => {
        const id = nextId++
        timers.set(id, fn)
        return id
      },
      clearTimer: (id) => timers.delete(id),
    },
    advance: (ms) => {
      t += ms
      for (const [id, fn] of [...timers]) {
        timers.delete(id)
        fn()
      }
    },
  }
}

function fakeRes() {
  return { chunks: [], writableEnded: false, destroyed: false, write(s) { this.chunks.push(s) } }
}

// ---- 1. SSE frame shape ---------------------------------------------------
test('reasoningFrame is a valid, self-contained SSE frame', () => {
  const frame = P.reasoningFrame('hello "world"\nsecond')
  assert.match(frame, /^event: reasoning\ndata: /)
  assert.match(frame, /\n\n$/)
  const json = JSON.parse(frame.split('\n')[1].slice(5).trim())
  assert.equal(json.text, 'hello "world"\nsecond')
})

// ---- 2. active chat stream registry --------------------------------------
test('progress is injected only into the SOLE active chat stream', () => {
  const a = fakeRes()
  const idA = P.registerChatStream(a)
  try {
    assert.equal(P.activeChatStreamCount(), 1)
    assert.equal(P.broadcastToActiveChat('phase 1'), true)
    assert.deepEqual(a.chunks, [P.reasoningFrame('phase 1')])

    // Concurrent chats must NOT cross-talk: drop progress rather than guess.
    const b = fakeRes()
    const idB = P.registerChatStream(b)
    try {
      assert.equal(P.activeChatStreamCount(), 2)
      assert.equal(P.broadcastToActiveChat('phase 2'), false)
      assert.equal(a.chunks.length, 1)
      assert.equal(b.chunks.length, 0)
    } finally {
      P.unregisterChatStream(idB)
    }

    P.broadcastToActiveChat('phase 3')
    assert.equal(a.chunks.length, 2)
  } finally {
    P.unregisterChatStream(idA)
  }
  assert.equal(P.activeChatStreamCount(), 0)
  assert.equal(P.broadcastToActiveChat('orphan'), false)
})

test('user message is readable only for the sole active stream', () => {
  const a = fakeRes()
  const idA = P.registerChatStream(a, { userMessage: '7' })
  try {
    assert.equal(P.activeChatUserMessage(), '7')
    const b = fakeRes()
    const idB = P.registerChatStream(b, { userMessage: '发布' })
    try {
      // Ambiguous (concurrent chats): never guess which run authorized it.
      assert.equal(P.activeChatUserMessage(), '')
    } finally {
      P.unregisterChatStream(idB)
    }
  } finally {
    P.unregisterChatStream(idA)
  }
  assert.equal(P.activeChatUserMessage(), '')
})

test('a closed/destroyed response never receives progress', () => {
  const r = fakeRes()
  r.writableEnded = true
  const id = P.registerChatStream(r)
  try {
    assert.equal(P.broadcastToActiveChat('late'), false)
    assert.equal(r.chunks.length, 0)
  } finally {
    P.unregisterChatStream(id)
  }
})

// ---- 3. chunk normalisation ----------------------------------------------
test('interpreter warnings never become progress frames', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'article-write', {
    ...fakeClock().opts, minIntervalMs: 0,
  })
  pub.push(
    'run.py:287: DeprecationWarning: There is no current event loop\n' +
    '  asyncio.get_event_loop()\n' +
    '(node:123) ExperimentalWarning: SQLite is an experimental feature\n' +
    '✅ Phase 1 提纲完成\n',
  )
  pub.finish()
  const all = out.join('')
  assert.match(all, /✅ Phase 1/)
  assert.doesNotMatch(all, /DeprecationWarning/)
  assert.doesNotMatch(all, /get_event_loop/)
  assert.doesNotMatch(all, /ExperimentalWarning/)
})

test('publisher joins half-lines, strips ANSI and drops noise lines', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'article-write', {
    ...fakeClock().opts, minIntervalMs: 0,
  })
  pub.push('hel')
  assert.equal(out.length, 0)
  pub.push('lo\n\n\u001b[32m✅ Phase 2\u001b[0m\n-----\n')
  pub.finish()
  const all = out.join('')
  assert.match(all, /\[article-write\] hello/)
  assert.match(all, /✅ Phase 2/)
  assert.doesNotMatch(all, /\u001b/)
  assert.doesNotMatch(all, /-----/)
})

test('publisher masks credentials before they reach chat/export', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'tool', {
    ...fakeClock().opts, minIntervalMs: 0,
  })
  pub.push('OPENAI_API_KEY=sk-abcdefghijklmnopqrst\nAPI_TOKEN: 123456789\n')
  pub.finish()
  const all = out.join('')
  assert.doesNotMatch(all, /sk-abcdefghijklmnopqrst/)
  assert.doesNotMatch(all, /123456789/)
  assert.match(all, /\[redacted\]/)
})

test('publisher caps total lines and reports how many were dropped', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'tool', {
    ...fakeClock().opts, minIntervalMs: 0, maxLines: 3, maxLinesPerFrame: 20,
  })
  for (let i = 0; i < 10; i += 1) pub.push(`line${i}\n`)
  pub.finish()
  const all = out.join('')
  assert.match(all, /line0/)
  assert.match(all, /line2/)
  assert.doesNotMatch(all, /line3/)
  assert.match(all, /另有 7 行日志已省略/)
  assert.equal(pub.stats().dropped, 7)
})

test('publisher throttles bursts and flushes the tail on finish', () => {
  const clock = fakeClock()
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'tool', {
    ...clock.opts, minIntervalMs: 700,
  })
  pub.push('line1\n')
  assert.equal(out.length, 1)
  pub.push('line2\n')
  assert.equal(out.length, 1, 'burst must be throttled')
  clock.advance(700)
  assert.equal(out.length, 2)
  assert.match(out[1], /line2/)
  pub.push('line3\n')
  pub.finish()
  assert.match(out.join(''), /line3/)
  assert.equal(pub.stats().frames, 3)
})

test('a huge newline-less chunk is sliced instead of buffered forever', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'tool', {
    ...fakeClock().opts, minIntervalMs: 0, maxLineChars: 40,
  })
  pub.push('x'.repeat(200))
  pub.finish()
  assert.ok(out.length >= 1)
  assert.match(out.join(''), /x{40}/)
})

test('push after finish is a no-op', () => {
  const out = []
  const pub = P.createProgressPublisher((s) => out.push(s), 'tool', {
    ...fakeClock().opts, minIntervalMs: 0,
  })
  pub.push('before\n')
  pub.finish()
  const n = out.length
  pub.push('after\n')
  assert.equal(out.length, n)
})

// ---- 4. AsyncLocalStorage plumbing ---------------------------------------
test('currentEmit is scoped per async run and never leaks across runs', async () => {
  assert.equal(P.currentEmit(), null)
  const seenA = []
  const seenB = []
  const run = (sink, tag) => P.runWithEmit((s) => sink.push(s), async () => {
    await new Promise((r) => setImmediate(r))
    P.currentEmit()(`${tag}-1`)
    await new Promise((r) => setImmediate(r))
    P.currentEmit()(`${tag}-2`)
  })
  await Promise.all([run(seenA, 'A'), run(seenB, 'B')])
  assert.deepEqual(seenA, ['A-1', 'A-2'])
  assert.deepEqual(seenB, ['B-1', 'B-2'])
  assert.equal(P.currentEmit(), null)
})

test('spawnCapture picks up the ALS emitter with NO explicit onProgress', async () => {
  // This is the whole point of the bus: business tools stay untouched.
  const chunks = []
  const emit = (s) => chunks.push(s)
  const res = await P.runWithEmit(emit, () => H.spawnCapture({
    tool: 'progress-test',
    cwd: __dirname,
    cmdArgs: [process.execPath, '-e', 'process.stdout.write("phase A\\nphase B\\n")'],
    timeoutMs: 8000,
    maxOutput: 64 * 1024,
    env: { ...process.env },
  }))
  assert.equal(res.ok, true)
  assert.match(chunks.join(''), /phase A/)
  assert.match(chunks.join(''), /phase B/)
})

test('an explicit onProgress still wins over the ALS emitter', async () => {
  const viaAls = []
  const viaExplicit = []
  await P.runWithEmit((s) => viaAls.push(s), () => H.spawnCapture({
    tool: 'progress-test',
    cwd: __dirname,
    cmdArgs: [process.execPath, '-e', 'process.stdout.write("explicit\\n")'],
    timeoutMs: 8000,
    maxOutput: 64 * 1024,
    env: { ...process.env },
    onProgress: (s) => viaExplicit.push(s),
  }))
  assert.match(viaExplicit.join(''), /explicit/)
  assert.equal(viaAls.length, 0)
})

// ---- 5. executor compatibility -------------------------------------------
test('executeBuiltinTool still works with and without the 3rd argument', async () => {
  const plain = await B.executeBuiltinTool('echo', { text: 'hi' })
  assert.match(plain, /hi/)
  let called = 0
  const withProgress = await B.executeBuiltinTool('echo', { text: 'hi' }, () => { called += 1 })
  assert.match(withProgress, /hi/)
  assert.equal(called, 0, 'echo spawns nothing, so no progress is expected')
})

;(async () => {
  let failed = 0
  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`  ok  ${name}`)
    } catch (e) {
      failed += 1
      console.error(`  FAIL ${name}: ${e.message}`)
    }
  }
  console.log(`progress: ${cases.length - failed}/${cases.length} passed`)
  process.exit(failed ? 1 : 0)
})()
