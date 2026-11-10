// The 桌面 tab embeds noVNC from the browser-desk container (127.0.0.1:16082),
// but the SPA server used to answer /novnc/* with index.html — the iframe loaded
// itself and stayed blank forever. This pins the rewrite that makes the proxy
// transparent: the browser keeps /novnc/…, the upstream sees websockify's own
// root paths.
import test from 'node:test'
import assert from 'node:assert/strict'
import { novncUpstreamPath } from './novnc-route.mjs'

test('strips the /novnc prefix and keeps the query string', () => {
  assert.equal(novncUpstreamPath('/novnc/vnc.html?autoconnect=1&resize=scale'), '/vnc.html?autoconnect=1&resize=scale')
  assert.equal(novncUpstreamPath('/novnc/websockify'), '/websockify')
  assert.equal(novncUpstreamPath('/novnc/app/ui.js'), '/app/ui.js')
})

test('maps the bare prefix to the upstream root', () => {
  assert.equal(novncUpstreamPath('/novnc'), '/')
  assert.equal(novncUpstreamPath('/novnc/'), '/')
})

test('leaves other routes alone', () => {
  assert.equal(novncUpstreamPath('/api/sessions'), null)
  assert.equal(novncUpstreamPath('/react/api/chat'), null)
  assert.equal(novncUpstreamPath('/'), null)
  // Prefix must end at a boundary: /novncfoo is not the desktop proxy.
  assert.equal(novncUpstreamPath('/novncfoo'), null)
})
