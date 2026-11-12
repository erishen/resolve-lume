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

// /react/api/tools reports `sidecar__*` with an EMPTY `desc` (agent-httpd only
// carries the name there), while the authoritative Chinese descriptions live in
// builtin-tools.json. 56 chars was also too short to survive the "⚠️ 每次调用…
// 自动建队列中的下一篇" clause, which is the ONLY thing that tells a small model
// it must not ask the user to pick a project. Both were live failure modes on
// 2026-11-12 ("建掘金草稿" -> article-write candidate list).
const DEFAULT_DESC = 96
const DEFAULT_MAX = 140

// Reconcile the two description sources. /react/api/tools carries a terse
// ENGLISH `desc` from the generated lume-tools bridge (DESC_OVERRIDE, written
// for the C-side size budget), while builtin-tools.json holds the authoritative
// Chinese contract wording that the UI also shows. The bridge text used to say
// "Does NOT publish: use juejin-publish" — the exact opposite of the product's
// "draft=published" convention — so for sidecar__* the authoritative text MUST
// win, not merely fill an empty slot. Pure so it is testable without HTTP.
function enrichToolDescriptions(tools, byName) {
  const lookup = byName instanceof Map ? byName : new Map(Object.entries(byName || {}))
  return (Array.isArray(tools) ? tools : []).map((t) => {
    if (!t || typeof t.name !== 'string') return t
    const bare = t.name.replace(/^sidecar__/, '')
    const authoritative = String(lookup.get(bare) || lookup.get(t.name) || '')
    if (/^sidecar__/.test(t.name) && authoritative) {
      return { ...t, description: authoritative, desc: authoritative }
    }
    const existing = String(t.description || t.desc || '').trim()
    return existing ? { ...t, description: existing } : t
  })
}

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
      const desc = cleanDesc(t.description || t.desc, descMax)
      lines.push(desc ? `- ${t.name} — ${desc}` : `- ${t.name}`)
    }
  }
  if (list.length > shown.length) {
    lines.push('', `（另有 ${list.length - shown.length} 个工具未列出；按需用 capabilities 查询。）`)
  }
  return lines.join('\n')
}

module.exports = { renderToolCatalog, groupOf, cleanDesc, enrichToolDescriptions, DEFAULT_DESC }
