// Export privacy regression tests. Run with:
//   node --experimental-strip-types frontend/src/export.test.mjs
// Node >= 22.6 strips TS types natively, so no bundler / test framework is
// needed (the sidecar test suite is dependency-free for the same reason).
import assert from 'node:assert/strict'
import {
  assistantToMarkdown,
  exportText,
  jobToLog,
  messagesToJson,
  messagesToMarkdown,
  redactForExport,
  truncateForExport,
  MAX_EXPORT_TEXT,
} from './export.ts'

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

const HOME = '/Users/example-user/projects/demo-workspace/.env'
// Built by joining pieces so no complete credential-shaped literal ever lands
// in the repo (privacy scanners would flag it even though these are dummies).
const KEY = ['sk', 'abcdefghijklmnop1234567890'].join('-')
const BEARER = ['Bearer', 'abcdefghijklmnop1234'].join(' ')
const GHP = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_')
const LONG = 'x'.repeat(MAX_EXPORT_TEXT + 500)

const messages = [
  {
    id: 'm1',
    role: 'user',
    content: `read ${HOME}`,
  },
  {
    id: 'm2',
    role: 'assistant',
    content: `answer with ${KEY}`,
    reasoning: `thinking about ${HOME}`,
    toolCalls: [
      {
        id: 't1',
        name: 'read-file',
        arguments: { path: HOME },
        result: `token=${KEY} path=${HOME} ${LONG}`,
        ok: true,
      },
    ],
  },
]

test('redactForExport collapses POSIX home paths to the last 3 segments', () => {
  const out = redactForExport(HOME)
  assert.ok(!out.includes('/Users/example-user/'), out)
  assert.ok(out.startsWith('…/'), out)
  assert.ok(out.endsWith('demo-workspace/.env'), out)
})

test('redactForExport collapses Windows user paths', () => {
  const out = redactForExport('C:\\Users\\example-user\\secret\\notes.md')
  assert.ok(!out.includes('example-user'), out)
  assert.ok(out.includes('notes.md'), out)
})

test('redactForExport drops the account name even on a short path', () => {
  const out = redactForExport('/Users/alice/notes.md')
  assert.ok(!out.includes('alice'), out)
  assert.ok(out.includes('notes.md'), out)
})

// A shared log must not carry the private workspace ROOT. The last-3 rule
// alone leaves it in place: `/Users/<me>/Workspace/CNB/<my-repo>/frameworks/x`
// became `…/<my-repo>/frameworks/x`, naming the private workspace the logs
// came from. The workspace-root segment must be dropped as well.
test('redactForExport drops the private workspace root segment', () => {
  const wsRoot = ['private', 'workspace', 'root'].join('-')
  const out = redactForExport(`/Users/someone/Workspace/CNB/${wsRoot}/frameworks/crewai-pse`)
  assert.ok(!out.includes(wsRoot), out)
  assert.ok(out.endsWith('frameworks/crewai-pse'), out)
})

test('redactForExport keeps the tail of a non-workspace path intact', () => {
  const out = redactForExport('/Users/example-user/projects/demo-workspace/.env')
  assert.ok(out.endsWith('demo-workspace/.env'), out)
})

test('redactForExport masks common credential shapes', () => {
  const out = redactForExport(`key=${KEY} bearer=${BEARER} ghp=${GHP}`)
  assert.ok(!out.includes(KEY), out)
  assert.ok(!out.includes(BEARER), out)
  assert.ok(!out.includes(GHP), out)
  assert.ok(out.includes('<redacted>'), out)
})

test('truncateForExport caps length and leaves a visible marker', () => {
  const out = truncateForExport(LONG)
  assert.ok(out.length < LONG.length)
  assert.match(out, /\[截断 \d+ 字符\]/)
})

test('exportText both redacts and truncates', () => {
  const out = exportText(`${HOME} ${LONG}`)
  assert.ok(!out.includes('/Users/example-user/'), out)
  assert.match(out, /\[截断 \d+ 字符\]/)
})

test('messagesToMarkdown never leaks a home path or API key', () => {
  const md = messagesToMarkdown(messages, 'demo')
  assert.ok(md.includes('# demo'))
  assert.ok(!md.includes('/Users/example-user/'), md.slice(0, 400))
  assert.ok(!md.includes(KEY))
  assert.match(md, /\[截断 \d+ 字符\]/)
})

test('assistantToMarkdown never leaks a home path or API key', () => {
  const md = assistantToMarkdown(messages[1])
  assert.ok(md.includes('read-file'))
  assert.ok(!md.includes('/Users/example-user/'), md.slice(0, 400))
  assert.ok(!md.includes(KEY))
  assert.match(md, /\[截断 \d+ 字符\]/)
})

test('messagesToJson recursively sanitizes nested tool results and stays valid JSON', () => {
  const raw = messagesToJson(messages)
  const parsed = JSON.parse(raw)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].toolCalls[0].name, 'read-file')
  assert.ok(!raw.includes('/Users/example-user/'), raw.slice(0, 400))
  assert.ok(!raw.includes(KEY))
  assert.match(raw, /\[截断 \d+ 字符\]/)
})

const baseJob = {
  id: 'j1',
  name: 'demo job',
  prompt: `inspect ${HOME}`,
  workspace: HOME,
  status: 'failed',
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:01Z',
  error: `failed at ${HOME} with ${KEY}`,
  events: [
    {
      seq: 1,
      type: 'tool-call',
      call: { id: 'c1', name: 'read-file', arguments: { path: HOME } },
    },
    {
      seq: 2,
      type: 'tool-result',
      call: { id: 'c1', name: 'read-file', arguments: {} },
      result: `${KEY} ${HOME} ${LONG}`,
      ok: false,
      durationMs: 12,
    },
    { seq: 3, type: 'done', answer: `done ${HOME}` },
  ],
}

test('jobToLog (failed run) redacts prompt, error, args and results', () => {
  const log = jobToLog(baseJob)
  assert.ok(log.includes('事件日志'))
  assert.ok(!log.includes('/Users/example-user/'), log.slice(0, 600))
  assert.ok(!log.includes(KEY))
  assert.match(log, /\[截断 \d+ 字符\]/)
})

test('jobToLog (succeeded run) redacts the compact failure summary too', () => {
  const log = jobToLog({ ...baseJob, status: 'succeeded', error: undefined })
  assert.ok(log.includes('执行摘要'))
  assert.ok(!log.includes('/Users/example-user/'), log.slice(0, 600))
  assert.ok(!log.includes(KEY))
})

console.log(`\nexport: ${passed}/${passed + failed} passed`)
if (failed) process.exit(1)
