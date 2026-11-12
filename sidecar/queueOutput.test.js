'use strict'
// 2026-11-12: the queue scripts print one "==== 文件 / 标题 / ⏭ 跳过" block
// per article (56 of them) before acting on a single one. The full trace made
// the model answer "没有未建草稿的文章可供再创建" right after the draft had
// been created (juejin_draft_id written back). Pin the summary contract.
const assert = require('node:assert/strict')
const { summarizeQueueOutput, QUEUE_TASKS } = require('./queueOutput')

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
  assert.ok(out.length < 1500, `summary is still ${out.length} chars`)
})

test('keeps the "nothing pending" verdict when every block is a skip', () => {
  const raw = SKIPS + '\n没有待发布（全部已有 juejin_draft_id）\n   剩余未建草稿 0 篇'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.doesNotMatch(out, /⏭/)
  assert.match(out, /没有待发布/)
  assert.match(out, /剩余未建草稿 0 篇/)
})

test('a real failure is never filtered into an empty cheerful summary', () => {
  const raw = SKIPS + '\nerror: cookie 已失效，请先登录'
  const out = summarizeQueueOutput('掘金草稿', raw)
  assert.match(out, /error: cookie 已失效/)
  assert.match(out, /原始输出尾部/)
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
