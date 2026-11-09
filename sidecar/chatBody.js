'use strict'
// Pure request-shape translation for /api/chat. Kept out of server.js so the
// contract is unit-testable without starting the HTTP server (server.js has
// top-level listen() + MCP refresh side effects).

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
 * prompt, the frontend-computed systemPrompt is appended after it, and the
 * tool discipline is always last (most authoritative).
 */
function buildAgentChatBody(body, task) {
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
  const parts = []
  if (task && task.systemPrompt) parts.push(task.systemPrompt)
  if (typeof body.systemPrompt === 'string' && body.systemPrompt) {
    parts.push(body.systemPrompt)
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
