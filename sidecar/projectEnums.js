'use strict'
// Single source of truth for the `project` enums in builtin-tools.json.
//
// The four article-* tools used to carry hand-maintained enum lists. Adding a
// project to projects.json (article-discover does this on every scan) left the
// validators behind: the model then could not pass the new project name, or had
// to guess one, because the schema said it was invalid.
//
// Rule enforced here:
//   article-write          = exactly the projects queued in projects.json
//   article-validate/publish/archive
//                          = queued projects + historical projects that still
//                            have an article body on disk (legacy, resolve-lume…)
// Historical entries are only kept while their file exists, so an entry can
// never become a phantom the tools cannot act on.
//
// `node sidecar/projectEnums.js` rewrites the enums in place; the contract test
// fails when the file drifts, and points at `make sync-enums`.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PROJECTS = path.resolve(ROOT, '../../..', 'frameworks', 'crewai-pse',
  'tasks', 'project-articles', 'projects.json')
const ARTICLES_ROOT = path.resolve(ROOT, '../../..', 'personal', 'personal-site',
  'wordpress-tools', 'articles')
const SCHEMAS = path.join(ROOT, 'sidecar', 'builtin-tools.json')

/** Enums that must track projects.json; article-write is the write queue. */
const ENUM_TOOLS = ['article-write', 'article-validate', 'article-publish', 'article-archive']

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `resolve_lume-zh.md` -> `resolve-lume`: files use underscores and a lang suffix. */
function keyFromFilename(name) {
  const stem = String(name).replace(/\.md$/i, '').replace(/[-_](zh|en)$/i, '')
  const key = stem.replace(/_/g, '-')
  return KEY.test(key) ? key : ''
}

function articleKeys(root) {
  const out = new Set()
  for (const lang of ['zh', 'en']) {
    const dir = path.join(root, lang)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.md')) continue
      const key = keyFromFilename(n)
      if (key) out.add(key)
    }
  }
  return out
}

function liveProjects(projectsPath = PROJECTS) {
  return Object.keys(JSON.parse(fs.readFileSync(projectsPath, 'utf8')))
}

/**
 * @param {object} [opts]
 * @returns {{write: string[], extended: string[]}} sorted, deduped enum values
 */
function expectedEnums(opts = {}) {
  const live = (opts.live || liveProjects(opts.projectsPath)).slice().sort()
  const files = opts.articles || articleKeys(opts.articlesRoot || ARTICLES_ROOT)
  const current = opts.current || []
  const historical = [...new Set(current)]
    .filter((k) => !live.includes(k) && files.has(k))
    .sort()
  return {
    write: live,
    extended: [...new Set([...live, ...historical])].sort(),
  }
}

function currentEnums(schemas) {
  const out = {}
  for (const t of (schemas && schemas.tools) || []) {
    const p = t && t.parameters && t.parameters.properties && t.parameters.properties.project
    if (p && Array.isArray(p.enum)) out[t.name] = p.enum
  }
  return out
}

/** Rewrite the enum arrays in builtin-tools.json. Returns changed tool names. */
function sync(file = SCHEMAS) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const cur = currentEnums(doc)
  const target = expectedEnums({ current: Object.values(cur).flat() })
  const changed = []
  for (const name of ENUM_TOOLS) {
    const tool = (doc.tools || []).find((t) => t && t.name === name)
    if (!tool) continue
    const enumPath = tool.parameters.properties.project.enum
    const next = name === 'article-write' ? target.write : target.extended
    if (JSON.stringify(enumPath) !== JSON.stringify(next)) {
      tool.parameters.properties.project.enum = next
      changed.push(name)
    }
  }
  if (changed.length) fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return changed
}

module.exports = {
  ENUM_TOOLS, ARTICLE_PROJECTS: ARTICLES_ROOT, PROJECTS_PATH: PROJECTS, SCHEMAS_PATH: SCHEMAS,
  articleKeys, currentEnums, expectedEnums, keyFromFilename, liveProjects, sync,
}

if (require.main === module) {
  const changed = sync()
  if (!changed.length) console.log('[enums] project enums already match projects.json')
  else console.log(`[enums] synced: ${changed.join(', ')}`)
}
