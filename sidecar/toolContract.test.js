'use strict'
// Regression tests for the GLOBAL tool contracts found in the 2026-11-04 audit.
// These are not per-tool patches: each assertion protects a class of failure
// that previously made the agent answer "the gateway doesn't have this tool".
// Run with `make test-gateway`.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const B = require('./builtin-exec')
const H = require('./business-helpers')

const ROOT = path.resolve(__dirname, '..')
const BRIDGE = path.join(ROOT, 'lume-tools', 'sidecar_ro.lume')
const SCHEMAS = path.join(ROOT, 'sidecar', 'builtin-tools.json')
const PROJECTS = path.resolve(ROOT, '../../..', 'frameworks', 'crewai-pse',
  'tasks', 'project-articles', 'projects.json')

const cases = []
function test(name, fn) { cases.push([name, fn]) }

// ---- 1. `error:` prefix must not become an opaque 502 -------------------
test('business error text is readable, never a protocol-level error', () => {
  assert.equal(B.normalizeToolError('error: service down'),
    'tool error: service down')
  assert.equal(B.normalizeToolError('ERROR: unknown platform'),
    'tool error: unknown platform')
  assert.equal(B.normalizeToolError('error: line 1\nline 2'),
    'tool error: line 1\nline 2')
  assert.equal(B.normalizeToolError('> ok, 6 items'), '> ok, 6 items')
  assert.equal(B.normalizeToolError(null), '')
  // The exact shapes that used to return 502 in the smoke test.
  for (const s of [
    'error: markdown-library 服务未运行（:3300 不可达）',
    'error: hot-news-check 未知平台「x」；可用: xiaohongshu, zhihu, toutiao',
    'error: resume-tailor exited with code 1',
  ]) assert.ok(!/^error:/.test(B.normalizeToolError(s)), s)
})

// ---- 2. common argument aliases ----------------------------------------
test('obvious argument aliases map back to schema keys', () => {
  assert.equal(B.normalizeArgs('skill-run', { skill: 'planner' }).name, 'planner')
  assert.equal(B.normalizeArgs('read-file', { file: 'a/b.md' }).path, 'a/b.md')
  assert.equal(B.normalizeArgs('analyze-code-dir', { repo: 'lume-a2a' }).dir, 'lume-a2a')
  assert.equal(B.normalizeArgs('article-write', { repo: 'lume-a2a' }).project, 'lume-a2a')
  assert.equal(B.normalizeArgs('doc-library-search', { query: 'x' }).q, 'x')
  assert.equal(B.normalizeArgs('hot-news', { keyword: 'AI' }).topic, 'AI')
  assert.equal(B.normalizeArgs('hot-news-fetch', { sources: ['weibo', 'infoq'] }).sources,
    'weibo,infoq')
  // canonical value always wins over an alias
  assert.equal(B.normalizeArgs('article-write', { project: 'a', repo: 'b' }).project, 'a')
  // unrelated tools untouched
  assert.deepEqual(B.normalizeArgs('echo', { text: 'x' }), { text: 'x' })
})

// ---- 3. capability catalogue -------------------------------------------
test('capabilities lists held-back tools and forbids the "not mounted" claim', async () => {
  const out = await B.executeBuiltinTool('capabilities', {})
  assert.match(out, /对当前 Agent 开放/)
  assert.match(out, /article-publish/)
  assert.match(out, /pse-review/)
  assert.match(out, /未对 Agent 开放/)
  assert.match(out, /确实存在并有真实实现/)
  assert.match(out, /禁止回答/)
  assert.match(out, /永远安全/)
})

