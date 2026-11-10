/**
 * stats-csv.js — dev-stats stats.csv 的最小解析器
 *
 * 只做一件事：把 CSV 变对象数组。要点（旧实现踩过的坑）：
 *  - CRLF 只算一次换行，否则每一行都会多出一行「幽灵行」（122 行读成 246 行）
 *  - 引号内的逗号不切列；"" 是转义的双引号
 *  - 首字节 BOM 不能污染列名
 */

const fs = require('fs')

function parseStatsCsv(csvPath) {
  let raw
  try {
    raw = fs.readFileSync(csvPath, 'utf8')
  } catch {
    return []
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  const rows = []
  let fields = null
  let row = []
  let field = ''
  let inQ = false
  let pendingCR = false

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (fields === null) {
      fields = row
    } else if (row.length > 1 || row[0] !== '') {
      rows.push(row)
    }
    row = []
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inQ) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        field += ch
      }
      pendingCR = false
      continue
    }
    if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      endField()
    } else if (ch === '\r') {
      endRow()
      pendingCR = true
    } else if (ch === '\n') {
      if (!pendingCR) endRow()
      pendingCR = false
    } else {
      field += ch
    }
    if (ch !== '\r' && ch !== '\n') pendingCR = false
  }
  if (field !== '' || row.length > 0) endRow()

  if (!fields) return []
  return rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i] || ''])))
}

module.exports = { parseStatsCsv }
