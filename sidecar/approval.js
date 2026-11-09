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
/** @type {Map<number, Set<string>>} */
const approvedByStream = new Map()

function memoGet(streamId, name) {
  const set = approvedByStream.get(streamId)
  return !!(set && set.has(name))
}

function memoAdd(streamId, name) {
  if (streamId == null) return
  let set = approvedByStream.get(streamId)
  if (!set) approvedByStream.set(streamId, (set = new Set()))
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
function request(name, args) {
  if (progress.activeChatStreamCount() === 0) {
    return Promise.resolve({ decision: 'reject', reason: 'no-chat', call: null })
  }
  const streamId = progress.latestChatStreamId()
  if (memoGet(streamId, name)) {
    return Promise.resolve({ decision: 'approve', reason: 'memo', call: null })
  }
  const call = { id: newCallId(), name, arguments: args || {} }
  if (!progress.sendApprovalRequest(call)) {
    return Promise.resolve({ decision: 'reject', reason: 'no-chat', call })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(call.id)) return
      pending.delete(call.id)
      resolve({ decision: 'reject', reason: 'timeout', call })
    }, TIMEOUT_MS)
    pending.set(call.id, { resolve, timer, streamId, name })
  })
}

/** Resolve a pending request. Returns true when a gate was actually released. */
function resolve(callId, decision) {
  const entry = pending.get(String(callId))
  if (!entry) return false
  pending.delete(String(callId))
  clearTimeout(entry.timer)
  if (decision === 'approve') memoAdd(entry.streamId, entry.name)
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

module.exports = { request, resolve, pendingCount, TIMEOUT_MS, _clearAll }
