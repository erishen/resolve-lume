'use strict'
// `/api/skills` catalog for the frontend example cards.
//
// The old implementation lived inline in server.js and picked "the first
// non-empty, non-# line" of SOUL.md as the description. Every business soul
// starts with YAML frontmatter, so that line was literally `---`: all 17 skill
// cards fell through to generic regex-based prompts ("完成文章相关的操作
// （写文章、发布、评论等）"), which auto-matched the WRONG task for 6 of them.
// With the C-side allow-list now a hard execution boundary, a card routed to
// another soul has its real tools refused at dispatch time.
//
// Keep the parser here (pure, no server state) so it can be unit-tested against
// synthetic souls instead of only against whatever /api/skills happens to return.
const fs = require('fs')
const path = require('path')
const { taskCopy } = require('./taskCopy')

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/** Description for one SOUL.md. Frontmatter wins; plain markdown keeps the
 * historical "first prose line" behaviour used by the PSE role souls. */
function soulDescription(text) {
  const src = String(text || '')
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  let body = src
  if (fm) {
    for (const raw of fm[1].split(/\r?\n/)) {
      const idx = raw.indexOf(':')
      if (idx <= 0 || raw.slice(0, idx).trim() !== 'description') continue
      const val = unquote(raw.slice(idx + 1).trim())
      if (val) return val
    }
    body = src.slice(fm[0].length)
  }
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && l !== '---')
  return line || ''
}

/** Business-facing card title. taskCopy.js is the single source of truth for
 * Chinese task names; frontmatter `name:` is the fallback for souls that are
 * not in the studio registry yet. */
function soulTitle(text, id) {
  const copy = taskCopy(id)
  if (copy && copy.name) return copy.name
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fm) {
    for (const raw of fm[1].split(/\r?\n/)) {
      const idx = raw.indexOf(':')
      if (idx > 0 && raw.slice(0, idx).trim() === 'name') {
        const val = unquote(raw.slice(idx + 1).trim())
        if (val && val !== id) return val
      }
    }
  }
  return id
}

function scanSkills(soulsDir) {
  const out = []
  let names
  try {
    names = fs.readdirSync(soulsDir)
  } catch {
    return out
  }
  for (const name of names) {
    let txt
    try {
      txt = fs.readFileSync(path.join(soulsDir, name, 'SOUL.md'), 'utf8')
    } catch {
      continue
    }
    out.push({
      name,
      title: soulTitle(txt, name),
      description: soulDescription(txt),
    })
  }
  return out
}

module.exports = { scanSkills, soulDescription, soulTitle }
