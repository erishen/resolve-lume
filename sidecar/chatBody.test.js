'use strict'
// Contract tests for /api/chat request shaping. The always-on tool discipline
// is the fix for the 2026-11-06 "7 -> hot-news x4 -> no answer" incident; the
// user's normal mode is taskMode=auto (no task soul at all), so the discipline
// MUST be injected even when getTask() returns undefined.
// Run with `make check`. Zero external dependencies.
const assert = require('node:assert/strict')
const { buildAgentChatBody, TOOL_DISCIPLINE, hasExplicitPublishIntent, hasExplicitPaidIntent } = require('./chatBody')

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
  // Paraphrased tool output was a real failure mode: the git status summary
  // listed a file that did not exist and dropped ones that did.
  assert.match(TOOL_DISCIPLINE, /文件名、目录、提交哈希、计数、金额必须逐字复制工具输出/)
  assert.match(TOOL_DISCIPLINE, /必须输出面向用户的中文文字总结/)
})

test('discipline separates a read-only pending-list query from publish actions', () => {
  assert.match(TOOL_DISCIPLINE, /只调用一次零参数的 publish-pending/)
  assert.match(TOOL_DISCIPLINE, /不是执行授权/)
  assert.match(TOOL_DISCIPLINE, /严禁因此调用 juejin-draft/)
  assert.match(TOOL_DISCIPLINE, /逐字取自工具输出/)
  // A tool call written as literal text restarts the ReAct loop (2026-11-12).
  assert.match(TOOL_DISCIPLINE, /严禁复述工具调用行或轮次标记/)
  assert.match(TOOL_DISCIPLINE, /不复述调用语句/)
})

test('discipline forbids fake "small problem" scripts and unprompted publish', () => {
  assert.match(TOOL_DISCIPLINE, /严禁编造/)
  assert.match(TOOL_DISCIPLINE, /DeprecationWarning/)
  assert.match(TOOL_DISCIPLINE, /不得自行决定发布/)
})

test('discipline states the zero-arg queue-tool contract', () => {
  // 2026-11-12: "建下一篇掘金草稿" was answered with "请选一个项目" and the
  // sibling juejin-publish card spent 6 rounds reading files hunting for a
  // Makefile. This rule is injected into EVERY chat, even with no task soul.
  assert.match(TOOL_DISCIPLINE, /队列驱动的发布工具/)
  assert.match(TOOL_DISCIPLINE, /严禁要求用户选项目或选文章/)
  assert.match(TOOL_DISCIPLINE, /严禁改用 article-write/)
  assert.match(TOOL_DISCIPLINE, /严禁用 read-file \/ shell \/ make 去找 Makefile/)
  assert.match(TOOL_DISCIPLINE, /草稿=已发/)
  assert.match(TOOL_DISCIPLINE, /不要自动追加 juejin-publish/)
})

test('publish intent needs explicit, non-negated user wording', () => {
  assert.equal(hasExplicitPublishIntent('7'), false)
  assert.equal(hasExplicitPublishIntent('写 resolve-lume 的文章'), false)
  assert.equal(hasExplicitPublishIntent(''), false)
  assert.equal(hasExplicitPublishIntent(null), false)
  assert.equal(hasExplicitPublishIntent('生成后发布到 WordPress'), true)
  assert.equal(hasExplicitPublishIntent('publish it'), true)
  assert.equal(hasExplicitPublishIntent('请上线'), true)
  assert.equal(hasExplicitPublishIntent('不要发布，先给我看看'), false)
  assert.equal(hasExplicitPublishIntent('先别上线'), false)
  assert.equal(hasExplicitPublishIntent('暂不发布'), false)
})

test('paid-model intent needs explicit, non-negated user wording', () => {
  assert.equal(hasExplicitPaidIntent(''), false)
  assert.equal(hasExplicitPaidIntent(null), false)
  assert.equal(hasExplicitPaidIntent('帮我做一份深度投资组合分析'), false)
  assert.equal(hasExplicitPaidIntent('用免费的就行'), false)
  assert.equal(hasExplicitPaidIntent('别用付费模型'), false)
  assert.equal(hasExplicitPaidIntent('不要花这个钱'), false)
  assert.equal(hasExplicitPaidIntent('用 deepseek 吧，付费也行'), true)
  assert.equal(hasExplicitPaidIntent('可以付费，质量优先'), true)
})

cases.push(['tool catalog sits above the discipline block', () => {
  const body = buildAgentChatBody(
    { messages: [{ role: 'user', content: 'hi' }] },
    { systemPrompt: 'SOUL', includeTools: [] },
    '# 可用工具目录\n- sidecar__shell — run shell'
  )
  const sys = body.system
  assert.ok(sys.includes('SOUL'))
  // catalog after the soul prompt, discipline last (most authoritative)
  assert.ok(sys.indexOf('# 可用工具目录') > sys.indexOf('SOUL'))
  assert.ok(sys.indexOf('工具调用纪律') > sys.indexOf('# 可用工具目录'))
  // no catalog passed -> unchanged shape (backend-computed systemPrompt only)
  const plain = buildAgentChatBody({ messages: [{ role: 'user', content: 'hi' }] }, undefined, '')
  assert.ok(!plain.system.includes('可用工具目录'))
}])

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
