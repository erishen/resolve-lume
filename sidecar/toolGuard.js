'use strict'
// Guard against a model re-issuing a byte-identical, already-failed tool call.
//
// Why this lives in the sidecar rather than in C: agent.c has a stray-repeat
// guard, but it only fires on rounds that ALSO streamed content (`rs.saw_content
// && rs.n_calls > 0`). A model emitting pure tool rounds can therefore re-run
// the same failing pipeline once per round. On 2026-11-06 an `article-write`
// failure was followed by four identical `hot-news({...provider:"llamaindex-pse"})`
// calls, each launching a 15-minute LLM pipeline, exhausting all 8 rounds with
// no answer. The tool bridge carries no runId, so the guard is a short-TTL
// process-local window instead of a per-run set: it only ever refuses a call
// that is identical to one that FAILED moments ago, which is never useful work.
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

function failureText(outcome) {
  if (!outcome) return ''
  if (outcome.error) return String(outcome.error)
  const s = String(outcome.result == null ? '' : outcome.result)
  // normalizeToolError() rewrites `error: ...` into `tool error: ...` so
  // agent-httpd does not treat it as a protocol-level 502.
  return /^\s*(tool error:|error:)/i.test(s) ? s : ''
}

function purge(now) {
  for (const [k, v] of recent) {
    if (now - v.at > TTL_MS) recent.delete(k)
  }
  while (recent.size > MAX_ENTRIES) {
    recent.delete(recent.keys().next().value)
  }
}

/** Return a refusal string when this exact call already failed recently. */
function check(name, args) {
  const now = Date.now()
  purge(now)
  const hit = recent.get(signature(name, args))
  if (!hit || !hit.failure) return null
  const ago = Math.max(1, Math.round((now - hit.at) / 1000))
  return (
    `tool error: ${name} 与 ${ago} 秒前刚失败的一次调用完全相同（参数一致），已拒绝重复执行。` +
    `\n上次失败原因：${hit.failure.slice(0, 400)}` +
    '\n请勿用相同参数重试：要么修正参数后只再试一次，要么把上述失败原因如实转达用户并结束本轮。' +
    ' 禁止改用其它业务域的工具来“补救”。'
  )
}

/** Remember the outcome of an executed call (success overwrites a stale failure). */
function record(name, args, outcome) {
  const failure = failureText(outcome)
  recent.set(signature(name, args), { at: Date.now(), failure })
  purge(Date.now())
}

/** Test-only. */
function _reset() {
  recent.clear()
}

module.exports = { check, record, signature, stable, _reset }
