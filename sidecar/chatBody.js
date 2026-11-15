'use strict'
// Pure request-shape translation for /api/chat. Kept out of server.js so the
// contract is unit-testable without starting the HTTP server (server.js has
// top-level listen() + MCP refresh side effects).
const { isContinuation, ordinalOf } = require('./taskMatch')

// Injected into EVERY chat run (task soul or not). The .lume bridge exposes 24
// tools spanning six unrelated business domains; without an explicit contract a
// free-tier model that hits one failed tool call tends to wander into a
// different pipeline and burn the whole 8-round budget (2026-11-06 incident:
// article-write failed -> hot-news x4 -> no answer).
const TOOL_DISCIPLINE = [
  '# 工具调用纪律（系统强制，优先级高于你自己的补救直觉）',
  '1. 一次用户请求只围绕一个工具族完成任务。工具失败后禁止切换到无关业务域的其它流水线“补救”。',
  '2. 工具返回 `tool error:` / `error:` 开头的结果时：如实向用户转达错误原因；最多改一次参数重试；严禁用完全相同的参数重复调用同一工具。',
  '3. 长跑工具（article-write / hot-news / pse-review / resume-tailor 等）一次请求最多调用一次；失败就报告，不要连跑。',
  '4. 用户回复清单编号（如 “7”）时，把编号原样传给对应工具的参数，不要自行翻译成项目名，也不要凭印象猜名字。',
  '5. 无论成功或失败，本轮必须输出面向用户的中文文字总结；不要在只有工具调用、没有正文的情况下结束。',
  '6. 工具成功时必须如实转达结论（项目名、产物路径、是否隔离/是否发布）；进度日志里的 DeprecationWarning、asyncio 提示等无害告警不是故障。严禁编造「出现了一个小问题」之类的安抚话术，严禁用「是否需要我…/请选择 1、2、3」代替结论。',
  '7. publish / 发布 / 上线这类有外部副作用的动作，只有用户在当前消息里明确写出「发布」「上线」「publish」时才允许置 true。用户只回复编号或项目名时一律省略该参数，不得自行决定发布。',
  '8. 转述工具结果时，文件名、目录、提交哈希、计数、金额必须逐字复制工具输出：不得改写、合并、张冠李戴，也不得补出输出里没有的条目。工具输出只给了一行摘要时，只转述这一行，不要自行扩写成「完整清单」。',
  '9. 队列驱动的发布工具（build-juejin / juejin-draft / juejin-publish / wechat-draft / sf-pw-publish）全部零参数、每次自动取 articles/juejin 里下一篇符合条件的本地稿：用户说「建下一篇草稿」时直接调用一次对应工具即可，严禁要求用户选项目或选文章、严禁传 project、严禁改用 article-write，也严禁用 read-file / shell / make 去找 Makefile 或脚本路径。当前口径「草稿=已发」（同公众号），建完草稿即视为已发，不要自动追加 juejin-publish；只有用户明确要求显式上线时才调用它。工具需人工审批时等待结果，不要重试或换工具。工具明确返回「队列为空」时如实转达「当前没有可处理的文章」并结束：严禁重试、严禁 --force、严禁改调其它工具补救，也不要让用户挑文章、不要在答复里复述工具名或建议用户「再试一次」；各平台未发清单里的「掘金 N 篇待办」是缺掘金本地稿/尚未发布的文章，不等于 N 篇待建草稿。',
  '10. 查「各平台未发清单 / 还有哪些文章没发 / 下一步该做什么」属于只读查询：只调用一次零参数的 publish-pending，严禁用 read-file / shell / make 自己扫 articles 目录，也严禁改用 article-write / article-publish。清单里列出的「下一步命令」是给用户看的说明、不是执行授权，严禁因此调用 juejin-draft / wechat-draft / sf-pw-publish 等写工具；这类查询只挂只读工具，不要凭名字拼造写工具。篇数、标题、命令必须逐字取自工具输出；提示数据快照滞后时如实转达，不要自行猜最新数量。',
  '11. 最终答案里严禁复述工具调用行或轮次标记（以工具名开头、后跟括号参数的整行，以及 round 轮次文字）：那是运行轨迹、不是给用户的内容，写进正文会被 ReAct 循环识别成新一轮工具调用，导致同一个工具被反复执行、回答迟迟不结束。工具只能通过结构化 tool call 发出；转述工具结果时只引用内容，不复述调用语句，也不要在答案里重列工具名加空参数。',
].join('\n')

