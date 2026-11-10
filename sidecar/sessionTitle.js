'use strict'
// Session title derivation (server-side single source of truth).
//
// The left rail used to show the first 40 characters of the opening message, so
// "帮我做一份深度投资组合分析，用 autogen-pse 的 …" was the label. Deriving it
// here instead means: old rows and new rows render the same, no client/server
// drift, and a reload is enough to fix titles already stored in SQLite.
//
// Order of preference:
//   1. the pinned task's display name (taskMode is a real task id)
//   2. the task the opening message auto-matches (same matcher as the chat path)
//   3. a one-line slice of the opening message, else the stored title
const { taskCopy } = require('./taskCopy')
const { matchTaskByMessage } = require('./taskMatch')

/** Character budget for the no-task fallback. */
const SESSION_TITLE_MAX = 20

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
 * @param {object} rec   stored/live session record {title, taskMode, messages}
 * @param {Array}  tasks task catalog from buildTasks() (id + name + triggers)
 */
function sessionTitle(rec, tasks) {
  const r = rec || {}
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
