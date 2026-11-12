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
// Second incident, same day: when EVERY candidate is skipped, the script prints
// `✅ 全部已发布，无需操作。` (publish-juejin.mjs:473). The original filter only
// kept lines matching 剩余/没有待发布 and dropped the whole trailing block
// because it also contained a `⏭` line — so the authoritative verdict was lost
// and the raw skip trace was appended instead. The model then invented a
// hybrid story ("skipped 56, but 3 drafts still pending"), called capabilities,
// build-juejin and juejin-draft four more times, and asked the user whether to
// retry with --force. See QUEUE_EMPTY_MARKER / the empty-queue branch below.
//
// Kept separate from business-publish.js because builtin-exec.js does
// `Object.assign(LOCAL, BUSINESS)`: extra exports there would land in the tool
// dispatch map.
const H = require('./business-helpers')

const QUEUE_TASKS = new Set([
  'build-juejin', 'juejin-draft', 'juejin-publish', 'wechat-draft', 'sf-pw-publish',
])

// Stable, machine-readable marker. toolGuard reads it to refuse a byte-identical
// retry of an empty queue (the call succeeded, so the failure-only guard misses
// it). Keep it ASCII and unique — it is NOT a user-facing command.
const QUEUE_EMPTY_MARKER = '[QUEUE_EMPTY]'

// Verdicts the host make targets actually print. `剩余未建草稿 0 篇` is NOT one
// of them: the same line is printed after a SUCCESSFUL one-article run.
const EMPTY_VERDICT = /全部已发布，无需操作|没有待发布（全部已有|没有待发布\(all|nothing (?:left|to publish)|no unpublished/i
// Positive proof that real work happened. Skip blocks mention juejin_draft_id
// too, so only the ✅/📝 result lines count.
const DID_WORK = /✅\s*本次处理\s*[1-9]|📝\s*已记录|✅\s*草稿 draft_id\s*=/

function emptyQueueResult(name, pendingLine = '') {
  const lines = [
    `> ${QUEUE_EMPTY_MARKER} ${name} 完成：队列为空，本轮没有可处理的文章。`,
    '',
    `结论：${name} 扫描了全部候选，每一篇都已有平台 id（juejin_draft_id / juejin_id 等），因此没有处理任何一篇。这不是漏选了「下一篇」，也不是需要重试的故障。`,
    '',
  ]
  if (pendingLine) lines.push(`> ${pendingLine}`, '')
  lines.push(
    '⚠️ 口径说明：各平台未发清单里的「掘金 N 篇待办」统计的是「还没有掘金本地稿 / 尚未发布」的文章，不等于「N 篇待建草稿」。仍留在 pse/zh、或只有 zh 源稿的文章不在本工具的候选集里，重复调用本工具不会改变结果。',
    '',
    '下一步（供用户参考，本轮不要执行）：先为 articles/zh 里有源但缺掘金版 md 的文章生成掘金本地稿，或按清单把仍留在 pse/zh 的稿先发布+归档；之后队列里才会出现可建草稿的候选。在此之前不要建议用户重试或再次调用本工具。',
    '',
    '— 工具结果到此结束：不要用相同参数重试、不要加 --force、不要改用其它工具「补救」，不要让用户挑选文章，也不要在答案里复述工具名或建议用户「再试一次」。直接把上述结论用中文转达用户并结束本轮。',
  )
  return lines.join('\n')
}

function summarizeQueueOutput(name, raw, pendingLine = '') {
  const text = String(raw || '')
  const failure = /error:|失败|Exception|Traceback|登录态|未登录/i.test(text)
  // Failures must never be filtered into a cheerful summary.
  if (failure) {
    return `> ${name} 执行未成功\n\n--- 原始输出尾部 ---\n` + H.truncateToTail(text, 2000)
  }

  const didWork = DID_WORK.test(text)
  const emptyQueue = !didWork && EMPTY_VERDICT.test(text)
  // The second incident in full: no work, no recognised verdict, and no
  // surviving block. Treat it as an empty queue rather than handing the model
  // 2 KB of raw skip lines to hallucinate over.
  const blocks = text
    .split(/^\s*={6,}\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b && !/⏭/.test(b))
  const status = text.split(/\r?\n/).filter((l) => /剩余|没有待发布/.test(l))
  const body = [...blocks, ...status].filter(Boolean).join('\n')
  if (emptyQueue || !body.trim()) return emptyQueueResult(name, pendingLine)

  return (
    `> ${name} 完成（已省略队列里「已发布 / 已有草稿」的跳过日志）\n\n` +
    H.truncate(body, 8000)
  )
}

module.exports = { summarizeQueueOutput, QUEUE_TASKS, QUEUE_EMPTY_MARKER }