// Explicit user consent for a side-effecting publish. Negations ("不要发布",
// "先别上线") must NOT be read as consent. Kept pure so the /api/tools/call
// guard can be unit-tested without an HTTP server.
function hasExplicitPublishIntent(message) {
  let s = String(message == null ? '' : message)
  s = s.replace(/(不|别|勿|暂|无需|不用|禁止|避免|先不|不要)\s*(要|用|会|急)?\s*(发布|上线|publish)[^，。！!?；;\n]*/gi, '')
  return /(发布|上线|publish|发到线上|推送到|post\s+to)/i.test(s)
}

// Explicit user consent for a PAID model run. pse-review defaults to the free
// router/free tier; provider="deepseek" costs money, so the bridge must not pick
// it on its own. Same negation-handling as publish: "别用付费模型" is not consent.
function hasExplicitPaidIntent(message) {
  let s = String(message == null ? '' : message)
  s = s.replace(/(不|别|勿|暂|无需|不用|禁止|避免|先不|不要)\s*(要|用|花|走|切)?\s*(钱|付费|收费|deepseek|paid)[^，。！!?；;\n]*/gi, '')
  return /(付费|收费|花钱|扣费|付费模型|deepseek|paid\s+model)/i.test(s)
}

/**
 * resolve-studio sends { messages, model, ... }; agent-httpd expects
 * { message, history }. The selected task's soul becomes the task-level system
 * prompt, the frontend-computed systemPrompt is appended after it, the compact
 * tool catalog sits right above the discipline block (it names every callable
 * tool so a small model stops guessing), and the tool discipline is always last
 * (most authoritative).
 *
 * `toolCatalog` is optional: server.js passes renderToolCatalog()'s output, the
 * tests pass a fixture or nothing.
 */
function buildAgentChatBody(body, task, toolCatalog) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const history = messages
    .filter((m) => m !== lastUser)
    .map((m) => ({ role: m.role, content: m.content }))
  const agentBody = {
    message: lastUser ? lastUser.content : '',
    history,
    model: typeof body.model === 'string' ? body.model : '',
  }
  // Carry the conversation id to agent-httpd. The C loop stamps it onto every
  // MCP tool call as "_lume_session", which is what lets the sidecar target the
  // right chat stream for approval prompts and progress frames even when two
  // conversations run at once. Dropping it here silently downgrades the gate to
  // "newest stream wins" (2026-11-09).
  if (typeof body.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.sessionId)) {
    agentBody.sessionId = body.sessionId
  }
  const parts = []
  if (task && task.systemPrompt) parts.push(task.systemPrompt)
  if (typeof body.systemPrompt === 'string' && body.systemPrompt) {
    parts.push(body.systemPrompt)
  }
  if (typeof toolCatalog === 'string' && toolCatalog.trim()) {
    parts.push(toolCatalog.trim())
  }
  // A bare ordinal turn carries no intent words of its own. State outright what
  // it selects, otherwise a small model re-runs the lister that produced the
  // numbering (2026-11-15: "6" -> article-discover again, no article).
  if (task && lastUser && isContinuation(lastUser.content)) {
    const n = ordinalOf(lastUser.content)
    const pick = n == null ? '上一轮候选清单中的那一项' : `上一轮候选清单的第 ${n} 项`
    parts.push(
      '# 本轮是清单选择\n' +
        `用户本轮只回复了「${String(lastUser.content).trim()}」，指向${pick}。\n` +
        '请直接调用处理该选项的工具，并把编号原样传给对应参数（工具会解析成同一份清单的第 N 项）；' +
        '不要重新调用生成清单的工具，不要再次列出候选，也不要把编号自行翻译成名称（编号与字母序枚举并非同一套顺序）。',
    )
  }
  parts.push(TOOL_DISCIPLINE)
  agentBody.system = parts.join('\n\n---\n\n')
  // Optional per-task tool allow-list (frontmatter `tools:`); absent/empty =
  // expose all registered tools (resolve-studio's "no scope filter" fallback).
  if (task && task.includeTools && task.includeTools.length) {
    agentBody.tools = task.includeTools
  }
  return agentBody
}

module.exports = { buildAgentChatBody, TOOL_DISCIPLINE, hasExplicitPublishIntent, hasExplicitPaidIntent }
