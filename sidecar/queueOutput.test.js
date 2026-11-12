'use strict'
// 2026-11-12: the queue scripts print one "==== 文件 / 标题 / ⏭ 跳过" block
// per article (56 of them) before acting on a single one. The full trace made
// the model answer "没有未建草稿的文章可供再创建" right after the draft had
// been created (juejin_draft_id written back). Pin the summary contract.
//
// Second incident, same day: make juejin-draft prints `✅ 全部已发布，无需操作。`
// (publish-juejin.mjs:473) when every candidate is skipped. The old filter
// dropped that verdict (it shared a block with a ⏭ line) and appended 2 KB of
// raw skips. The model then invented "56 skipped but 3 drafts still pending",
// called four more tools and asked the user whether to retry with --force.
// Both the real script wording and the success/empty distinction are pinned.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { summarizeQueueOutput, QUEUE_TASKS, QUEUE_EMPTY_MARKER } = require('./queueOutput')

const cases = []
function test(name, fn) { cases.push([name, fn]) }

function skipped(i) {
  const why = i % 2
    ? '已发布过 (juejin_id=7681177765547163686)，跳过（加 --force 可重发）'
    : '已有草稿 (juejin_draft_id=7701710876076998692)，跳过去建下一篇未建草稿的'
  return `====================\n文件 : article_${i}-zh.md\n标题 : 标题 ${i}\n  ⏭ ${why}`
}
const SKIPS = Array.from({ length: 56 }, (_, i) => skipped(i)).join('\n')

test('drops skipped blocks but keeps the created-draft conclusion', () => {
  const raw = SKIPS +
    '\n====================\n文件 : resolve_lume-zh.md\n标题 : resolve-lume\n' +
    '  ✅ 草稿 draft_id = 7706829850124550163\n' +
    '  📝 已记录 juejin_draft_id=7706829850124550163 到 resolve_lume-zh.md\n' +
    '   剩余未建草稿 0 篇 → 再跑一次继续下一篇。'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.doesNotMatch(out, /⏭/, 'skip lines must not reach the model')
  assert.match(out, /草稿 draft_id = 7706829850124550163/)
  assert.match(out, /已记录 juejin_draft_id/)
  assert.match(out, /剩余未建草稿 0 篇/)
  assert.match(out, /resolve_lume-zh\.md/)
  assert.doesNotMatch(out, /\[QUEUE_EMPTY\]/, 'a created draft is NOT an empty queue')
  assert.ok(out.length < 1500, `summary is still ${out.length} chars`)
})

// `剩余未建草稿 0 篇` is printed after a SUCCESSFUL run too. Never let it turn
// a real draft creation into "nothing to do".
test('剩余 0 篇 after real work is still reported as success', () => {
  const raw = '====================\n文件 : a-zh.md\n标题 : A\n' +
    '  ✅ 草稿 draft_id = 12345\n\n✅ 本次处理 1 篇（草稿）。\n   剩余未建草稿 0 篇 → 再跑一次继续下一篇。'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.match(out, /草稿 draft_id = 12345/)
  assert.match(out, /剩余未建草稿 0 篇/)
  assert.doesNotMatch(out, /\[QUEUE_EMPTY\]/)
})

