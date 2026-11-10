'use strict'
// Human-in-the-loop approval gate for side-effecting business tools.
//
// Port of resolve-studio's ApprovalService (packages/core/src/services/approval.ts):
// there, every tool whose schema says `needsApproval: true` blocks the agent loop
// until a human answers through the web UI; a request that times out is treated
// as a rejection so the loop can never hang on an absent human.
//
// Why this lives in the sidecar instead of agent-httpd:
//   the C agent loop's `approval` field only writes a log line (mcp.c:754) — it
//   has no approval frame and no way to block. The sidecar already owns the live
//   chat SSE stream (progress.js) and the frontend already renders
//   `approval-request` frames with Approve/Reject buttons (ToolCallCard.tsx),
//   so the gate can be enforced here without touching C or the .lume bridge.
//
// Correlation limit (same as progress.js): the .lume bridge sends only
// {name, arguments}, so we cannot tie a call to a run id. We therefore prompt
// the MOST RECENT chat stream, and refuse to prompt at all when there is none:
// a gated call made by CLI/curl (no human watching) fails closed instead of
// silently executing `shell`.
const crypto = require('node:crypto')
const progress = require('./progress')

// studio uses 60s; a local single operator often needs longer to notice the
// prompt while a slow tool is running, so default to 120s (still bounded — a
// timeout is a refusal, the loop can never hang).
const TIMEOUT_MS = Number(process.env.SIDECAR_APPROVAL_TIMEOUT_MS || 120_000)

// Per-run approval memo (resolve-studio's `approvedTools`): once a human
// approves a tool inside one chat run, later calls of THAT tool in the SAME run
// skip the prompt (the UI shows "approval skipped (already approved this run)").
// Keyed by chat stream id, which is the closest thing lume has to a run id.
/** @type {Map<string, Set<string>>} */
const approvedByStream = new Map()

function memoGet(key, name) {
  const set = approvedByStream.get(key)
  return !!(set && set.has(name))
}

function memoAdd(key, name) {
  if (key == null) return
  let set = approvedByStream.get(key)
  if (!set) approvedByStream.set(key, (set = new Set()))
  set.add(name)
  // Drop memos of finished chats; they are worthless and would leak slowly.
  if (approvedByStream.size > 8) {
    const live = new Set(progress.activeChatStreamIds())
    for (const id of approvedByStream.keys()) if (!live.has(id)) approvedByStream.delete(id)
  }
}

/** @type {Map<string, {resolve:Function, timer:NodeJS.Timeout}>} */
const pending = new Map()

function newCallId() {
  return `call-${crypto.randomBytes(6).toString('hex')}`
}

/**
 * Ask the human. Resolves {decision:'approve'|'reject', call, reason?}.
 * reason: 'no-chat' when no live chat stream exists (fail closed),
 *         'timeout' when nobody answered within TIMEOUT_MS.
 */
function request(name, args, sessionId) {
  const sid = String(sessionId || '')
  const target = sid ? progress.chatStreamForSession(sid) : progress.latestChatStream()
  // A call that names a conversation we cannot find is NOT auto-approved: it
  // means the chat already ended (or the id is bogus), and the safe answer is
  // no. Calls without any sessionId keep the old newest-stream behaviour.
  if (!target || progress.activeChatStreamCount() === 0) {
    return Promise.resolve({ decision: 'reject', reason: 'no-chat', call: null })
  }
  const memoKey = sid || `stream:${target.id}`
  if (memoGet(memoKey, name)) {
    return Promise.resolve({ decision: 'approve', reason: 'memo', call: null })
  }
  const call = { id: newCallId(), name, arguments: args || {} }
  if (!progress.sendApprovalRequest(call, sid)) {
    return Promise.resolve({ decision: 'reject', reason: 'no-chat', call })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(call.id)) return
      pending.delete(call.id)
      resolve({ decision: 'reject', reason: 'timeout', call })
    }, TIMEOUT_MS)
    pending.set(call.id, { resolve, timer, memoKey, name })
  })
}

/** Resolve a pending request. Returns true when a gate was actually released. */
function resolve(callId, decision) {
  const entry = pending.get(String(callId))
  if (!entry) return false
  pending.delete(String(callId))
  clearTimeout(entry.timer)
  if (decision === 'approve') memoAdd(entry.memoKey, entry.name)
  entry.resolve({ decision: decision === 'approve' ? 'approve' : 'reject', call: null, reason: 'user' })
  return true
}

function pendingCount() {
  return pending.size
}

/** Test hook: drop all pending gates without waiting for their timers. */
function _clearAll() {
  for (const [, entry] of pending) clearTimeout(entry.timer)
  pending.clear()
  approvedByStream.clear()
}

// ---- explicit user intent ---------------------------------------------------
// A dialog exists to stop the model from deciding a side effect on its own. When
// the user's own message already asks for that effect AND names the object, the
// human authorized exactly this call before the model proposed it, and asking
// again is pure friction (observed live: "把 X 的文章归档吧" still popped one).
//
// Only reversible LOCAL actions qualify. Anything that leaves the machine
// (WordPress/Juejin/WeChat/SF publishing) still needs a click, and positional
// project numbers are refused because the numbering shifts between runs.
const INTENT_RULES = new Map([
  ['article-archive', /归档|archive/i],
])

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function preAuthorized(name, args, message) {
  const verb = INTENT_RULES.get(name)
  if (!verb) return false
  const msg = String(message || '')
  if (!msg.trim() || !verb.test(msg)) return false
  const project = String((args && args.project) || '').trim()
  if (!project || /^\d+$/.test(project)) return false
  // The message must literally name the project: "那篇文章" does not identify it.
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(project)}($|[^A-Za-z0-9_-])`, 'i').test(msg)
}

module.exports = { request, resolve, pendingCount, preAuthorized, TIMEOUT_MS, _clearAll }
