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
    let hits = 0
    let chars = 0
    for (const w of words) {
      if (!s.includes(w)) continue
      hits += 1
      chars += w.length // a longer keyword is the more specific signal
    }
    if (!hits) continue
    const score = hits * 100 + chars
    if (!best || score > best.score) best = { task: t, score }
  }
  return best && best.task
}

module.exports = { matchTaskByMessage }
