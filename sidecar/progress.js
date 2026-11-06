'use strict'
// Tool-run progress bus: bridge long-running business tools into the live chat
// SSE stream without touching the C binary or the generated .lume tool bridge.
//
// Why this exists:
//   A conversational tool call (agent-httpd -> /api/tools/call) is ONE blocking
//   JSON POST. The C agent loop emits no SSE frame while it waits for the tool,
//   so a 15-minute `article-write` looked completely frozen even though the
//   child Python process was printing phase logs the whole time. The chat SSE
//   `res` is still open inside agent.proxySSE, so we register it here and
//   inject `reasoning` frames from the tool's stdout. Frontend already renders
//   `reasoning` in the Thinking panel -> no protocol or UI change needed.
//
// Correlation (important limitation):
//   lume-tools/sidecar_ro.lume sends only {name, arguments} + token; there is
//   no session/run/request id to tie a /api/tools/call back to a /api/chat.
//   We therefore inject progress ONLY when exactly ONE chat stream is active.
//   With concurrent chats we silently drop it rather than leaking one
//   conversation's tool log into another. Exact per-run correlation would need
//   a runId threaded through C + the .lume bridge (much larger change).
//
// Plumbing:
//   AsyncLocalStorage carries the emit function from executeBuiltinTool() down
//   through every business handler into spawnCapture(), so NO business tool has
//   to be edited to opt in — all runPseTask / runPseScript / spawnCapture calls
//   gain progress automatically. Explicit onProgress still wins when provided.

const { AsyncLocalStorage } = require('node:async_hooks')

const als = new AsyncLocalStorage()
const streams = new Map()
let nextStreamId = 1

