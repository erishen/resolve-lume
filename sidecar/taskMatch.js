'use strict'
// Intent -> task matching, mirroring resolve-studio's
// `tasks.resolve(taskId, messages)` auto path: when the caller did not force a
// taskId, the run narrows to the business task whose `triggers` match the latest
// user message. Pure so it can be unit-tested without the HTTP server.

function matchTaskByMessage(message, tasks) {
  const s = String(message == null ? '' : message).toLowerCase()
  if (!s.trim()) return undefined
  let best
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.id === 'general' || !t.triggers) continue
    const words = String(t.triggers)
      .split(/[,，]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
    let hits = 0
    let chars = 0
    for (const w of words) {
      if (!s.includes(w)) continue
      hits += 1
      chars += w.length // a longer keyword is the more specific signal
    }
    if (!hits) continue
    const score = hits * 100 + chars
    if (!best || score > best.score) best = { task: t, score }
  }
  return best && best.task
}

// A reply that only picks an item out of the list the previous turn rendered:
// "6", "第 6 个", "选 6 吧", "就它". Such a turn carries no keyword of its own,
// so auto-matching always falls through to "no task" — which is how the 2026-11-15
// "6 -> re-ran article-discover instead of writing lume-qt" turn lost the
// article-write soul and its tool allow-list (resolve-studio has the same gap:
// tasks.resolve() only ever looks at the latest message).
const ORDINAL_RE =
  /^\s*(?:我\s*)?(?:就|选|要|写|来|用)?\s*(?:第\s*)?(\d{1,3})\s*(?:个|项|篇|号|条)?\s*(?:吧|就行|就好|好了)?\s*[。！!]?\s*$/
const CONFIRM_RE = /^\s*(?:就|选|要)\s*(?:它|这个|那个)\s*(?:吧|就行|就好|好了)?\s*[。！!]?\s*$/

function isContinuation(message) {
  const s = String(message == null ? '' : message)
  return ORDINAL_RE.test(s) || CONFIRM_RE.test(s)
}

/** The 1-based item number in a pure ordinal reply, or undefined. */
function ordinalOf(message) {
  const m = ORDINAL_RE.exec(String(message == null ? '' : message))
  return m ? Number(m[1]) : undefined
}

/**
 * Resolve the run's task, studio-compatible plus one continuation rule.
 *
 * - explicit taskId (anything but 'auto'/empty) wins, exactly like studio;
 * - otherwise intent-match the latest user message;
 * - when that falls through and the session already ran a task, a pure
 *   ordinal / "就它" reply keeps that task, so the soul and the tool
 *   allow-list stay attached for the follow-up turn.
 *
 * Returns { task, source } with source one of explicit | auto | continuation |
 * none, so callers can log why a task was attached.
 */
function resolveChatTask({ taskId, messages, tasks, lastTaskId } = {}) {
  const registry = Array.isArray(tasks) ? tasks : []
  const forced = typeof taskId === 'string' && taskId !== 'auto' ? taskId : ''
  if (forced) {
    const task = registry.find((t) => t && t.id === forced)
    return { task, source: 'explicit' }
  }
  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => m && m.role === 'user')
  const message = lastUser ? lastUser.content : ''
  const auto = matchTaskByMessage(message, registry)
  if (auto) return { task: auto, source: 'auto' }
  if (lastTaskId && isContinuation(message)) {
    const task = registry.find((t) => t && t.id === lastTaskId)
    if (task) return { task, source: 'continuation' }
  }
  return { task: undefined, source: 'none' }
}

module.exports = { matchTaskByMessage, isContinuation, ordinalOf, resolveChatTask }
