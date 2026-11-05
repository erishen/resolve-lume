import type { JobRecord, UIMessage } from './types'

/** Max characters of any single text block written into an export. */
export const MAX_EXPORT_TEXT = 3000
/** Serialized tool arguments are kept shorter than result bodies. */
export const MAX_EXPORT_ARGS = 1000

/** Truncate oversized blocks so one huge tool result can't balloon a shared log. */
export function truncateForExport(s: string, limit = MAX_EXPORT_TEXT): string {
  return s.length > limit ? `${s.slice(0, limit)}\n…[截断 ${s.length - limit} 字符]` : s
}

/**
 * Remove local identity before a log is pasted into an issue / chat / blog.
 * Absolute paths are reduced to their last three segments (the same policy
 * jobToLog already used for `workspace`), and common credential shapes are
 * masked. Exports are meant to be shared — copying a full `/Users/<name>/...`
 * path or an API key out of a tool result is an easy privacy leak.
 */
export function redactForExport(s: string): string {
  // Keeping just the last 3 segments is NOT enough: a short path such as
  // `/Users/alice/notes.md` would still contain the account name. Drop the OS
  // prefix AND the account segment first, then cap the remaining tail.
  //
  // The last-3 rule alone still leaks the private workspace layout:
  // `/Users/<me>/Workspace/CNB/<my-repo>/frameworks/crewai-pse` collapses to
  // `…/<my-repo>/frameworks/crewai-pse` — and `<my-repo>` names the private
  // workspace the logs came from. So after taking the tail, drop its first
  // segment when that segment sits directly under a workspace-ish parent
  // (Workspace / CNB / code / repos / …): that segment is the workspace
  // ROOT, which is exactly the part a shared log must not carry.
  const WS_ROOT_PARENTS = new Set([
    'Workspace', 'workspace', 'CNB', 'cnblogs', 'code', 'Code', 'repos',
    'repositories', 'Projects', 'projects', 'src', 'dev', 'work',
  ])
  const collapse = (m: string, sep: '/' | '\\'): string => {
    const parts = m.split(sep === '/' ? '/' : /[\\/]/).filter(Boolean)
    const userIdx = parts.findIndex((p) => p === 'Users' || p === 'home')
    const tail = userIdx >= 0 ? parts.slice(userIdx + 2) : parts
    const shown = (tail.length ? tail : parts).slice(-3)
    // Index of shown[0] inside `parts`, so we can inspect its parent segment.
    const headIdx = parts.length - shown.length
    if (shown.length > 1 && headIdx > 0 && WS_ROOT_PARENTS.has(parts[headIdx - 1])) {
      return `…${sep}${shown.slice(1).join(sep)}`
    }
    return `…${sep}${shown.join(sep)}`
  }
  return s
    .replace(/\/(?:Users|home|workspace|work|tmp|var\/tmp)\/[^\s'"`)\],;]+/g, (m) =>
      collapse(m, '/'),
    )
    .replace(/[A-Za-z]:[\\/][^\s'"`)\],;]+/g, (m) => collapse(m, '\\'))
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '<redacted>',
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1<redacted>')
}

/** One entry point for everything that goes into an exported document. */
export function exportText(s: string, limit = MAX_EXPORT_TEXT): string {
  return truncateForExport(redactForExport(s), limit)
}

/**
 * JSON export of a conversation. Recursively sanitizes every string (including
 * tool arguments and results) — a raw `JSON.stringify(chat.messages)` used to
 * dump full tool output and host paths untouched.
 */
export function messagesToJson(messages: UIMessage[]): string {
  const sanitize = (v: unknown): unknown => {
    if (typeof v === 'string') return exportText(v)
    if (Array.isArray(v)) return v.map(sanitize)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, sanitize(val)]),
      )
    }
    return v
  }
  return JSON.stringify(sanitize(messages), null, 2)
}

