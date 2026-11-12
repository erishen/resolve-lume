'use strict'
// Shared proxy-route predicate (CommonJS so BOTH the ESM production server and
// Vite's possibly-CJS-bundled config can require it without ERR_REQUIRE_ESM).
//
// The frontend relays `/react/*` to agent-httpd for its static demo pages. But
// the same prefix owns the backend control surface:
//   POST /react/api/tools/call  -> execute ANY registered MCP tool directly
//   POST /react/api/chat        -> chat with NO `tools` array = full tool surface
//   POST /react/api/pse         -> PSE orchestrator
// Reaching those from the browser bypasses the per-request tool allow-list that
// agent.c now enforces as a hard boundary (sidecar approval still gates writes,
// but every read-only tool and every unscoped model turn is wide open).
// The SPA never calls /react at all, so only non-API paths stay proxied.

/** True when a request path may be relayed to the backend from the browser. */
function reactPathIsPublic(url) {
  const raw = String(url || '').split('?')[0]
  let p
  try {
    p = decodeURIComponent(raw)
  } catch {
    p = raw
  }
  // Encoded separators and duplicate slashes must not smuggle an API path past
  // a naive prefix check.
  p = p.replace(/\/{2,}/g, '/')
  if (!/^\/react\//i.test(p)) return true // not a /react request at all
  return !/^\/react\/api(?:\/|$)/i.test(p)
}

module.exports = { reactPathIsPublic }
