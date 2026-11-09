'use strict'
// Regression tests for the SSE dialect translator in agent.js.
//
// agent-httpd streams EVERY round's model text as `delta` and never labels the
// final answer. Two production failures are guarded here:
//   1. "output looks truncated, let me retry" (said before a tool call) became
//      the whole answer when the run later died on an upstream 429.
//   2. PSE glued Planner's plan + Specialist's result + Evaluator's verdict
//      into a single assistant message.
//
// Run: `node sidecar/translateFrame.test.js` or `make test-gateway`.
// Zero external dependencies — keep it that way (the host sidecar has no
// node_modules).
const { translateFrame } = require('./agent')

function replay(frames) {
  const buf = { text: '', pending: '', answer: '', error: '', suppress: false }
  let done = ''
  for (const f of frames) {
    const out = translateFrame(f, buf)
    if (f.t === 'done') done = out
  }
  return JSON.parse(done.match(/data: (.*)/)[1]).answer
}

const cases = [
  {
    name: 'single-agent: retry narration dropped, final summary kept',
    frames: [
      { t: 'note', d: 'tool sidecar__article-discover({})' },
      { t: 'delta', d: '输出似乎被截断了，我重新跑一次。' },
      { t: 'note', d: 'round 2/8' },
      { t: 'note', d: 'tool sidecar__article-discover({"add": false})' },
      { t: 'delta', d: '扫描完成：6 个可写项目（solo-chat / rag-platform / ...）。' },
      { t: 'done' },
    ],
    want: ['扫描完成', '6 个可写项目'],
    avoid: ['输出似乎被截断'],
  },
  {
    name: 'upstream 429: explicit failure, never a fake answer',
    frames: [
      { t: 'delta', d: '输出似乎被截断了，我重新跑一次' },
      { t: 'error', d: 'upstream rate limited (HTTP 429); wait a moment and retry' },
      { t: 'done' },
    ],
    want: ['⚠️', '429'],
    avoid: ['输出似乎被截断'],
  },
  {
    name: 'PSE: plan and verdict excluded, specialist result kept',
    frames: [
      { t: 'note', d: 'PSE cycle 1/3 - Planner' },
      { t: 'delta', d: '## 执行计划：扫描可写技术文章的 GitHub 项目' },
      { t: 'note', d: '[planner]' },
      { t: 'note', d: 'PSE cycle 1/3 - Specialist (tools)' },
      { t: 'note', d: 'tool sidecar__article-discover({})' },
      { t: 'note', d: 'round 2/8' },
      { t: 'delta', d: '| 1 | solo-chat | ... |\n| 6 | lume-a2a | ... |\n\n共 6 个可写项目。' },
      { t: 'note', d: 'PSE cycle 1/3 - Evaluator' },
      { t: 'delta', d: '结论：FAIL 理由：未展示 projects.json 实际读取结果。' },
      { t: 'note', d: '[evaluator]' },
      { t: 'note', d: 'PSE exhausted attempts; last Specialist output above is the result.' },
      { t: 'done' },
    ],
    want: ['共 6 个可写项目', 'lume-a2a'],
    avoid: ['执行计划', '结论：FAIL'],
  },
  {
    name: 'PSE multi-cycle: latest specialist result wins',
    frames: [
      { t: 'note', d: 'PSE cycle 1/3 - Planner' },
      { t: 'delta', d: '计划 v1' },
      { t: 'note', d: '[planner]' },
      { t: 'note', d: 'PSE cycle 1/3 - Evaluator' },
      { t: 'delta', d: 'FAIL' },
      { t: 'note', d: '[evaluator]' },
      { t: 'note', d: 'PSE cycle 2/3 - Planner' },
      { t: 'delta', d: '计划 v2' },
      { t: 'note', d: '[planner]' },
      { t: 'delta', d: '最终清单 A' },
      { t: 'note', d: 'PSE cycle 2/3 - Evaluator' },
      { t: 'delta', d: 'PASS' },
      { t: 'note', d: '[evaluator]' },
      { t: 'done' },
    ],
    want: ['最终清单 A'],
    avoid: ['计划 v1', '计划 v2', 'PASS'],
  },
  {
    name: 'plain single-turn answer unchanged (no tool calls at all)',
    frames: [
      { t: 'delta', d: '你好，' },
      { t: 'delta', d: '这是一次普通问答。' },
      { t: 'done' },
    ],
    want: ['你好，这是一次普通问答。'],
    avoid: ['⚠️'],
  },
  {
    // 2026-11-06 incident: article-write failed, model wandered into the
    // hot-news pipeline and re-ran it 4 times, then ended with no text. The
    // old "请重试" hid all of that and invited another identical retry.
    name: 'exhausted tool rounds report the trajectory instead of a blind retry hint',
    frames: [
      { t: 'note', d: 'tool sidecar__article-write({"project": "resolve-lume"})' },
      { t: 'note', d: 'round 2/8' },
      { t: 'note', d: 'tool sidecar__hot-news-topics({"news_dir": "news"})' },
      { t: 'note', d: 'round 3/8' },
      { t: 'note', d: 'tool sidecar__hot-news({"topic": "x", "provider": "llamaindex-pse"})' },
      { t: 'note', d: 'round 4/8' },
      { t: 'note', d: 'tool sidecar__hot-news({"topic": "x", "provider": "llamaindex-pse"})' },
      { t: 'note', d: 'round 5/8' },
      { t: 'note', d: 'tool sidecar__hot-news({"topic": "x", "provider": "llamaindex-pse"})' },
      { t: 'note', d: 'round 6/8' },
      { t: 'note', d: 'tool sidecar__hot-news({"topic": "x", "provider": "llamaindex-pse"})' },
      { t: 'note', d: 'round 8/8' },
      { t: 'done' },
    ],
    want: ['8 轮工具预算已用尽', 'article-write', 'hot-news-topics', 'hot-news ×4', '调用轨迹', '请勿直接点重试'],
    avoid: ['工具已执行，但模型未返回总结；请重试'],
  },
  {
    name: 'explicit upstream error still wins over the empty-run summary',
    frames: [
      { t: 'note', d: 'tool sidecar__article-write({"project": "7"})' },
      { t: 'error', d: 'upstream quota exhausted (HTTP 429)' },
      { t: 'done' },
    ],
    want: ['⚠️ 本次运行未完成', '429'],
    avoid: ['调用轨迹'],
  },
  {
    name: 'tool-call fragment as the whole answer is replaced by a notice',
    frames: [
      { t: 'delta', d: '"arguments": {}}' },
      { t: 'done' },
    ],
    want: ['写成了正文', '没有执行它'],
    avoid: ['"arguments": {}}'.slice(0, 8)],
  },
  {
    name: 'a real answer that quotes config JSON is left alone',
    frames: [
      { t: 'delta', d: '配置项 "name": "value" 已经写在 .env 里，重启 sidecar 生效。' },
      { t: 'done' },
    ],
    want: ['重启 sidecar 生效'],
    avoid: ['写成了正文'],
  },
]