const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
// Interpreter-level noise that is not a tool phase and must never be framed
// as a failure to the user/model. Real errors (❌ / Traceback) stay visible.
const NOISE_LINE_RE = /DeprecationWarning|There is no current event loop|^\s*asyncio\.get_event_loop\(\)\s*$|^\s*\(node:\d+\).*ExperimentalWarning|^\s*\(Use `node --trace-warnings/i
// Keep tool logs out of exports/chat if a pipeline ever echoes credentials.
const CREDENTIAL_PATTERNS = [
  [/((?:API[_ -]?KEY|ACCESS[_ -]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)(\S+)/gi, '$1[redacted]'],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted]'],
]

function reasoningFrame(text) {
  return `event: reasoning\ndata: ${JSON.stringify({ text })}\n\n`
}

// ---- active chat stream registry -----------------------------------------
function registerChatStream(res, meta = {}) {
  const id = nextStreamId++
  streams.set(id, {
    id,
    res,
    startedAt: Date.now(),
    // Current user message of this chat run. Used to authorize side-effecting
    // tool parameters (publish=true) without a runId in the .lume tool bridge.
    userMessage: String(meta.userMessage || ''),
  })
  return id
}

function unregisterChatStream(id) {
  if (id != null) streams.delete(id)
}

function activeChatStreamCount() {
  return streams.size
}

/** User message of the sole active chat run; '' when ambiguous (never guess). */
function activeChatUserMessage() {
  if (streams.size !== 1) return ''
  return streams.values().next().value.userMessage || ''
}

/** Inject one progress line into the sole active chat stream. Returns false on skip. */
function broadcastToActiveChat(text) {
  if (streams.size !== 1) return false
  const { res } = streams.values().next().value
  if (!res || res.writableEnded || res.destroyed) return false
  try {
    res.write(reasoningFrame(text))
    return true
  } catch {
    return false
  }
}

// ---- AsyncLocalStorage plumbing ------------------------------------------
function currentEmit() {
  return als.getStore() || null
}

function runWithEmit(emit, fn) {
  return typeof emit === 'function' ? als.run(emit, fn) : fn()
}

// ---- chunk -> lines -> throttled frames ----------------------------------
/**
 * Turn raw child-process stdout/stderr chunks into bounded, throttled progress
 * frames. Chunks may end mid-line, contain ANSI colours, or be a single huge
 * progress-bar line; all of that is normalised here.
 *
 * @param {(text:string)=>*} sink receives a fully formatted progress text
 * @param {string} toolName label prefixed to each frame
 */
function createProgressPublisher(sink, toolName, opts = {}) {
  const label = String(toolName || 'tool')
  const minIntervalMs = opts.minIntervalMs ?? 700
  const maxLines = opts.maxLines ?? 160
  const maxLinesPerFrame = opts.maxLinesPerFrame ?? 12
  const maxLineChars = opts.maxLineChars ?? 220
  const now = opts.now || (() => Date.now())
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t))

  let lineBuf = ''
  let pending = []
  let emittedLines = 0
  let dropped = 0
  let lastFlush = 0
  let timer = null
  let finished = false
  let frames = 0

  function cleanLine(raw) {
    let s = String(raw).replace(ANSI_RE, '').replace(/\r/g, '').trim()
    if (!s || /^[-=_*#~.`]{3,}$/.test(s)) return ''
    // Harmless interpreter/framework warnings must not show up as "progress".
    // A free-tier model once read `DeprecationWarning: There is no current
    // event loop` from the Thinking panel and told the user the article run
    // had "一个与异步事件循环相关的小问题" — while it had actually succeeded.
    // The full text is still collected in stdout/stderr for diagnostics.
    if (NOISE_LINE_RE.test(s)) return ''
    for (const [re, rep] of CREDENTIAL_PATTERNS) s = s.replace(re, rep)
    if (s.length > maxLineChars) s = s.slice(0, maxLineChars) + '…'
    return s
  }

  function schedule(ms) {
    if (timer || finished) return
    timer = setTimer(() => {
      timer = null
      flush(false)
    }, Math.max(1, ms))
  }

  function flush(force) {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    if (!pending.length) return
    if (!force && now() - lastFlush < minIntervalMs) {
      schedule(minIntervalMs - (now() - lastFlush))
      return
    }
    do {
      const batch = pending.splice(0, maxLinesPerFrame)
      // A trailing newline keeps consecutive frames from being glued together
      // in the frontend's `reasoning` accumulator.
      const text = `[${label}] ` + batch.join('\n  ') + '\n'
      try {
        sink(text)
        frames += 1
      } catch {
        // Stream already closed: progress is best-effort, never fail the tool.
      }
      lastFlush = now()
    } while (force && pending.length)
    if (!force && pending.length) schedule(minIntervalMs)
  }

  function accept(line) {
    if (!line) return
    if (emittedLines >= maxLines) {
      dropped += 1
      return
    }
    emittedLines += 1
    pending.push(line)
  }

  function push(chunk) {
    if (finished) return
    lineBuf += String(chunk == null ? '' : chunk)
    let idx
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const raw = lineBuf.slice(0, idx)
      lineBuf = lineBuf.slice(idx + 1)
      accept(cleanLine(raw))
    }
    // A chunk without any newline (progress bars, spinner output) must not be
    // buffered forever: slice it into a line once it grows large enough.
    while (lineBuf.length > maxLineChars * 2) {
      accept(cleanLine(lineBuf.slice(0, maxLineChars)))
      lineBuf = lineBuf.slice(maxLineChars)
    }
    flush(false)
  }

  function finish() {
    if (finished) return
    finished = true
    if (lineBuf.trim()) accept(cleanLine(lineBuf))
    lineBuf = ''
    if (dropped) pending.push(`…（另有 ${dropped} 行日志已省略）`)
    flush(true)
  }

  return { push, finish, stats: () => ({ frames, emittedLines, dropped }) }
}

module.exports = {
  reasoningFrame,
  registerChatStream,
  unregisterChatStream,
  activeChatStreamCount,
  activeChatUserMessage,
  broadcastToActiveChat,
  currentEmit,
  runWithEmit,
  createProgressPublisher,
}
