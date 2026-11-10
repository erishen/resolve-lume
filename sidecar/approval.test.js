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

test('approval is remembered per run: same tool does not prompt twice', async () => {
  const { res, frames } = fakeStream()
  const id = progress.registerChatStream(res, { userMessage: '跑两个 make' })
  const p1 = approval.request('make', { dir: 'work/a' })
  await new Promise((r) => setTimeout(r, 5))
  approval.resolve(JSON.parse(frames[0].split('data: ')[1]).call.id, 'approve')
  assert.equal((await p1).decision, 'approve')
  const r2 = await approval.request('make', { dir: 'work/b' })
  assert.equal(r2.decision, 'approve')
  assert.equal(r2.reason, 'memo')
  assert.equal(frames.length, 1, 'no second prompt for the same tool in the same run')
  progress.unregisterChatStream(id)
  // A new run must ask again — the memo is per run, not permanent.
  const s2 = fakeStream()
  const id2 = progress.registerChatStream(s2.res, { userMessage: '再跑一个 make' })
  const p3 = approval.request('make', { dir: 'work/c' })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(s2.frames.length, 1, 'new run prompts again')
  approval.resolve(JSON.parse(s2.frames[0].split('data: ')[1]).call.id, 'reject')
  assert.equal((await p3).decision, 'reject')
  progress.unregisterChatStream(id2)
})

test('arg-level rule: read-only article-publish is not gated, confirm=true is', () => {
  const B = require('./builtin-exec')
  assert.equal(B.needsApproval('article-publish', { project: 'x' }), false)
  assert.equal(B.needsApproval('article-publish', { project: 'x', confirm: true }), true)
  assert.equal(B.needsApproval('read-file', { path: 'x' }), false)
  assert.equal(B.needsApproval('pse-review', { provider: 'deepseek' }), false, 'paid tier uses the intent gate')
})

test('read-only shell commands skip the prompt; anything that can write still asks', () => {
  const B = require('./builtin-exec')
  const readOnly = [
    'pwd', 'ls', 'ls -la work', 'cat README.zh.md', 'head -20 Makefile',
    'tail -5 /tmp/x.log', 'wc -l sidecar/server.js', 'grep -rn TODO sidecar',
    'rg -n "needsApproval" sidecar', 'find . -name "*.md"', 'stat .env.example',
    'du -sh work', 'file docker-compose.yml',
    'git status', 'git diff --stat', 'git log -3 --oneline',
  ]
  for (const command of readOnly) {
    assert.equal(B.needsApproval('shell', { command }), false, `should run unattended: ${command}`)
  }
  const gated = [
    'rm -rf x', 'cat x > y', 'ls; rm -rf x', 'echo hi | tee x', 'sudo ls',
    'git branch -d main', 'git push', 'git -c core.pager=cat status',
    'find . -delete', 'find . -exec rm {} +', 'sort -o out.txt x',
    'python3 some/script.py', 'cat .env', 'cat ~/.ssh/id_rsa', 'ls .env.local',
  ]
  for (const command of gated) {
    assert.equal(B.needsApproval('shell', { command }), true, `should ask: ${command}`)
  }
})

test('read-only make targets run unattended; build/restart/publish targets ask', () => {
  const B = require('./builtin-exec')
  const dir = 'work/harness/resolve-lume'
  for (const target of ['check', 'test-gateway', 'frontend-test', 'shell-vars-check', 'sidecar-syntax-check', 'tools-lume-check', 'logs']) {
    assert.equal(B.needsApproval('make', { dir, target }), false, `should run unattended: make ${target}`)
  }
  for (const target of ['build', 'up', 'deploy', 'down', 'sync-enums', 'sidecar-autostart-restart', 'frontend-up']) {
    assert.equal(B.needsApproval('make', { dir, target }), true, `should ask: make ${target}`)
  }
  assert.equal(B.needsApproval('make', { dir, target: 'check', extraArgs: 'ARGS=run.py' }), true, 'extra args can change what a target does')
  assert.equal(B.needsApproval('make', { dir, target: '' }), true, 'no target runs the default goal')

  // The model often reaches a target through shell instead of the make tool;
  // the same verification goals must not prompt there either.
  const shellMake = [
    'make -C ' + dir + ' shell-vars-check',
    'make --no-print-directory -C . check',
  ]
  for (const command of shellMake) {
    assert.equal(B.needsApproval('shell', { command }), false, `should run unattended: ${command}`)
  }
  const shellMakeGated = [
    'make', 'make build', 'make -C . up', 'make -C . sync-enums',
    'make -C . check ARGS=run.py', 'make -j4 check',
  ]
  for (const command of shellMakeGated) {
    assert.equal(B.needsApproval('shell', { command }), true, `should ask: ${command}`)
  }
})

test('concurrent chats: prompt goes to the stream of the calling session', async () => {
  const a = fakeStream()
  const b = fakeStream()
  const ida = progress.registerChatStream(a.res, { userMessage: '会话 A', sessionId: 'sess-aaa' })
  const idb = progress.registerChatStream(b.res, { userMessage: '会话 B', sessionId: 'sess-bbb' })
  const p = approval.request('make', { dir: 'work/a' }, 'sess-aaa')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(a.frames.length, 1, 'prompt lands on session A')
  assert.equal(b.frames.length, 0, 'session B never sees it')
  approval.resolve(JSON.parse(a.frames[0].split('data: ')[1]).call.id, 'approve')
  assert.equal((await p).decision, 'approve')
  progress.unregisterChatStream(ida)
  progress.unregisterChatStream(idb)
})

test('unknown session fails closed instead of picking another chat', async () => {
  const a = fakeStream()
  const id = progress.registerChatStream(a.res, { userMessage: '会话 A', sessionId: 'sess-aaa' })
  const r = await approval.request('shell', { command: 'pwd' }, 'sess-gone')
  assert.equal(r.decision, 'reject')
  assert.equal(r.reason, 'no-chat')
  assert.equal(a.frames.length, 0)
  progress.unregisterChatStream(id)
})

test('progress frames are routed by session, not by stream count', () => {
  const a = fakeStream()
  const b = fakeStream()
  const ida = progress.registerChatStream(a.res, { userMessage: 'A', sessionId: 'sess-a' })
  const idb = progress.registerChatStream(b.res, { userMessage: 'B', sessionId: 'sess-b' })
  assert.equal(progress.broadcastToSession('sess-b', 'log B'), true)
  assert.equal(a.frames.length, 0)
  assert.equal(b.frames.length, 1)
  assert.equal(progress.broadcastToSession('sess-unknown', 'nope'), false)
  progress.unregisterChatStream(ida)
  progress.unregisterChatStream(idb)
})

test('resolving an unknown or late callId applies nothing', () => {
  assert.equal(approval.resolve('call-doesnotexist', 'approve'), false)
})
