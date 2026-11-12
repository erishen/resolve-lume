// A browser must not be able to drive agent-httpd's API directly. Pinned tasks
// are a hard execution boundary in agent.c, but /react/api/chat without a
// `tools` array (or /react/api/tools/call) never goes through that request.
import test from 'node:test'
import assert from 'node:assert/strict'
import reactRoute from './react-route.cjs'

const { reactPathIsPublic } = reactRoute

test('every /react/api path is blocked', () => {
  for (const p of [
    '/react/api',
    '/react/api/',
    '/react/api/tools',
    '/react/api/tools/call',
    '/react/api/chat',
    '/react/api/chat?stream=1',
    '/react/api/pse',
    '/react/api/health',
  ]) {
    assert.equal(reactPathIsPublic(p), false, `${p} must be blocked`)
  }
})

test('case, encoded separators and duplicate slashes cannot bypass the gate', () => {
  assert.equal(reactPathIsPublic('/REACT/API/chat'), false)
  assert.equal(reactPathIsPublic('/react/api%2ftools'), false)
  assert.equal(reactPathIsPublic('/react%2fapi%2fchat'), false)
  assert.equal(reactPathIsPublic('/react//api/tools/call'), false)
  assert.equal(reactPathIsPublic('/react/api%2Ftools/call?name=x'), false)
})

test('static demo pages and unrelated routes stay relayable', () => {
  for (const p of ['/react/', '/react/chat', '/react/about', '/react/home.html', '/react/apiary', '/api/tools', '/', '/novnc/vnc.html']) {
    assert.equal(reactPathIsPublic(p), true, `${p} must remain reachable`)
  }
  assert.equal(reactPathIsPublic(undefined), true)
  assert.equal(reactPathIsPublic('/react/%ZZ'), true)
})