/** Convert a conversation to Markdown for export / clipboard. */
export function messagesToMarkdown(messages: UIMessage[], title?: string): string {
  const lines: string[] = []
  if (title) lines.push(`# ${title}`, '')
  for (const m of messages) {
    const role = m.role === 'user' ? '👤 User' : '🤖 Assistant'
    lines.push(`## ${role}`, '')
    if (m.reasoning) {
      lines.push('> **Thinking**', '', `> ${exportText(m.reasoning).replace(/\n/g, '\n> ')}`, '')
    }
    if (m.content) {
      lines.push(exportText(m.content), '')
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const status =
          tc.decision === 'reject' ? '❌ rejected' : tc.result ? '✅ done' : '⏳ pending'
        lines.push(`**Tool:** \`${tc.name}\` — ${status}`, '')
        lines.push(
          '```json',
          exportText(JSON.stringify(tc.arguments, null, 2), MAX_EXPORT_ARGS),
          '```',
          '',
        )
        if (tc.result) {
          lines.push('**Result:**', '', '```', exportText(tc.result), '```', '')
        }
      }
    }
    lines.push('---', '')
  }
  return lines.join('\n')
}

/**
 * Format a SINGLE assistant message for clipboard copy — the full turn including
 * the model's reasoning, every tool call in order (name + args + result/error),
 * and the final answer text. Useful to paste a particular LLM answer with its
 * execution flow / error details into a bug report or notes.
 */
export function assistantToMarkdown(m: UIMessage): string {
  const lines: string[] = []
  lines.push(`## 🤖 Assistant`, '')
  if (m.reasoning) {
    lines.push('> **Thinking**', '', `> ${exportText(m.reasoning).replace(/\n/g, '\n> ')}`, '')
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    lines.push(`**执行流程 (${m.toolCalls.length} 个工具调用)**`, '')
    m.toolCalls.forEach((tc, i) => {
      const mark =
        tc.decision === 'reject'
          ? '❌ rejected'
          : tc.ok === false
            ? '❌ failed'
            : tc.result
              ? '✅ done'
              : '⏳ pending'
      const dur = tc.durationMs != null ? ` · ${tc.durationMs}ms` : ''
      lines.push(`### ${i + 1}. \`${tc.name}\` — ${mark}${dur}`, '')
      lines.push(
        '**参数：**',
        '',
        '```json',
        exportText(JSON.stringify(tc.arguments, null, 2), MAX_EXPORT_ARGS),
        '```',
        '',
      )
      if (tc.result) {
        lines.push(
          `**${tc.ok === false ? '错误' : '结果'}：**`,
          '',
          '```',
          exportText(tc.result),
          '```',
          '',
        )
      }
    })
  }
  if (m.content) {
    lines.push('**回答：**', '', exportText(m.content), '')
  }
  return lines.join('\n')
}

/** Trigger a browser download for text content. */
export function downloadText(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Copy text to clipboard, falling back to a textarea hack for older browsers. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      return true
    } catch {
      return false
    } finally {
      document.body.removeChild(ta)
    }
  }
}

