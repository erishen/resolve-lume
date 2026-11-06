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
]

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
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
