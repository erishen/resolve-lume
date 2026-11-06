'use strict'
// Contract tests for /api/chat request shaping. The always-on tool discipline
// is the fix for the 2026-11-06 "7 -> hot-news x4 -> no answer" incident; the
// user's normal mode is taskMode=auto (no task soul at all), so the discipline
// MUST be injected even when getTask() returns undefined.
// Run with `make check`. Zero external dependencies.
const assert = require('node:assert/strict')
const { buildAgentChatBody, TOOL_DISCIPLINE } = require('./chatBody')

const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

test('taskMode=auto (no task) still gets the tool discipline', () => {
  const r = buildAgentChatBody({ messages: [{ role: 'user', content: '7' }] }, undefined)
  assert.equal(r.message, '7')
  assert.deepEqual(r.history, [])
  assert.ok(r.system.includes('# 工具调用纪律'))
  assert.ok(r.system.includes('禁止切换到无关业务域'))
  assert.equal(r.tools, undefined)
})

test('task soul + frontend systemPrompt + discipline are all present, in order', () => {
  const task = {
    id: 'article-write',
    systemPrompt: 'SOUL BODY',
    includeTools: ['article-write', 'article-discover'],
  }
  const r = buildAgentChatBody(
    { messages: [{ role: 'user', content: '写文章' }], systemPrompt: 'MEMORY', model: 'free' },
    task,
  )
  assert.equal(r.model, 'free')
  assert.deepEqual(r.tools, ['article-write', 'article-discover'])
  const iSoul = r.system.indexOf('SOUL BODY')
  const iMem = r.system.indexOf('MEMORY')
  const iDisc = r.system.indexOf('# 工具调用纪律')
  assert.ok(iSoul >= 0 && iMem > iSoul && iDisc > iMem)
})

test('message/history split keeps only the latest user message out of history', () => {
  const r = buildAgentChatBody(
    {
      messages: [
        { role: 'user', content: '选 7' },
        { role: 'assistant', content: '清单…' },
        { role: 'user', content: '7' },
      ],
    },
    null,
  )
  assert.equal(r.message, '7')
  assert.deepEqual(r.history, [
    { role: 'user', content: '选 7' },
    { role: 'assistant', content: '清单…' },
  ])
})

test('discipline covers numbering, retries and the mandatory final summary', () => {
  assert.match(TOOL_DISCIPLINE, /编号原样传给对应工具/)
  assert.match(TOOL_DISCIPLINE, /严禁用完全相同的参数重复调用/)
  assert.match(TOOL_DISCIPLINE, /必须输出面向用户的中文文字总结/)
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
