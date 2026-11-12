'use strict'
// Guard against a model re-issuing a byte-identical, already-terminal tool call.
//
// Why this lives in the sidecar rather than in C: agent.c has a stray-repeat
// guard, but it only fires on rounds that ALSO streamed content (`rs.saw_content
// && rs.n_calls > 0`). A model emitting pure tool rounds can therefore re-run
// the same failing pipeline once per round. On 2026-11-06 an `article-write`
// failure was followed by four identical `hot-news({...provider:"llamaindex-pse"})`
// calls, each launching a 15-minute LLM pipeline, exhausting all 8 rounds with
// no answer. The tool bridge carries no runId, so the guard is a short-TTL
// process-local window instead of a per-run set.
//
// 2026-11-12 extension: an EMPTY queue is terminal too. `make juejin-draft`
// succeeds with "全部已发布，无需操作" when no candidate is left — a *success*,
// so the failure-only guard let the model call it four more times (plus
// capabilities / build-juejin / publish-pending) and ask the user about
// --force. queueOutput.js stamps such results with QUEUE_EMPTY_MARKER; this
// guard refuses the identical retry with an explicit stop instruction.
// A REAL draft creation never gets the marker, so "连续建多篇" still works.
const { QUEUE_TASKS, QUEUE_EMPTY_MARKER } = require('./queueOutput')

const TTL_MS = 120_000
const MAX_ENTRIES = 64
const recent = new Map()

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
      .join(',') +
    '}'
  )
}

function signature(name, args) {
  return String(name) + '(' + stable(args || {}) + ')'
}

/** Classify an outcome that must not be repeated with identical arguments. */
function terminalState(name, outcome) {
  if (!outcome) return null
  if (outcome.error) return { kind: 'failure', text: String(outcome.error) }
  const s = String(outcome.result == null ? '' : outcome.result)
  // normalizeToolError() rewrites `error: ...` into `tool error: ...` so
  // agent-httpd does not treat it as a protocol-level 502.
  if (/^\s*(tool error:|error:)/i.test(s)) return { kind: 'failure', text: s }
  // A make/shell runner that exits non-zero appends a literal "[exit code: N]"
  // marker and RESOLVES (it only rejects when there is no output at all). Tools
  // such as publish-wechat.mjs then surface a real failure ("❌ 建草稿失败
  // errcode=45003") with neither an `error:` prefix nor a thrown exception, so
  // this guard previously missed it and a model kept re-issuing the identical
  // failing call. Any non-zero exit marker is therefore a terminal failure.
  if (/\[exit code:\s*(?!0\b)\d+\]/.test(s)) return { kind: 'failure', text: s }
  if (QUEUE_TASKS.has(name) && s.includes(QUEUE_EMPTY_MARKER)) {
    return { kind: 'empty', text: s }
  }
  return null
}

function purge(now) {
  for (const [k, v] of recent) {
    if (now - v.at > TTL_MS) recent.delete(k)
  }
  while (recent.size > MAX_ENTRIES) {
    recent.delete(recent.keys().next().value)
  }
}

/** Return a refusal string when this exact call is already terminal. */
function check(name, args) {
  const now = Date.now()
  purge(now)
  const hit = recent.get(signature(name, args))
  if (!hit || !hit.terminal) return null
  const ago = Math.max(1, Math.round((now - hit.at) / 1000))
  if (hit.terminal.kind === 'empty') {
    return (
      `tool error: ${name} 在 ${ago} 秒前刚返回过「队列为空，没有可处理的文章」，参数完全相同，已拒绝重复执行。` +
      '\n队列状态不会因为重复调用而改变：不要重试、不要加 --force、不要改用 capabilities / build-juejin / publish-pending 等其它工具「补救」，也不要让用户挑选文章。' +
      '\n直接把上次的结论用中文转达用户并结束本轮。'
    )
  }
  return (
    `tool error: ${name} 与 ${ago} 秒前刚失败的一次调用完全相同（参数一致），已拒绝重复执行。` +
    `\n上次失败原因：${hit.terminal.text.slice(0, 400)}` +
    '\n请勿用相同参数重试：要么修正参数后只再试一次，要么把上述失败原因如实转达用户并结束本轮。' +
    ' 禁止改用其它业务域的工具来“补救”。'
  )
}

/** Remember the outcome of an executed call (a fresh success clears the entry). */
function record(name, args, outcome) {
  recent.set(signature(name, args), { at: Date.now(), terminal: terminalState(name, outcome) })
  purge(Date.now())
}

/** Test-only. */
function _reset() {
  recent.clear()
}

module.exports = { check, record, signature, stable, _reset }