/** Derive a safe filename from a session title. */
export function safeFilename(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'conversation'}.${ext}`
}

/**
 * Format a background job's record as a shareable diagnostic log.
 *
 * Success runs: only a compact tool-call/result summary is emitted (tool name
 * + ok/fail + duration), keeping the paste short and readable.
 * Failed / cancelled / error runs: full detail is included (args, result body,
 * error messages, final answer) so the diagnostic context is complete.
 *
 * Per-token `delta`/`reasoning` events duplicate the `step` text and are
 * skipped; oversized tool results are truncated to stay paste-friendly.
 */
export function jobToLog(job: JobRecord): string {
  const lines: string[] = []
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '-')
  const isProblem = job.status === 'failed' || job.status === 'cancelled' || !!job.error

  lines.push(`【任务】${truncateForExport(redactForExport(job.name), 200)}`)
  lines.push(`id: ${job.id} · 状态: ${job.status}`)
  lines.push(
    `时间: 创建 ${time(job.createdAt)} / 开始 ${time(job.startedAt)} / 结束 ${time(job.finishedAt)}`,
  )
  const extras: string[] = []
  if (job.taskId) extras.push(`任务模式: ${job.taskId}`)
  if (job.model) extras.push(`模型: ${job.model}`)
  if (job.workspace) extras.push(`工作区: ${truncateForExport(redactForExport(job.workspace), 200)}`)
  if (extras.length) lines.push(extras.join(' · '))
  if (job.usage) {
    lines.push(
      `用量: ${(job.usage.prompt + job.usage.completion).toLocaleString()} tok (prompt ${job.usage.prompt.toLocaleString()} / completion ${job.usage.completion.toLocaleString()}) · ¥${job.usage.cost.toFixed(4)}`,
    )
  }
  if (job.error) lines.push(`错误: ${exportText(job.error)}`)
  lines.push('')
  lines.push('--- 提示词 ---')
  lines.push(exportText(job.prompt))
  lines.push('')

  // Same truncation + redaction policy as the conversation exporters above;
  // previously this was the only call site with a (locally defined) limiter.
  const truncate = exportText

  if (isProblem) {
    // ---- failed / cancelled / error: full event dump ----
    lines.push(`--- 事件日志 (${job.events.length}) ---`)
    for (const ev of job.events) {
      switch (ev.type) {
        case 'step': {
          const text = (ev.step.message.content ?? '').trim()
          if (text) lines.push(`[${ev.seq}] step: ${exportText(text)}`)
          break
        }
        case 'tool-call': {
          lines.push(`[${ev.seq}] 调用: ${ev.call.name}`)
          lines.push(truncate(JSON.stringify(ev.call.arguments, null, 2), MAX_EXPORT_ARGS))
          break
        }
        case 'tool-result': {
          lines.push(`[${ev.seq}] 结果: ${ev.call.name} ${ev.ok ? '✓' : '✗'} ${ev.durationMs}ms`)
          lines.push(truncate(ev.result))
          break
        }
        case 'tool-progress':
          lines.push(`[${ev.seq}] 进度: ${exportText(ev.chunk)}`)
          break
        case 'approval-request':
          lines.push(`[${ev.seq}] 审批: ${ev.call.name}`)
          break
        case 'usage':
          lines.push(
            `[${ev.seq}] 用量: ${ev.record.model} prompt=${ev.record.promptTokens} completion=${ev.record.completionTokens} ¥${ev.record.cost.toFixed(4)}`,
          )
          break
        case 'done':
          lines.push(`[${ev.seq}] 完成: ${exportText(ev.answer)}`)
          break
        default:
          break
      }
    }
  } else {
    // ---- success: compact tool summary only ----
    const calls = job.events.filter((e) => e.type === 'tool-call')
    const results = new Map(
      job.events.filter((e) => e.type === 'tool-result').map((e) => [e.call.id, e]),
    )
    const done = job.events.find((e) => e.type === 'done')
    if (calls.length === 0) {
      lines.push('--- 执行摘要（未调用工具，模型仅回复） ---')
    } else {
      lines.push(`--- 执行摘要 (${calls.length} 步) ---`)
      for (const call of calls) {
        const r = results.get(call.call.id)
        const ok = r?.ok === false ? ' ✗' : ''
        const dur = r ? ` ${r.durationMs}ms` : ''
        lines.push(`• ${call.call.name}${ok}${dur}`)
        if (r && !r.ok) {
          lines.push(`  args: ${exportText(JSON.stringify(call.call.arguments), MAX_EXPORT_ARGS)}`)
          lines.push(`  error: ${exportText(r.result)}`)
        }
      }
    }
    // Prefer done event; fall back to the last step's text content (models
    // sometimes emit an empty string on `done` but carry the actual text
    // in the preceding step).
    const answer =
      done?.answer ||
      [...job.events]
        .reverse()
        .find((e) => e.type === 'step')
        ?.step.message.content?.trim() ||
      ''
    if (answer) lines.push('', exportText(answer))
  }
  return lines.join('\n')
}
