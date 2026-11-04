'use strict'
// Single source of truth for sidecar-side access policy. Both the HTTP file
// endpoints (server.js) and the builtin file tools (builtin-exec.js) call in
// here, so a new rule cannot be added to one and forgotten in the other.
const path = require('path')
const crypto = require('crypto')

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

module.exports = { isSensitivePath, tokenMatches, MAX_PREVIEW_BYTES }
