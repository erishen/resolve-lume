'use strict'
// SQLite-backed store (node:sqlite, zero external dependencies).
//
// Why not the old JSON files: every event rewrote the whole jobs file (O(n²) for
// long runs) and a crash in the middle left truncated JSON, which read() silently
// treated as "no data" — losing every session and job at once. SQLite gives
// atomic transactions, incremental job-event inserts and cheap point reads.
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'resolve-lume.db')

const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    key        TEXT NOT NULL,
    json       TEXT NOT NULL,
    PRIMARY KEY (collection, key)
  );
  CREATE TABLE IF NOT EXISTS job_events (
    job_id TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    json   TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  );
`)

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw err
  }
}

// ---------- generic collection API ----------
// Same read/write shape the old JSON store exposed: a collection is an object of
// key -> value, persisted as one row per key inside a single transaction.
function read(name, fallback) {
  const rows = db
    .prepare('SELECT key, json FROM docs WHERE collection = ?')
    .all(name)
  if (!rows.length) return fallback
  const out = {}
  for (const r of rows) out[r.key] = JSON.parse(r.json)
  return out
}

function write(name, value) {
  const entries = Object.entries(value || {})
  tx(() => {
    db.prepare('DELETE FROM docs WHERE collection = ?').run(name)
    const ins = db.prepare(
      'INSERT INTO docs(collection, key, json) VALUES(?, ?, ?)',
    )
    for (const [k, v] of entries) ins.run(name, k, JSON.stringify(v))
  })
}

// ---------- jobs (meta rows + incremental event log) ----------
const JOBS = 'jobs'

function rowToJob(row) {
  const meta = JSON.parse(row.json)
  return { id: row.key, ...meta }
}

const job = {
  list() {
    return db
      .prepare('SELECT key, json FROM docs WHERE collection = ?')
      .all(JOBS)
      .map(rowToJob)
  },
  get(id) {
    const row = db
      .prepare('SELECT key, json FROM docs WHERE collection = ? AND key = ?')
      .get(JOBS, id)
    return row ? rowToJob(row) : null
  },
  create(rec) {
    const { events, id, ...meta } = rec
    tx(() => {
      db.prepare(
        'INSERT OR REPLACE INTO docs(collection, key, json) VALUES(?, ?, ?)',
      ).run(JOBS, id, JSON.stringify({ ...meta, eventCount: 0 }))
      db.prepare('DELETE FROM job_events WHERE job_id = ?').run(id)
    })
    return this.get(id)
  },
  update(id, patch) {
    const cur = this.get(id)
    if (!cur) return null
    const meta = JSON.parse(
      db
        .prepare('SELECT json FROM docs WHERE collection = ? AND key = ?')
        .get(JOBS, id).json,
    )
    const next = { ...meta, ...patch }
    db.prepare('UPDATE docs SET json = ? WHERE collection = ? AND key = ?').run(
      JSON.stringify(next),
      JOBS,
      id,
    )
    return { id, ...next }
  },
  remove(id) {
    tx(() => {
      db.prepare('DELETE FROM docs WHERE collection = ? AND key = ?').run(JOBS, id)
      db.prepare('DELETE FROM job_events WHERE job_id = ?').run(id)
    })
  },
  // Append one stream event. Only the new event row is written (plus the job's
  // eventCount/updatedAt), so cost is O(1) per event instead of rewriting all.
  appendEvent(id, ev) {
    tx(() => {
      db.prepare(
        'INSERT OR REPLACE INTO job_events(job_id, seq, json) VALUES(?, ?, ?)',
      ).run(id, ev.seq, JSON.stringify(ev))
      const row = db
        .prepare('SELECT json FROM docs WHERE collection = ? AND key = ?')
        .get(JOBS, id)
      if (!row) return
      const meta = JSON.parse(row.json)
      meta.eventCount = db
        .prepare('SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?')
        .get(id).n
      meta.updatedAt = new Date().toISOString()
      db.prepare(
        'UPDATE docs SET json = ? WHERE collection = ? AND key = ?',
      ).run(JSON.stringify(meta), JOBS, id)
    })
  },
  events(id, sinceSeq = 0) {
    return db
      .prepare(
        'SELECT json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq',
      )
      .all(id, sinceSeq)
      .map((r) => JSON.parse(r.json))
  },
}

module.exports = { DATA_DIR, DB_PATH, read, write, job }
