'use strict'
// Approval gate tests — resolve-studio parity: a gated tool must not run until
// a human approves, a timeout is a rejection, and with no live chat stream the
// call fails closed instead of executing unattended.
process.env.SIDECAR_APPROVAL_TIMEOUT_MS = '80'

const test = require('node:test')
const assert = require('node:assert/strict')
const progress = require('./progress')
const approval = require('./approval')

function fakeStream() {
  const frames = []
  const res = {
    writableEnded: false,
    destroyed: false,
    write(chunk) { frames.push(String(chunk)); return true },
  }
  return { res, frames }
}

test('no active chat stream -> fail closed, nothing executed', async () => {
  const r = await approval.request('shell', { command: 'rm -rf /tmp/x' })
  assert.equal(r.decision, 'reject')
  assert.equal(r.reason, 'no-chat')
  assert.equal(approval.pendingCount(), 0)
})

test('prompts the chat stream and pushes an approval-request frame', async () => {
  const { res, frames } = fakeStream()
  const id = progress.registerChatStream(res, { userMessage: '帮我跑一下 make' })
  const p = approval.request('make', { dir: 'work/x', target: 'build' })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(frames.length, 1)
  assert.match(frames[0], /event: approval-request/)
  const payload = JSON.parse(frames[0].split('data: ')[1])
  assert.equal(payload.call.name, 'make')
  assert.match(payload.call.id, /^[A-Za-z0-9_.:-]{1,128}$/)
  assert.equal(approval.pendingCount(), 1)
  approval.resolve(payload.call.id, 'approve')
  const r = await p
  assert.equal(r.decision, 'approve')
  progress.unregisterChatStream(id)
})

test('explicit reject is propagated as reject', async () => {
  const { res, frames } = fakeStream()
  const id = progress.registerChatStream(res, { userMessage: '写个文件' })
  const p = approval.request('write-file', { path: '/tmp/a.txt', content: 'x' })
  await new Promise((r) => setTimeout(r, 5))
  const payload = JSON.parse(frames[0].split('data: ')[1])
  approval.resolve(payload.call.id, 'reject')
  const r = await p
  assert.equal(r.decision, 'reject')
  progress.unregisterChatStream(id)
})

test('timeout is treated as a rejection (loop can never hang)', async () => {
  const { res } = fakeStream()
  const id = progress.registerChatStream(res, { userMessage: '跑一下 shell' })
  const r = await approval.request('shell', { command: 'pwd' })
  assert.equal(r.decision, 'reject')
  assert.equal(r.reason, 'timeout')
  assert.equal(approval.pendingCount(), 0)
  progress.unregisterChatStream(id)
})

test('resolving an unknown or late callId applies nothing', () => {
  assert.equal(approval.resolve('call-doesnotexist', 'approve'), false)
})
