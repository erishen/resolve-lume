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

// ---- 7. article-write: quarantined runs must never look successful -------
// Regression for 2026-11-06: crewai-pse gates off-topic drafts via
// quarantine() + `return` (exit code 0, no zh marker). The sidecar used to
// reply "article generated" and the agent happily told the user it succeeded.
const PSE = require('./business-pse')
const CREWAI_ROOT = path.resolve(path.dirname(PROJECTS), '../..')

test('articleRunOutcome: a normal run with both markers is a success', () => {
  const o = H.articleRunOutcome(
    '✅ 中文已保存 → /a/zh.md\n✅ 英文已保存 → /a/en.md\n', '')
  assert.equal(o.ok, true)
  assert.equal(o.zhPath, '/a/zh.md')
  assert.equal(o.enPath, '/a/en.md')
  assert.equal(o.quarantined, false)
})

test('articleRunOutcome: quarantine with exit code 0 is a failure, reason kept', () => {
  const o = H.articleRunOutcome([
    '❌ 项目相关性不足（score=6 < 8），隔离待复核，不翻译',
    '   已保存待复核 → /a/needs-review/resolve-lume.md',
    '   隔离原因 → resolve-lume.reason.txt: 项目相关性不足（score=6 < 8）',
  ].join('\n'), '')
  assert.equal(o.ok, false)
  assert.equal(o.quarantined, true)
  assert.match(o.reason, /项目相关性不足/)
})

test('articleRunOutcome: a missing zh marker is a failure even with exit code 0', () => {
  const o = H.articleRunOutcome('pipeline output, but no save marker\n', '')
  assert.equal(o.ok, false)
  assert.equal(o.quarantined, false)
})

test('articleRunOutcome: quarantine wins over a stale zh marker', () => {
  const o = H.articleRunOutcome(
    '中文已保存 → /a/zh.md\n   已保存待复核 → /a/needs-review/x.md\n', '')
  assert.equal(o.ok, false)
})

test('article-write returns an error (never "generated") for a quarantined run', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  H.runPseTask = async () => ({
    ok: true,
    stdout: '❌ 项目相关性不足，隔离待复核\n' +
      '   已保存待复核 → /a/needs-review/x.md\n' +
      '   隔离原因 → x.reason.txt: 项目相关性不足（score=6 < 8）\n',
    stderr: '',
  })
  try {
    const r = await PSE['article-write']({ project: 'resolve-lume' })
    assert.match(r, /^error:/)
    assert.match(r, /未生成可发布文章/)
    assert.match(r, /项目相关性不足/)
    assert.doesNotMatch(r, /article generated/)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write rejects an unknown style instead of silently auto-rotating', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  let spawned = false
  H.runPseTask = async () => { spawned = true; return { ok: true, stdout: '', stderr: '' } }
  try {
    const r = await PSE['article-write']({ project: 'resolve-lume', style: 'K' })
    assert.match(r, /^error:/)
    assert.match(r, /不支持 style="K"/)
    assert.equal(spawned, false)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write quarantine error no longer prescribes a style switch', async () => {
  // 11-06 alva-e2e：旧文案写死「改用 style=B / style=D（非骨架写作流）」，
  // 模型照抄成回答，把相关性闸门误判归因成骨架流并诱导用户无意义重试。
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  H.runPseTask = async () => ({
    ok: true,
    stdout: '❌ 项目相关性不足，隔离待复核\n' +
      '   已保存待复核 → /a/needs-review/x.md\n' +
      '   隔离原因 → x.reason.txt: 项目相关性不足（得分 5 < 8）\n',
    stderr: '',
  })
  try {
    const r = await PSE['article-write']({ project: 'alva-e2e', style: 'A' })
    assert.match(r, /^error:/)
    assert.match(r, /项目相关性不足/)
    assert.doesNotMatch(r, /改用 style=/)
    assert.doesNotMatch(r, /非骨架写作流/)
    assert.match(r, /不要只靠换 style 重试/)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write rejects an unknown provider instead of silently using free', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  let spawned = false
  H.runPseTask = async () => { spawned = true; return { ok: true, stdout: '', stderr: '' } }
  try {
    const r = await PSE['article-write']({ project: 'alva-e2e', provider: 'medium' })
    assert.match(r, /^error:/)
    assert.match(r, /不支持 provider="medium"/)
    assert.equal(spawned, false)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

// ---- 8. generator self-check -------------------------------------------
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