// ---- 4. schema/enum drift vs the real data source ------------------------
test('article-write enum matches projects.json; validators also cover older articles', () => {
  const live = Object.keys(JSON.parse(fs.readFileSync(PROJECTS, 'utf8'))).sort()
  const schemas = JSON.parse(fs.readFileSync(SCHEMAS, 'utf8')).tools
  const withEnum = schemas.filter((t) =>
    t.parameters && t.parameters.properties && t.parameters.properties.project &&
    Array.isArray(t.parameters.properties.project.enum))
  assert.ok(withEnum.length >= 4, 'expected write/validate/publish/archive enums')
  const write = withEnum.find((t) => t.name === 'article-write')
  assert.deepEqual([...write.parameters.properties.project.enum].sort(), live,
    'article-write.project.enum drifted from projects.json')
  // validate/publish/archive also accept already-generated articles that have
  // since left the write queue (e.g. legacy-zh.md), so their enum is a superset.
  for (const t of withEnum.filter((x) => x.name !== 'article-write')) {
    const en = t.parameters.properties.project.enum
    for (const k of live) assert.ok(en.includes(k), `${t.name} missing ${k}`)
    assert.ok(en.length >= live.length, `${t.name} enum is smaller than projects.json`)
  }
})

// ---- 5. generated bridge contract --------------------------------------
test('every exposed tool has a behavioral desc and no retry-bait truncation', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8')
  const rows = [...src.matchAll(/^tool "([^"]+)", ("(?:[^"\\]|\\.)*")/gm)]
  assert.ok(rows.length >= 24, `only ${rows.length} tools exposed`)
  for (const [, name, raw] of rows) {
    const desc = JSON.parse(raw)
    assert.ok(Buffer.byteLength(desc, 'utf8') <= 150, `${name} desc over C limit`)
    assert.ok(desc.length > 25, `${name} desc looks empty`)
  }
  const names = rows.map((r) => r[1])
  for (const n of ['article-write', 'skill-run', 'capabilities', 'article-validate']) {
    assert.ok(names.includes(n), `${n} not exposed to the agent`)
  }
  // Business errors are normalized in the bridge too (defense in depth).
  assert.match(src, /substr\(outv, 0, 6\) == "error:"/)
  // "truncated" wording makes the model retry the tool in a loop.
  assert.doesNotMatch(src, /\[truncated: MCP frame limit/)
  assert.match(src, /no retry needed/)
  // loose params must not be declared in the bridge (else C-side type check
  // rejects them before the sidecar can normalize).
  const fetchLine = src.split('\n').find((l) => l.startsWith('tool "hot-news-fetch"'))
  assert.ok(fetchLine, 'hot-news-fetch tool missing')
  assert.doesNotMatch(fetchLine, /"sources"/)
})

// ---- 6. empty LLM creds must not shadow framework .env ------------------
test('empty OPENAI_* / DEEPSEEK_* vars are stripped from child env', () => {
  const cleaned = H.cleanChildEnv({
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '',
    DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY_REAL: 'keep', PATH: '/usr/bin', UV_PROJECT_ENVIRONMENT: '/v',
  })
  for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
                   'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!(k in cleaned), `${k} should not shadow the framework .env`)
  }
  assert.equal(cleaned.PATH, '/usr/bin')
  assert.equal(cleaned.UV_PROJECT_ENVIRONMENT, '/v')
  // Explicit non-empty values survive (pse-review pins OPENAI_MODEL).
  assert.equal(H.cleanChildEnv({ OPENAI_MODEL: 'deepseek-v4-flash' }).OPENAI_MODEL,
    'deepseek-v4-flash')
})

// ---- 7. generator self-check -------------------------------------------
test('generator --check enforces the desc contract', () => {
  const out = execFileSync(process.execPath,
    [path.join(ROOT, 'deploy', 'gen-sidecar-tools.mjs'), '--check'],
    { encoding: 'utf8' })
  assert.match(out, /校验通过/)
  assert.doesNotMatch(out, /校验失败/)
})

;(async () => {
  let failed = 0
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ok  ${name}`) }
    catch (e) { failed++; console.error(`  FAIL ${name}: ${e.message}`) }
  }
  console.log(`${cases.length - failed}/${cases.length} tool contract tests passed`)
  process.exit(failed ? 1 : 0)
})()
