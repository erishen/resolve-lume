'use strict'
// Tiny JSON-file key/value store. Zero dependencies; one file per collection.
// Not meant for high concurrency — fine for a single-user local harness.
const fs = require('fs')
const path = require('path')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}
ensure()

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`)
}

function read(name, fallback) {
  try {
    const raw = fs.readFileSync(fileFor(name), 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(name, value) {
  ensure()
  fs.writeFileSync(fileFor(name), JSON.stringify(value, null, 2))
}

module.exports = { DATA_DIR, read, write, ensure }
