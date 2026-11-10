#!/usr/bin/env node
/**
 * devstats-digest.test.js — 权威清单的排序/逐字引用/空数据/截断
 */
const fs = require('fs')
const path = require('path')

const MOD = path.join(__dirname, 'devstats-digest.js')
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

const rows = [
  { name: 'lume-core', cloners_14d: '211', clones_total_14d: '1946', views_total_14d: '38', viewers_14d: '12' },
  { name: 'lume', cloners_14d: '156', clones_total_14d: '915', views_total_14d: '5', viewers_14d: '3' },
  { name: 'nsgm', cloners_14d: '0', clones_total_14d: '0', views_total_14d: '77', viewers_14d: '76' },
  { name: 'stock-analyzer', cloners_14d: '2', clones_total_14d: '8', views_total_14d: '52', viewers_14d: '24' },
]

const load = () => require(MOD)

ok('模块可加载', () => {
  if (typeof load().buildTrafficDigest !== 'function') throw new Error('buildTrafficDigest 缺失')
})

ok('clone 榜按独立 clone 降序，且名字逐字来自数据', () => {
  const s = load().buildTrafficDigest(rows)
  const cloneLine1 = s.split('\n').find((l) => /^1\. /.test(l))
  if (!cloneLine1.includes('lume-core')) throw new Error('第一行应为 lume-core，实际：' + cloneLine1)
  if (!/211/.test(cloneLine1)) throw new Error('缺 211')
  if (!s.includes('lume：156')) throw new Error('lume 156 未出现')
})

ok('阅读量榜单独给出，且包含零 clone 的仓库', () => {
  const s = load().buildTrafficDigest(rows)
  const viewBlock = s.split('按阅读量排序')[1] || ''
  if (!viewBlock.includes('nsgm')) throw new Error('nsgm 应出现在阅读量榜')
  if (!viewBlock.includes('77')) throw new Error('nsgm 的 77 次缺失')
})

ok('没有编造名字：输出里出现的仓库名只能来自输入数据', () => {
  const s = load().buildTrafficDigest(rows)
  const names = rows.map((r) => r.name)
  const mentioned = (s.match(/^\d+\. ([^：]+)：/gm) || []).map((l) => l.replace(/^\d+\. /, '').replace('：', ''))
  for (const m of mentioned) if (!names.includes(m)) throw new Error('出现了数据里没有的名字：' + m)
})

ok('空数据返回空串（调用方据此跳过该段）', () => {
  if (load().buildTrafficDigest([]) !== '') throw new Error('空数组应返回空串')
})

ok('topN 生效', () => {
  const s = load().buildTrafficDigest(rows, { topN: 1 })
  const lines = s.split('\n').filter((l) => /^\d+\. /.test(l))
  if (lines.length !== 2) throw new Error('topN=1 时应各榜 1 行，实际 ' + lines.length)
})

process.exit(failures ? 1 : 0)
