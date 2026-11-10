'use strict'
// 归档/发布是写操作，却曾经接受「当前清单的第 N 项」这种位置编号。列表本身来自
// projects.json ∪ articles/pse/zh（loadArticleKeys），而归档会把文章移出 pse/zh，
// 集合随即变短、后面所有编号前移。2026-11-10 实测：并行发 project="7" 与 "8"，
// 7（lume-a2a）成功后 8 报「超出范围（1-7）」；若队列里 8 后面还有项目，同一个
// 「8」会静默落到别的项目上 —— 归档错文章且不报错。
//
// 现在的约定：编号只供人阅读，写操作（archive / publish）只认项目名；调用方按
// 它呈现给用户的那份清单把数字翻译成名字。下面的断言固定这条契约。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 复刻 trace 现场：projects.json 5 个 key，pse/zh 里有 4 篇（2 个重复 + legacy +
// lume-a2a + resolve-lume），并集刚好 8 项，8 = resolve-lume。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-archive-numbering-'))
const pse = path.join(root, 'crewai-pse')
const wp = path.join(root, 'wp')
fs.mkdirSync(path.join(pse, 'tasks', 'project-articles'), { recursive: true })
fs.writeFileSync(
  path.join(pse, 'tasks', 'project-articles', 'projects.json'),
  JSON.stringify({
    'solo-chat': {},
    'rag-platform': {},
    'tax-agent-platform': {},
    'alva-e2e': {},
    'nsbp-shop-e2e': {},
  })
)
const zh = path.join(wp, 'articles', 'pse', 'zh')
fs.mkdirSync(zh, { recursive: true })
for (const slug of ['solo_chat', 'legacy', 'lume_a2a', 'resolve_lume']) {
  fs.writeFileSync(path.join(zh, `${slug}-zh.md`), '---\ntitle: t\n---\nbody\n')
}
process.env.CREWAI_PSE_DIR = pse
process.env.WORDPRESS_TOOLS_DIR = wp

const publish = require('./business-publish')

test('list mode still prints a readable numbered list, 8 = resolve-lume', async () => {
  const out = await publish['article-archive']({})
  assert.match(out, /1\. solo-chat/)
  assert.match(out, /8\. resolve-lume/)
  // 编号只能给人看：清单文案不再教调用方把数字透传给工具。
  assert.doesNotMatch(out, /也可直接传列表中的编号/)
  assert.match(out, /project=<项目名>/)
})

test('archiving refuses a bare number even when it is in range', async () => {
  const out = await publish['article-archive']({ project: '8' })
  assert.match(out, /^error:/)
  assert.match(out, /不接受编号/)
  // 报错要把当前可用项目名交回去，便于按用户看到的那份清单翻译。
  assert.match(out, /resolve-lume/)
})

test('an out-of-range number reports "no numbers" instead of a fake range error', async () => {
  const out = await publish['article-archive']({ project: '9' })
  assert.match(out, /^error:/)
  assert.match(out, /不接受编号/)
  // 「超出范围（1-7）」正是 trace 里那句误导性报错，不该再出现在编号路径上。
  assert.doesNotMatch(out, /超出范围（1-/)
})

test('article-publish refuses numbers too', async () => {
  const out = await publish['article-publish']({ project: '99' })
  assert.match(out, /^error:/)
  assert.match(out, /不接受编号/)
})

test('a project name still gets the normal preview, no side effect', async () => {
  const out = await publish['article-archive']({ project: 'resolve-lume' })
  assert.match(out, /预览模式/)
  assert.match(out, /project=resolve-lume/)
})
