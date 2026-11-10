#!/usr/bin/env node
/**
 * stats-csv.test.js — stats.csv 解析器：CRLF 不能产生幽灵行、引号内逗号不切列
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const MOD = path.join(__dirname, 'stats-csv.js')
let failures = 0
function ok(name, fn) {
  try {
    fn()
    console.log('ok   ' + name)
  } catch (e) {
    failures++
    console.log('FAIL ' + name + ' — ' + e.message)
  }
}

const tmp = (name, content) => {
  const p = path.join(os.tmpdir(), name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

ok('模块可加载', () => {
  if (typeof require(MOD).parseStatsCsv !== 'function') throw new Error('parseStatsCsv 缺失')
})

ok('CRLF 换行不产生幽灵行（3 行数据应得 3 条）', () => {
  const p = tmp('zz-crlf.csv', 'name,cloners_14d\r\nlume-core,211\r\nlume,156\r\nagent-httpd,122\r\n')
  const rows = require(MOD).parseStatsCsv(p)
  if (rows.length !== 3) throw new Error('期望 3 行，实际 ' + rows.length)
  if (rows[2].name !== 'agent-httpd') throw new Error('第三行名字错：' + rows[2].name)
})

ok('引号内的逗号不切列', () => {
  const p = tmp('zz-quote.csv', 'name,desc\nlume,"a, b, c"\n')
  const rows = require(MOD).parseStatsCsv(p)
  if (rows[0].desc !== 'a, b, c') throw new Error('引号字段解析错：' + rows[0].desc)
})

ok('引号内的双引号转义（"" → "）', () => {
  const p = tmp('zz-esc.csv', 'name,desc\nlume,"say ""hi"" now"\n')
  const rows = require(MOD).parseStatsCsv(p)
  if (rows[0].desc !== 'say "hi" now') throw new Error('转义解析错：' + rows[0].desc)
})

ok('BOM 不污染第一个字段名', () => {
  const p = tmp('zz-bom.csv', '\ufeffname,cloners_14d\nlume,1\n')
  const rows = require(MOD).parseStatsCsv(p)
  if (!rows[0] || !('name' in rows[0])) throw new Error('首列名被 BOM 污染：' + JSON.stringify(rows[0]))
})

ok('文件不存在返回空数组', () => {
  const rows = require(MOD).parseStatsCsv(path.join(os.tmpdir(), 'zz-nope-404.csv'))
  if (rows.length !== 0) throw new Error('期望空数组')
})

process.exit(failures ? 1 : 0)
