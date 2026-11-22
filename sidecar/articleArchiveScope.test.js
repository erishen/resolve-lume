'use strict'
// 归档工具的合法项目必须是 projects.json ∪ 磁盘上有正文的项目，正文既可能在
// 待归档区 articles/pse/{zh,en}，也可能已被搬进 articles/{zh,en}。
// 2026-11-21 实录：loadArticleKeys 只扫 pse/zh，导致 schema 枚举公布的
// resolve-lume / lume-qt 在运行时守卫被误判 unknown project，模型改猜别的名字，
// 结果归档串台。下面的断言把这个口径钉住。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-archive-scope-'))
const pse = path.join(root, 'crewai-pse')
const wp = path.join(root, 'wp')
fs.mkdirSync(path.join(pse, 'tasks', 'project-articles'), { recursive: true })
fs.writeFileSync(
  path.join(pse, 'tasks', 'project-articles', 'projects.json'),
  JSON.stringify({ 'live-a': {}, 'live-b': {} })
)
// 待归档区：live-a 已在队列，pending_only 只在正文里。
const pending = path.join(wp, 'articles', 'pse', 'zh')
fs.mkdirSync(pending, { recursive: true })
fs.writeFileSync(path.join(pending, 'live_a-zh.md'), 'body\n')
fs.writeFileSync(path.join(pending, 'pending_only-zh.md'), 'body\n')
// 已归档区：archived_only 已不在队列、也不在待归档区，正文只剩这一份。
const archivedZh = path.join(wp, 'articles', 'zh')
fs.mkdirSync(archivedZh, { recursive: true })
fs.writeFileSync(path.join(archivedZh, 'archived_only-zh.md'), 'body\n')
// 仅英文正文的项目也要认得。
const archivedEn = path.join(wp, 'articles', 'en')
fs.mkdirSync(archivedEn, { recursive: true })
fs.writeFileSync(path.join(archivedEn, 'en_only-en.md'), 'body\n')

process.env.CREWAI_PSE_DIR = pse
process.env.WORDPRESS_TOOLS_DIR = wp

const publish = require('./business-publish')

test('archived-only and en-only projects are selectable by name', async () => {
  for (const key of ['archived-only', 'en-only', 'pending-only', 'live-a']) {
    const out = await publish['article-archive']({ project: key })
    assert.match(out, /预览模式/, `${key} should be accepted, got: ${out}`)
    assert.ok(!/unknown project/.test(out), `${key} must not be reported unknown`)
  }
})

test('list mode shows ONLY projects with a body still in the pending queue', async () => {
  // 2026-11-22: 全集（projects.json ∪ pse/ ∪ 已归档区）只用于按名字校验，
  // 清单必须收窄到 pse/ 里还有正文的项目，否则会列出几十个归档 0 篇的空操作。
  const out = await publish['article-archive']({})
  assert.match(out, /待归档项目如下/)
  assert.match(out, /1\. live-a/)          // pse/ 有正文，也在 projects.json
  assert.match(out, /pending-only/)        // pse/ 有正文，不在 projects.json
  assert.doesNotMatch(out, /live-b/, 'project with no body in pse/ must not be listed')
  assert.doesNotMatch(out, /archived-only/, 'already archived (zh) must not be listed')
  assert.doesNotMatch(out, /en-only/, 'already archived (en) must not be listed')
})

test('a name in the full set but not archivable still previews (0 篇, not unknown)', async () => {
  // 收窄清单不能破坏上上轮的修复：已归档项目按名字调用仍是合法预览，
  // archive.py 届时会报「没有文件被归档」，而不是 unknown project。
  for (const key of ['archived-only', 'en-only']) {
    const out = await publish['article-archive']({ project: key })
    assert.match(out, /预览模式/, `${key} should still be selectable by name`)
    assert.ok(!/unknown project/.test(out))
  }
})

test('unknown names are still rejected', async () => {
  const out = await publish['article-archive']({ project: 'no-such-project' })
  assert.match(out, /^error: unknown project/)
})
