'use strict'
// Intent -> task matching, mirroring resolve-studio's
// `tasks.resolve(taskId, messages)` auto path: when the caller did not force a
// taskId, the run narrows to the business task whose `triggers` match the latest
// user message. Pure so it can be unit-tested without the HTTP server.

function matchTaskByMessage(message, tasks) {
  const s = String(message == null ? '' : message).toLowerCase()
  if (!s.trim()) return undefined
  let best
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.id === 'general' || !t.triggers) continue
    const words = String(t.triggers)
      .split(/[,，]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
    const hits = words.filter((w) => s.includes(w)).length
    if (!hits) continue
    if (!best || hits > best.hits) best = { task: t, hits }
  }
  return best && best.task
}

module.exports = { matchTaskByMessage }
