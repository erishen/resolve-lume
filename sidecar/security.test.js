'use strict'
// Regression tests for the sidecar access policy. Pure Node, no services.
const assert = require('assert')
const path = require('path')
const { isSensitivePath, tokenMatches, MAX_PREVIEW_BYTES } = require('./security')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${name}: ${err.message}`)
  }
}

test('rejects .env and its real-value variants', () => {
  for (const p of ['/work/harness/resolve-lume/.env', '/work/.env.local', '/work/.env.production', '/work/.env.bak']) {
    assert.strictEqual(isSensitivePath(p), true, `${p} must be blocked`)
  }
})

test('still allows public env templates', () => {
  for (const p of ['/work/harness/resolve-lume/.env.example', '/work/.env.sample', '/work/.env.template']) {
    assert.strictEqual(isSensitivePath(p), false, `${p} must stay readable`)
  }
})

test('rejects keys, credentials and sensitive directories', () => {
  for (const p of [
    '/home/me/.ssh/id_rsa', '/work/id_ed25519', '/work/server.key',
    '/work/cert.pem', '/work/credentials.json', '/home/me/.aws/config',
    '/work/api_key.txt', '/home/me/.netrc',
  ]) {
    assert.strictEqual(isSensitivePath(p), true, `${p} must be blocked`)
  }
})

test('does not over-block ordinary source files', () => {
  for (const p of ['/work/src/tokenizer.c', '/work/README.md', '/work/src/app.js', '/work/notes/password-policy.md']) {
    assert.strictEqual(isSensitivePath(p), false, `${p} should be readable`)
  }
})

test('accepts relative paths and normalises them', () => {
  assert.strictEqual(isSensitivePath(path.join(process.cwd(), '../.env')), true)
})

test('token comparison is exact, constant-time and fails closed', () => {
  const secret = 'a'.repeat(64)
  assert.strictEqual(tokenMatches(secret, secret), true)
  assert.strictEqual(tokenMatches('b'.repeat(64), secret), false)
  assert.strictEqual(tokenMatches('a', secret), false)
  assert.strictEqual(tokenMatches(undefined, secret), false)
  assert.strictEqual(tokenMatches(['a'.repeat(64)], secret), false, 'duplicate headers must not match')
  assert.strictEqual(tokenMatches(secret, ''), false, 'empty expected token must never authenticate')
  assert.strictEqual(tokenMatches('', ''), false)
})

test('preview cap is bounded', () => {
  assert.ok(MAX_PREVIEW_BYTES > 0 && MAX_PREVIEW_BYTES <= 8 * 1024 * 1024)
})

// The allowlist is the server-side enforcement for /api/tools/call. If the
// generated bridge is missing, every agent tool would be denied: catch that
// here instead of discovering it from a silent 403 in production.
test('agent tool allowlist is generated and excludes high-risk tools', () => {
  const B = require('./builtin-exec')
  assert.ok(B.AGENT_TOOL_ALLOW.size >= 20, 'run `make tools-lume` to regenerate the bridge')
  for (const n of ['article-write', 'capabilities', 'read-file']) {
    assert.ok(B.AGENT_TOOL_ALLOW.has(n), `${n} should be exposed to the agent`)
  }
  for (const n of ['shell', 'write-file', 'article-publish', 'hot-news-publish']) {
    if (B.BUILTIN_NAMES.has(n)) {
      assert.ok(!B.AGENT_TOOL_ALLOW.has(n), `${n} must NOT be reachable from /api/tools/call`)
    }
  }
})

console.log(`\nsecurity: ${passed}/${passed + failed} passed`)
if (failed) process.exit(1)