// Schema-repair retry: when the gateway rejects a malformed tool call before
// any tool executes, agent.js re-issues the turn once with a repair message
// instead of ending the run as "本次运行未完成".
const { withSchemaRepair, TOOLCALL_REJECTED, SCHEMA_REPAIR_NOTE } = require('./agent')

function testSchemaRepair() {
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: '审查这个文件' }],
    tools: ['sidecar__read-file', 'sidecar__shell'],
    model: 'chat',
  }))
  const fixed = JSON.parse(withSchemaRepair(body, 'parameters for tool x did not match schema').toString('utf8'))
  const checks = [
    ['keeps the original message', fixed.messages[0].content === '审查这个文件'],
    ['appends exactly one repair message', fixed.messages.length === 2 && fixed.messages[1].role === 'system'],
    ['repair note states the rejection', fixed.messages[1].content.includes('did not match schema')],
    ['tools array untouched', JSON.stringify(fixed.tools) === JSON.stringify(['sidecar__read-file', 'sidecar__shell'])],
    ['other fields preserved', fixed.model === 'chat'],
  ]
  const broken = Buffer.from('<html>not json</html>')
  checks.push(['unparsable body passes through untouched', withSchemaRepair(broken, 'x').equals(broken)])

  const detected = [
    "tool call validation failed: parameters for tool sidecar__analyze-dir did not match schema",
    "attempted to call tool 'side-items' which was not in request.tools",
  ].map((m) => TOOLCALL_REJECTED.test(m))
  checks.push(['detects both observed gateway rejections', detected.every(Boolean)])
  checks.push(['note tells the model not to invent tools', SCHEMA_REPAIR_NOTE('x').includes('不要臆造工具名')])

  let failed = 0
  for (const [name, ok] of checks) {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  schema-repair: ${name}`)
  }
  return failed
}

let failed = 0
for (const c of cases) {
  const answer = replay(c.frames)
  const missing = c.want.filter((w) => !answer.includes(w))
  const leaked = (c.avoid || []).filter((w) => answer.includes(w))
  const ok = !missing.length && !leaked.length
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) {
    console.log(`      answer: ${JSON.stringify(answer.slice(0, 200))}`)
    if (missing.length) console.log(`      missing: ${missing.join(', ')}`)
    if (leaked.length) console.log(`      leaked: ${leaked.join(', ')}`)
  }
}
const repairFailed = testSchemaRepair()
failed += repairFailed
console.log(`\n${cases.length + (repairFailed === 0 ? 7 : 7)} checks, ${failed} failed`)
process.exit(failed ? 1 : 0)
