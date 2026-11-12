'use strict'
// Summarise the output of queue-driven publishing make targets.
//
// publish-juejin.mjs / publish-wechat.mjs walk the WHOLE article set before
// acting on one article, printing a "==== 文件 / 标题 / ⏭ 跳过" block for every
// article they pass. With 56 articles that is tens of KB of "已发布过 / 已有
// 草稿，跳过" lines, with the single "✅ 草稿 draft_id / 📝 已记录 / 剩余 N 篇"
// conclusion at the very end. On 2026-11-12 the model read the skips as the
// result and told the user "没有未建草稿的文章可供再创建" immediately AFTER
// the draft had been created successfully (draft_id written back).
//
// Kept separate from business-publish.js because builtin-exec.js does
// `Object.assign(LOCAL, BUSINESS)`: extra exports there would land in the tool
// dispatch map.
const H = require('./business-helpers')

const QUEUE_TASKS = new Set([
  'build-juejin', 'juejin-draft', 'juejin-publish', 'wechat-draft', 'sf-pw-publish',
])

function summarizeQueueOutput(name, raw) {
  const text = String(raw || '')
  const blocks = text
    .split(/^\s*={6,}\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b && !/⏭/.test(b))
  const status = text.split(/\r?\n/).filter((l) => /剩余|没有待发布/.test(l))
  const body = [...blocks, ...status].filter(Boolean).join('\n')
  const failure = /error:|失败|Exception|Traceback|登录态|未登录/i.test(text)
  // Never let the filter turn a real failure into a cheerful empty summary.
  const tail = failure || !body.trim()
    ? '\n\n--- 原始输出尾部 ---\n' + H.truncateToTail(text, 2000)
    : ''
  return (
    `> ${name} 完成（已省略队列里「已发布 / 已有草稿」的跳过日志）\n\n` +
    H.truncate(body + tail, 8000)
  )
}

module.exports = { summarizeQueueOutput, QUEUE_TASKS }
