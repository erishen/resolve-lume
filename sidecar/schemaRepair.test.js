'use strict'
// End-to-end guard for the schema-repair retry in agent.js: a chat turn where
// the gateway rejects a malformed / unknown tool call must be re-issued once
// with the repair note, and the answer must come from the retry — not from the
// "本次运行未完成" fallback.
//
// The fake upstream below speaks agent-httpd's dialect (`data: {"t":...}`), so
// this exercises the real proxy path incl. SSE parsing and buffer reset.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

// agent.js reads AGENT_HTTPD_URL at require time; point it at the fake server.
const FAKE = http.createServer()
let upstreamCalls = 0
const seenBodies = []

FAKE.on('request', (req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    upstreamCalls += 1
    seenBodies.push(Buffer.concat(chunks).toString('utf8'))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (upstreamCalls === 1) {
      res.write('data: {"t":"note","d":"round 1/8"}\n\n')
      res.write('data: {"t":"delta","d":"我先看看目录结构。"}\n\n')
      res.write(
        'data: {"t":"error","d":"tool call validation failed: parameters for tool '
        + 'sidecar__analyze-dir did not match schema: `/ignore`: expected array, but got string"}\n\n',
      )
      res.write('data: {"t":"done"}\n\n')
    } else {
      res.write('data: {"t":"delta","d":"审查完成：没有发现高风险问题。"}\n\n')
      res.write('data: {"t":"done"}\n\n')
    }
    res.end()
  })
})

function fakeRes() {
  const out = { chunks: [], headers: null, ended: false }
  out.done = new Promise((resolve) => { out.markDone = resolve })
  const res = {
    writeHead(status, headers) {
      out.headers = { status, headers }
    },
    write(s) {
      out.chunks.push(String(s))
      return true
    },
    end(s) {
      if (s) out.chunks.push(String(s))
      if (!out.ended) {
        out.ended = true
        out.markDone()
      }
    },
    on() {},
    once() {},
    emit() {},
  }
  out.res = res
  return out
}

test('rejected tool call is retried with a repair note', async () => {
  await new Promise((r) => FAKE.listen(0, '127.0.0.1', r))
  process.env.AGENT_HTTPD_URL = `http://127.0.0.1:${FAKE.address().port}`
  const { proxySSE } = require('./agent')

  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: '审查 taskMatch.js' }],
    tools: ['sidecar__read-file', 'sidecar__shell'],
    sessionId: 'test-session',
  }))
  const out = fakeRes()
  // proxySSE returns once the stream is wired; the retry (and the final
  // res.end) happen later, so wait for the response to actually close.
  await proxySSE({}, out.res, 'POST', '/api/chat', body)
  await out.done

  const sse = out.chunks.join('')
  assert.strictEqual(upstreamCalls, 2, 'expected exactly one retry')
  assert.match(sse, /正在自动重试一次/, 'user should see the retry note')
  assert.match(sse, /审查完成/, 'answer must come from the retried attempt')
  assert.doesNotMatch(sse, /本次运行未完成/, 'the dead attempt must not leave a failure bubble')

  const retryBody = JSON.parse(seenBodies[1])
  const repair = retryBody.messages[retryBody.messages.length - 1]
  assert.strictEqual(repair.role, 'system')
  assert.match(repair.content, /did not match schema/)
  assert.deepStrictEqual(retryBody.tools, ['sidecar__read-file', 'sidecar__shell'])
})

test('a second rejection is not retried again', async () => {
  upstreamCalls = 0
  seenBodies.length = 0
  // Reuse the same fake server but make both attempts fail.
  FAKE.removeAllListeners('request')
  FAKE.on('request', (req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      upstreamCalls += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"t":"error","d":"tool call validation failed: bad args"}\n\n')
      res.write('data: {"t":"done"}\n\n')
      res.end()
    })
  })
  const { proxySSE } = require('./agent')
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  }))
  const out = fakeRes()
  await proxySSE({}, out.res, 'POST', '/api/chat', body)
  await out.done
  assert.strictEqual(upstreamCalls, 2, 'retry budget is one, not a loop')
  assert.match(out.chunks.join(''), /本次运行未完成/)
})

test('a run that already executed a tool is never replayed', async () => {
  upstreamCalls = 0
  seenBodies.length = 0
  FAKE.removeAllListeners('request')
  FAKE.on('request', (req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      upstreamCalls += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"t":"note","d":"tool sidecar__shell({\\"command\\":\\"true\\"})"}\n\n')
      res.write('data: {"t":"error","d":"tool call validation failed: bad args"}\n\n')
      res.write('data: {"t":"done"}\n\n')
      res.end()
    })
  })
  const { proxySSE } = require('./agent')
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: ['sidecar__shell'],
  }))
  const out = fakeRes()
  await proxySSE({}, out.res, 'POST', '/api/chat', body)
  await out.done
  assert.strictEqual(upstreamCalls, 1, 'side effects must not be replayed')
})

test.after(() => FAKE.close())