test('the real empty-queue verdict is promoted, not buried in raw skips', () => {
  // Exactly what `make juejin-draft` prints when all 56 candidates have an id.
  const raw = SKIPS + '\n\n⏭ 56 篇已发布，跳过（--force 可重发）。\n✅ 全部已发布，无需操作。'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.match(out, new RegExp(QUEUE_EMPTY_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.match(out, /队列为空/)
  assert.match(out, /口径说明/)
  assert.match(out, /不等于「N 篇待建草稿」/)
  assert.match(out, /不要加 --force/)
  assert.match(out, /不要用相同参数重试/)
  assert.doesNotMatch(out, /⏭/, 'no raw skip trace may reach the model')
  assert.doesNotMatch(out, /原始输出尾部/)
  assert.ok(out.length < 1600, `empty-queue answer is ${out.length} chars`)
})

test('an unrecognised no-work output is also treated as an empty queue', () => {
  const out = summarizeQueueOutput('掘金草稿', SKIPS)
  assert.match(out, /队列为空/)
  assert.doesNotMatch(out, /原始输出尾部/)
})

test('a real failure is never filtered into an empty cheerful summary', () => {
  const raw = SKIPS + '\nerror: cookie 已失效，请先登录'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.match(out, /error: cookie 已失效/)
  assert.match(out, /原始输出尾部/)
  assert.doesNotMatch(out, /\[QUEUE_EMPTY\]/)
})

test('the live pending snapshot is attached to an empty queue answer', () => {
  const raw = SKIPS + '\n✅ 全部已发布，无需操作。'
  const line = '当前未发清单快照：掘金待办 3 篇（可直接建草稿 0 篇 · 缺本地稿/未归档 3 篇）。'
  const out = summarizeQueueOutput('掘金草稿', raw, line)
  assert.match(out, /当前未发清单快照/)
  assert.match(out, /缺本地稿\/未归档 3 篇/)
  assert.match(out, /不要建议用户重试或再次调用本工具/)
  assert.doesNotMatch(out, /原始输出尾部/)
})

test('build-juejin empty verdict is promoted (重建 0 篇，新建(seed) 0 篇)', () => {
  // build-juejin-from-zh.mjs prints this when every zh article already has a
  // juejin copy. It must NOT be mistaken for "did work" or handed raw lines.
  const raw = '✅ juejin 处理完成：重建 0 篇，新建(seed) 0 篇'
  const out = summarizeQueueOutput('掘金建稿', raw)
  assert.match(out, new RegExp(QUEUE_EMPTY_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.match(out, /队列为空/)
  assert.match(out, /不等于「N 篇待建草稿」/)
  assert.doesNotMatch(out, /原始输出尾部/)
})

test('wechat-draft empty verdict is promoted (没有待发布的草稿)', () => {
  // publish-wechat.mjs prints this when every wechat article already has a draft.
  const raw = '✅ 没有待发布的草稿（全部已有 wechat_draft_id）。用 --force 可重建设。'
  const out = summarizeQueueOutput('微信草稿', raw)
  assert.match(out, new RegExp(QUEUE_EMPTY_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.match(out, /队列为空/)
  assert.doesNotMatch(out, /原始输出尾部/)
})

test('build-juejin with real work is NOT an empty queue', () => {
  // rebuilt=3 must bypass EMPTY_VERDICT even though seeded=0.
  const raw = '[build] x.md: ...\n✅ juejin 处理完成：重建 3 篇，新建(seed) 0 篇'
  const out = summarizeQueueOutput('掘金建稿', raw)
  assert.doesNotMatch(out, /\[QUEUE_EMPTY\]/)
  assert.match(out, /重建 3 篇/)
})

test('build-juejin with pure seeding is NOT an empty queue', () => {
  // seeded=2 is real work; only BOTH counters being 0 means empty.
  const raw = '[seed] y.md: 新建 juejin 版\n✅ juejin 处理完成：重建 0 篇，新建(seed) 2 篇'
  const out = summarizeQueueOutput('掘金建稿', raw)
  assert.doesNotMatch(out, /\[QUEUE_EMPTY\]/)
  assert.match(out, /新建\(seed\) 2 篇/)
})

test('an empty queue never re-runs the life-dash generator', () => {  // No id was written back, so resyncPendingList would only rewrite the user's
  // articlePublish.{json,ts} for no reason. Pin the early return.
  const src = fs.readFileSync(path.join(__dirname, 'business-publish.js'), 'utf8')
  assert.match(src, /if \(summary\.includes\(QUEUE_EMPTY_MARKER\)\) return summary/)
  assert.match(src, /summarizeQueueOutput\(label, combined, pendingHeadline\(\)\)/)
})

test('the marker is stable and ASCII (toolGuard matches it literally)', () => {
  assert.equal(QUEUE_EMPTY_MARKER, '[QUEUE_EMPTY]')
})

test('exactly the five queue-driven targets are summarised', () => {
  assert.deepEqual([...QUEUE_TASKS].sort(), [
    'build-juejin', 'juejin-draft', 'juejin-publish', 'sf-pw-publish', 'wechat-draft',
  ])
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
