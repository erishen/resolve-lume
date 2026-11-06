// SSE client regression tests (Node >= 22.6, no bundler / framework).
//   node --experimental-strip-types frontend/src/api.test.mjs
//
// The browser streams are easy to get subtly wrong: a dropped connection used
// to be swallowed with no error, and the Stop button never reached tool runs.
// Mock global fetch with an in-memory Response stream to pin the contract.
import assert from 'node:assert/strict'
import {
  streamChat,
  streamToolRun,
  streamJob,
  readFrames,
  INCOMPLETE_STREAM_MESSAGE,
  STREAM_STALLED_MESSAGE,
} from './api.ts'

let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ok  ${name}`)
    })
    .catch((err) => {
      failed++
      console.error(`  FAIL  ${name}: ${err.message}`)
    })
}

const enc = new TextEncoder()
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

/** A Response whose body emits the given SSE frames then closes. */
function sseResponse(frames) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/**
 * A Response that emits frames but NEVER closes the HTTP stream. Reproduces the
 * "answer rendered, composer still says Agent is thinking…" incident: a proxy
 * keeping the socket open (or a sidecar restart leaving it dangling).
 */
function openEndedResponse(frames, onCancel) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f))
      },
      cancel() {
        onCancel?.()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/** A Response that never completes, so abort can be exercised. */
function hangingResponse(init) {
  let controller
  const stream = new ReadableStream({
    start(c) {
      controller = c
      controller.enqueue(enc.encode(frame('delta', { text: 'partial' })))
    },
  })
  init?.signal?.addEventListener('abort', () => {
    // Mirror what fetch does to a body reader when the request is aborted.
    controller.error(new DOMException('Aborted', 'AbortError'))
  })
  return new Response(stream, { status: 200 })
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

await test('streamChat resolves on a normal done frame and forwards the signal', async () => {
  const events = []
  const ac = new AbortController()
  let seenSignal
  await withFetch(
    (_url, init) => {
      seenSignal = init.signal
      return Promise.resolve(sseResponse([frame('delta', { text: 'hi' }), frame('done', { answer: 'hi' })]))
    },
    () => streamChat([{ role: 'user', content: 'x' }], undefined, (e) => events.push(e), ac.signal),
  )
  assert.equal(seenSignal, ac.signal)
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'])
})

await test('tool progress reasoning frames stream through without ending the run', async () => {
  const events = []
  await withFetch(
    () =>
      Promise.resolve(
        sseResponse([
          frame('reasoning', { text: '[article-write] Phase 1/4\n' }),
          frame('reasoning', { text: '[article-write] Phase 2/4\n' }),
          frame('delta', { text: 'answer' }),
          frame('done', { answer: 'answer' }),
        ]),
      ),
    () => streamChat([{ role: 'user', content: 'x' }], undefined, (e) => events.push(e)),
  )
  assert.deepEqual(events.map((e) => e.type), ['reasoning', 'reasoning', 'delta', 'done'])
  assert.equal(events[0].text, '[article-write] Phase 1/4\n')
  assert.equal(events[3].answer, 'answer')
})

await test('readFrames resets its idle watchdog on periodic progress frames', async () => {
  // A 15-minute tool run must not be killed by the 5-min silent-stream guard:
  // each progress frame re-arms the timer. Here 5 frames at 40ms with a
  // 120ms idle budget would stall immediately if re-arming were missing.
  let controller
  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const res = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  const seen = []
  const done = readFrames(res, (f) => seen.push(f), {
    idleTimeoutMs: 120,
    shouldStop: () => seen.some((f) => f.includes('event: done')),
  })
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 40))
    controller.enqueue(enc.encode(frame('reasoning', { text: `phase ${i}\n` })))
  }
  controller.enqueue(enc.encode(frame('done', { answer: 'ok' })))
  controller.close()
  await done
  assert.equal(seen.length, 6)
  assert.match(seen.join(''), /phase 4/)
})

await test('streamChat settles on `done` even when the proxy never closes the socket', async () => {
  const events = []
  let cancelled = false
  await withFetch(
    () =>
      Promise.resolve(
        openEndedResponse(
          [frame('delta', { text: '已更新' }), frame('done', { answer: '已更新' })],
          () => {
            cancelled = true
          },
        ),
      ),
    async () => {
      const outcome = await Promise.race([
        streamChat([{ role: 'user', content: 'x' }], undefined, (e) => events.push(e)).then(
          () => 'resolved',
        ),
        new Promise((r) => setTimeout(() => r('HUNG'), 300)),
      ])
      // If this hangs, useChat's finally never runs and busy stays true forever.
      assert.equal(outcome, 'resolved')
    },
  )
  assert.deepEqual(events.map((e) => e.type), ['delta', 'done'])
  assert.equal(cancelled, true, 'the dangling socket must be released')
})

await test('streamToolRun also settles on `done` without HTTP EOF', async () => {
  let cancelled = false
  await withFetch(
    () =>
      Promise.resolve(
        openEndedResponse([frame('done', { answer: 'ok' })], () => {
          cancelled = true
        }),
      ),
    async () => {
      const outcome = await Promise.race([
        streamToolRun('echo', {}, () => {}).then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('HUNG'), 300)),
      ])
      assert.equal(outcome, 'resolved')
    },
  )
  assert.equal(cancelled, true)
})

await test('streamChat settles on `error` frame with the socket still open', async () => {
  const events = []
  await withFetch(
    () => Promise.resolve(openEndedResponse([frame('error', { message: '429' })])),
    async () => {
      const outcome = await Promise.race([
        streamChat([], undefined, (e) => events.push(e)).then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('HUNG'), 300)),
      ])
      assert.equal(outcome, 'resolved')
    },
  )
  assert.deepEqual(events.map((e) => e.type), ['error'])
})

await test('readFrames gives up on a silent stream when idleTimeoutMs elapses', async () => {
  const res = new Response(new ReadableStream({ start() {} }), { status: 200 })
  let err
  try {
    await readFrames(res, () => {}, { idleTimeoutMs: 30 })
  } catch (e) {
    err = e
  }
  assert.equal(err?.message, STREAM_STALLED_MESSAGE)
})

await test('readFrames tail frame still terminates a one-shot stream', async () => {
  const frames = []
  const res = new Response(
    new ReadableStream({
      start(c) {
        // No trailing \n\n: only the EOF tail flush can deliver this frame.
        c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ answer: 'ok' })}`))
        c.close()
      },
    }),
    { status: 200 },
  )
  let terminal = false
  await readFrames(
    res,
    (f) => {
      frames.push(f)
      if (f.startsWith('event: done')) terminal = true
    },
    { shouldStop: () => terminal },
  )
  assert.equal(frames.length, 1)
})

