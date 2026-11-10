'use strict'
// Session title derivation (server-side single source of truth).
//
// The left rail used to show the first 40 characters of the opening message, so
// "帮我做一份深度投资组合分析，用 autogen-pse 的 …" was the label. Deriving it
// here instead means: old rows and new rows render the same, no client/server
// drift, and a reload is enough to fix titles already stored in SQLite.
//
// Order of preference:
//   1. what the session actually did — the last action-bearing tool it called
//      (a session that archived an article reads "归档文章", not the broad soul
//      name the opening message happens to match)
//   2. the pinned task's display name (taskMode is a real task id)
//   3. the task the opening message auto-matches (same matcher as the chat path)
//   4. a one-line slice of the opening message, else the stored title
const { taskCopy } = require('./taskCopy')
const { matchTaskByMessage } = require('./taskMatch')

/** Character budget for the no-task fallback. */
const SESSION_TITLE_MAX = 20

// Tool name -> what the rail should say. Only outcome-bearing tools belong here:
// read-file/shell/skill-run would say nothing about the session's purpose.
const ACTION_TITLES = {
  'article-write': '撰写文章',
  'article-archive': '归档文章',
  'article-publish': '发布文章',
  'article-validate': '校验文章',
  'article-discover': '发现新项目',
  'build-juejin': '掘金建稿',
  'juejin-draft': '掘金草稿',
  'juejin-publish': '掘金发布',
  'wechat-draft': '微信草稿',
  'sf-pw-publish': '思否发布',
  'privacy-audit': '隐私审计',
  'portfolio-check': '持仓体检',
  'stock-scan': '选股扫描',
  'resume-tailor': '简历定制',
  'interview-questions': '面试题',
  'pse-review': 'PSE 评审',
  'pse-review-latest': 'PSE 评审',
  'hot-news': '热点文案',
  'dev-stats': '开发统计',
}

/** Project keys only — a positional number is meaningless in a title. */
const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function oneLine(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Single-line slice, used for every no-task fallback. */
function shortTitle(text) {
  const t = oneLine(text)
  if (!t) return 'Untitled'
  return t.length > SESSION_TITLE_MAX ? `${t.slice(0, SESSION_TITLE_MAX)}…` : t
}

function firstUserText(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content
    }
  }
  return ''
}

/** Pinned task name, from the live catalog first (it carries taskCopy already). */
function pinnedTaskName(taskMode, tasks) {
  if (!taskMode || taskMode === 'auto') return ''
  const hit = (Array.isArray(tasks) ? tasks : []).find((t) => t && t.id === taskMode)
  if (hit && hit.name) return oneLine(hit.name)
  const copy = taskCopy(taskMode)
  return copy && copy.name ? oneLine(copy.name) : ''
}

/**
 * Positional projects ("7") are what the model actually passes after it prints
 * a numbered list of candidates. The list it printed lives in an earlier
 * message of the SAME session, so the number can be resolved against the
 * choices the user saw — never against today's projects.json, which renumbers
 * whenever a project is added or archived.
 */
const ENUM_ENTRY = /(\d{1,2})\s*[.、)]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g

function enumeratedSubject(num, messages, beforeIndex) {
  let hit = ''
  for (let i = 0; i < beforeIndex; i++) {
    const text = typeof messages[i].content === 'string' ? messages[i].content : ''
    if (!text) continue
    const re = new RegExp(ENUM_ENTRY.source, 'g')
    let m
    let found = ''
    while ((m = re.exec(text)) !== null) {
      if (m[1] === String(num) && PROJECT_KEY.test(m[2])) found = m[2]
    }
    if (found) hit = found
  }
  return hit
}

/**
 * What the session actually did: the LAST outcome-bearing tool it called.
 * Read from the recorded tool calls rather than guessed from the prompt — the
 * prompt only tells us which soul it matches, and "archived an article" and
 * "wrote an article" share the same soul.
 */
function actionTitle(messages) {
  let last = null
  let lastIndex = -1
  const list = Array.isArray(messages) ? messages : []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const calls = m && (m.toolCalls || m.tool_calls)
    if (!Array.isArray(calls)) continue
    for (const c of calls) {
      if (c && ACTION_TITLES[c.name]) {
        last = c
        lastIndex = i
      }
    }
  }
  if (!last) return ''
  const label = ACTION_TITLES[last.name]
  const args = last.arguments || last.args || {}
  const raw = typeof args.project === 'string' ? args.project.trim() : ''
  // A numeric project is a position in a list that may already have changed;
  // it must never end up in the rail as "· 7". Resolve it against the list the
  // model printed earlier in this session, else drop the subject entirely.
  let subject = ''
  if (raw && PROJECT_KEY.test(raw) && !/^\d+$/.test(raw)) subject = raw
  else if (/^\d+$/.test(raw)) subject = enumeratedSubject(raw, list, lastIndex)
  return shortTitle(subject ? `${label} · ${subject}` : label)
}

/**
 * @param {object} rec   stored/live session record {title, taskMode, messages}
 * @param {Array}  tasks task catalog from buildTasks() (id + name + triggers)
 */
function sessionTitle(rec, tasks) {
  const r = rec || {}

  const action = actionTitle(r.messages)
  if (action) return action

  const pinned = pinnedTaskName(r.taskMode, tasks)
  if (pinned) return pinned

  const first = oneLine(firstUserText(r.messages))
  // Only let the matcher speak for sessions that were never pinned to a task;
  // a pinned id we cannot resolve should not be replaced by a guessed task.
  if ((r.taskMode === 'auto' || !r.taskMode) && first) {
    const matched = matchTaskByMessage(first, tasks)
    if (matched && matched.name) return oneLine(matched.name)
  }
  return shortTitle(first || r.title)
}

module.exports = { sessionTitle, shortTitle, SESSION_TITLE_MAX }
