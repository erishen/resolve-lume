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
test('article project enums are exactly the derived set (no drift either way)', () => {
  const E = require('./projectEnums')
  const live = E.liveProjects().slice().sort()
  const doc = JSON.parse(fs.readFileSync(SCHEMAS, 'utf8'))
  const cur = E.currentEnums(doc)
  for (const name of E.ENUM_TOOLS) assert.ok(cur[name], `${name} has no project enum`)
  // The write queue is exactly what projects.json lists right now.
  assert.deepEqual(cur['article-write'], live,
    'article-write.project.enum drifted from projects.json — run `make sync-enums`')
  // validate/publish/archive also accept articles that already left the queue
  // (legacy, resolve-lume) but only while their body still exists on disk.
  const want = E.expectedEnums({ live, current: Object.values(cur).flat() })
  for (const name of E.ENUM_TOOLS.filter((n) => n !== 'article-write')) {
    assert.deepEqual(cur[name], want.extended,
      `${name}.project.enum drifted — run \`make sync-enums\``)
  }
})

// ---- 5. generated bridge contract --------------------------------------
test('every exposed tool has a behavioral desc and no retry-bait truncation', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8')
  const rows = [...src.matchAll(/^tool "([^"]+)", ("(?:[^"\\]|\\.)*")/gm)]
  assert.ok(rows.length >= 24, `only ${rows.length} tools exposed`)
  for (const [, name, raw] of rows) {
    const desc = JSON.parse(raw)
    // lume-core ToolRec.desc is 1024 B as of 2026-11-09 (was 160); the generator
    // caps at 900 so the bridge never truncates mid-sentence.
    assert.ok(Buffer.byteLength(desc, 'utf8') <= 900, `${name} desc over C limit`)
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
    const r = await PSE['article-write']({ project: 'solo-chat' })
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

test('article-write: publish-gate cancellation is "generated", not "failed"', async () => {
  // 11-06 实测：文章已落盘，但 --publish 触发 publish.py 确认门取消 →
  // run.py 退出 1 → 旧实现直接 return res.error，模型把 stderr 的
  // DeprecationWarning 读成「异步事件循环的小问题」并编造三选一话术。
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  H.runPseTask = async () => ({
    ok: false,
    error: 'error: article-write exited with code 1\n⏹️ 已取消，未发布任何内容',
    stdout: '中文已保存 → /a/zh.md\n英文已保存 → /a/en.md\n' +
      '🚀 发布文章到 WordPress...\n⏹️ 已取消，未发布任何内容\n',
    stderr: 'run.py:287: DeprecationWarning: There is no current event loop\n',
  })
  try {
    const r = await PSE['article-write']({ project: 'solo-chat', publish: true })
    assert.match(r, /article generated/)
    assert.match(r, /未发布/)
    assert.match(r, /流水线在文章落盘之后/)
    assert.doesNotMatch(r, /^error:/)
    assert.doesNotMatch(r, /Auto-published/)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write still errors when nothing was actually generated', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  H.runPseTask = async () => ({
    ok: false,
    error: 'error: article-write exited with code 1\nTraceback: boom',
    stdout: '',
    stderr: 'Traceback: boom',
  })
  try {
    const r = await PSE['article-write']({ project: 'solo-chat' })
    assert.match(r, /^error:/)
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
    const r = await PSE['article-write']({ project: 'solo-chat', style: 'K' })
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

// ---- 7b. 编号选择串台（11-06：用户回「7」→ 未注册的 lume-orbstack）------
test('article project numbering has one authoritative ordered list', () => {
  const keys = H.articleProjectKeys(CREWAI_ROOT)
  const live = Object.keys(JSON.parse(fs.readFileSync(PROJECTS, 'utf8')))
  // 编号清单必须与 projects.json 插入顺序完全一致（否则既有选择习惯失效）
  assert.deepEqual(keys, live)
  // 数字选择解析到对应 key；越界/未注册给出明确原因（不依赖具体项目名）
  const N = String(keys.length)
  assert.equal(H.resolveArticleProject(N, keys).key, keys[keys.length - 1])
  assert.equal(H.resolveArticleProject('1', keys).key, keys[0])
  assert.equal(H.resolveArticleProject('99', keys).reason, 'range')
  assert.equal(H.resolveArticleProject('lume-orbstack', keys).reason, 'unknown')
  assert.match(H.numberedProjectKeys(keys), /^1\. /)
})

test('article-write resolves a numeric project choice itself', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  const keys = H.articleProjectKeys(CREWAI_ROOT)
  let seenArgs = null
  H.runPseTask = async (o) => {
    seenArgs = o.args
    return { ok: true, stdout: '中文已保存 → /a/zh.md\n', stderr: '' }
  }
  try {
    const r = await PSE['article-write']({ project: String(keys.length) })
    assert.match(r, /article generated/)
    assert.deepEqual(seenArgs, [keys[keys.length - 1]])
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write explains unregistered discover candidates', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  let spawned = false
  H.runPseTask = async () => { spawned = true; return { ok: true, stdout: '', stderr: '' } }
  try {
    const r = await PSE['article-write']({ project: 'lume-orbstack' })
    assert.match(r, /^error:/)
    assert.match(r, /未注册候选/)
    assert.match(r, /project="N"/)
    assert.match(r, /1\. solo-chat/)
    assert.equal(spawned, false)
  } finally {
    H.runPseTask = savedRun
    if (savedEnv === undefined) delete process.env.CREWAI_PSE_DIR
    else process.env.CREWAI_PSE_DIR = savedEnv
  }
})

test('article-write rejects an out-of-range numeric choice', async () => {
  const savedEnv = process.env.CREWAI_PSE_DIR
  const savedRun = H.runPseTask
  process.env.CREWAI_PSE_DIR = CREWAI_ROOT
  let spawned = false
  H.runPseTask = async () => { spawned = true; return { ok: true, stdout: '', stderr: '' } }
  try {
    const r = await PSE['article-write']({ project: '99' })
    assert.match(r, /编号 99 超出范围/)
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