await test('streamChat reports an incomplete stream instead of silently truncating', async () => {
  const events = []
  await withFetch(
    () => Promise.resolve(sseResponse([frame('delta', { text: 'half' })])),
    async () => {
      await assert.rejects(
        () => streamChat([{ role: 'user', content: 'x' }], undefined, (e) => events.push(e)),
        (err) => err.message === INCOMPLETE_STREAM_MESSAGE,
      )
    },
  )
  assert.equal(events.length, 1, 'already-received deltas must still be delivered')
})

await test('streamChat does NOT auto-resend a non-idempotent POST', async () => {
  let calls = 0
  await withFetch(
    () => {
      calls++
      return Promise.resolve(sseResponse([frame('delta', { text: 'half' })]))
    },
    async () => {
      await assert.rejects(() => streamChat([], undefined, () => {}))
    },
  )
  assert.equal(calls, 1)
})

await test('streamChat accepts an error frame as a terminal event', async () => {
  const events = []
  await withFetch(
    () => Promise.resolve(sseResponse([frame('error', { message: 'upstream 429' })])),
    () => streamChat([], undefined, (e) => events.push(e)),
  )
  assert.deepEqual(events.map((e) => e.type), ['error'])
})

await test('streamToolRun passes its AbortSignal through (Stop button works)', async () => {
  const ac = new AbortController()
  let seenSignal
  await withFetch(
    (_url, init) => {
      seenSignal = init.signal
      return Promise.resolve(hangingResponse(init))
    },
    async () => {
      const done = streamToolRun('echo', {}, () => {}, ac.signal)
      setTimeout(() => ac.abort(), 20)
      await done // must resolve, not throw
    },
  )
  assert.equal(seenSignal, ac.signal)
})

await test('streamToolRun rejects an incomplete stream', async () => {
  await withFetch(
    () => Promise.resolve(sseResponse([frame('delta', { text: 'half' })])),
    async () => {
      await assert.rejects(
        () => streamToolRun('echo', {}, () => {}),
        (err) => err.message === INCOMPLETE_STREAM_MESSAGE,
      )
    },
  )
})

await test('streamJob re-attaches after a dropped connection and stops at a terminal snapshot', async () => {
  const statuses = []
  const events = []
  let calls = 0
  await withFetch(
    () => {
      calls++
      if (calls === 1) return Promise.resolve(sseResponse([])) // connection dropped
      return Promise.resolve(
        sseResponse([
          'event: snapshot\ndata: ' +
            JSON.stringify({ status: 'succeeded', events: [] }) +
            '\n\n',
        ]),
      )
    },
    async () => {
      const ac = streamJob(
        'job-1',
        (ev) => events.push(ev),
        { onStatus: (state, attempt) => statuses.push(`${state}:${attempt}`) },
      )
      // First retry waits 500ms; give the loop enough time to land the snapshot.
      await new Promise((resolve) => setTimeout(resolve, 900))
      ac.abort()
    },
  )
  assert.ok(calls >= 2, `expected a reconnect, got ${calls} fetches`)
  assert.ok(statuses.includes('connected:0'), statuses.join(','))
  assert.ok(statuses.some((s) => s.startsWith('reconnecting:1')), statuses.join(','))
  assert.ok(events.some((e) => e.type === 'snapshot'))
})

await test('streamJob abort stops the reconnect loop', async () => {
  let calls = 0
  await withFetch(
    () => {
      calls++
      return Promise.resolve(sseResponse([]))
    },
    async () => {
      const ac = streamJob('job-2', () => {})
      ac.abort()
      await new Promise((resolve) => setTimeout(resolve, 200))
    },
  )
  assert.equal(calls, 1)
})

console.log(`\napi: ${passed}/${passed + failed} passed`)
if (failed) process.exit(1)
