'use strict'
// Compact tool catalog injected into the chat system prompt.
//
// Why: lume-core stores tool descriptions in `ToolRec.desc` (widened to 1024 B
// on 2026-11-09, previously 160 B), and the generator caps each at 900 B. With 99
// registered tools the model sees 99 near-identical one-liners and, when two
// names look alike (juejin-draft / juejin-publish, shell / make), guesses wrong
// or invents a name that does not exist (2026-11-09: same prompt produced a
// correct `sidecar__shell` call in one session and an invented `execute_code`
// in another). resolve-studio avoids this by shipping full descriptions; here
// the equivalent is a compact catalog (exact name + one line) plus an explicit
// "only these names exist" rule, which is far cheaper in tokens than 99 full
// schemas.
//
// The catalog never *narrows* the surface: every tool stays callable, it only
// makes the choice legible. Pure function so it is unit-testable.

const DEFAULT_DESC = 56
const DEFAULT_MAX = 140

function cleanDesc(s, maxLen) {
  const one = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
  if (!one) return ''
  if (one.length <= maxLen) return one
  return one.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…'
}

// Group by the server prefix so 99 lines stay scannable:
//   sidecar__shell      -> "sidecar"
//   fs:read_file        -> "fs"
//   mcp-fs__read_file   -> "mcp-fs"
function groupOf(name) {
  const s = String(name || '')
  const dunder = s.indexOf('__')
  if (dunder > 0) return s.slice(0, dunder)
  const colon = s.indexOf(':')
  if (colon > 0) return s.slice(0, colon)
  return 'builtin'
}

function renderToolCatalog(tools, opts) {
  const o = opts || {}
  const descMax = Number.isFinite(o.descMax) ? o.descMax : DEFAULT_DESC
  const max = Number.isFinite(o.max) ? o.max : DEFAULT_MAX
  const list = (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!list.length) return ''
  const shown = list.slice(0, max)
  const groups = new Map()
  for (const t of shown) {
    const g = groupOf(t.name)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(t)
  }
  const lines = [
    '# 可用工具目录（exact names）',
    '下面就是全部可调用工具的**准确名字**。调用清单外的名字会直接失败（`error: unknown tool`），严禁凭印象拼造；' +
      '清单里没有你需要的能力时，如实告知用户该能力未开放，不要换成一个“差不多”的工具硬跑。',
  ]
  for (const [g, items] of groups) {
    lines.push('', `## ${g}`)
    for (const t of items) {
      const desc = cleanDesc(t.description, descMax)
      lines.push(desc ? `- ${t.name} — ${desc}` : `- ${t.name}`)
    }
  }
  if (list.length > shown.length) {
    lines.push('', `（另有 ${list.length - shown.length} 个工具未列出；按需用 capabilities 查询。）`)
  }
  return lines.join('\n')
}

module.exports = { renderToolCatalog, groupOf, cleanDesc }
