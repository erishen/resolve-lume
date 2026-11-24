'use strict'
// article-publish 的清单必须只列 projects.json（待写队列）里真正还没发的项目。
// 2026-11-22 实录：清单误用 loadArticleKeys() 全集（projects.json ∪ 已归档区正文），
// 把 projects-published.json 的 51 个已发布项目也扫进来，列出 48 个「待发布」项目、
// 绝大多数早已发过 —— 模型挑错就发错文章。全量集合只用于按名字的合法性校验
// （已发布项目重跑更新链接仍合法），不得用于清单展示。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-publish-scope-'))
const creai = path.join(root, 'crewai-pse')
const wp = path.join(root, 'wp')
fs.mkdirSync(path.join(creai, 'tasks', 'project-articles'), { recursive: true })
// 待写队列：两个真正待发的项目
fs.writeFileSync(
  path.join(creai, 'tasks', 'project-articles', 'projects.json'),
  JSON.stringify({ 'live-a': {}, 'live-b': {} })
)
// 已归档区：这两个项目正文在 articles/{zh,en}，属已发布存档，不该进待发布清单。
const archivedZh = path.join(wp, 'articles', 'zh')
const archivedEn = path.join(wp, 'articles', 'en')
fs.mkdirSync(archivedZh, { recursive: true })
fs.mkdirSync(archivedEn, { recursive: true })
fs.writeFileSync(path.join(archivedZh, 'published_only-zh.md'), 'body\n')
fs.writeFileSync(path.join(archivedEn, 'published_only-en.md'), 'body\n')
fs.writeFileSync(path.join(archivedZh, 'live_a-zh.md'), 'body\n')

process.env.CREWAI_PSE_DIR = creai
process.env.WORDPRESS_TOOLS_DIR = wp

const publish = require('./business-publish')

test('list mode shows ONLY pending queue projects, not already-published ones', async () => {
  const out = await publish['article-publish']({})
  assert.match(out, /待发布项目如下/)
  assert.match(out, /1\. live-a/)
  assert.match(out, /2\. live-b/)
  assert.doesNotMatch(out, /published-only/, 'already-published project must not be listed')
})

test('already-published project passes the name guard (rerun updates links)', async () => {
  // 收窄清单不能破坏合法性校验：已发布项目按名字调用必须过 unknown-project 守卫。
  // 2026-11-22 起发布零确认：带 project 直接进执行路径（先跑 make validate，
  // 临时目录无 Makefile → 「执行已拦截」），所以这里只断言名字守卫 ——
  // 没报 unknown project 即证明按名字可选，publish.py 会当 published 来源重跑更新链接。
  const out = await publish['article-publish']({ project: 'published-only' })
  assert.ok(!/unknown project/.test(out), 'published project must pass the name guard, not be reported unknown')
})

test('zero-confirm publish: project goes straight to execute, no preview/await-confirm prompt', async () => {
  // 用户决定（2026-11-22）：带 project 即发，不再有「请让用户确认 / 需带 confirm=true」
  // 的预览门。临时目录无 Makefile，validate 失败 → 输出应是「执行已拦截」(执行路径)
  // 而非「👁️ 预览模式」(预览路径)。这同时证明 confirm 缺省也不再拦。
  const out = await publish['article-publish']({ project: 'live-a' })
  assert.match(out, /执行已拦截|发布.*完成/, 'must enter the execute path (preValidate gate)')
  assert.doesNotMatch(out, /预览模式|请让用户确认|需另带 confirm/, 'no preview/await-confirm step')
})

test('article-validate list shows ONLY projects with a body in pse/ (not archived ones)', async () => {
  // validate.py 的 ARTICLES_DIR 固定指向 articles/pse/{zh,en}，已归档项目（正文在
  // articles/{zh,en}）校验必然文件不存在而失败。清单必须和 archive 一样收窄到
  // pse/ 有正文的项目，否则列出几十个必然失败的校验项。
  // 本测试环境 pse/ 为空 → 空清单错误文案；另测有正文时只列该项目。
  const empty = await publish['article-validate']({})
  assert.match(empty, /当前没有待校验的文章/)

  const pseZh = path.join(wp, 'articles', 'pse', 'zh')
  fs.mkdirSync(pseZh, { recursive: true })
  fs.writeFileSync(path.join(pseZh, 'live_a-zh.md'), 'body\n')
  fs.writeFileSync(path.join(pseZh, 'pending_only-zh.md'), 'body\n')
  const out = await publish['article-validate']({})
  assert.match(out, /待校验项目如下/)
  assert.match(out, /live-a/)        // pse/ 有正文
  assert.match(out, /pending-only/)  // pse/ 有正文
  assert.doesNotMatch(out, /published-only/, 'already-archived project must not be listed')
})

test('unknown names are still rejected', async () => {
  const out = await publish['article-publish']({ project: 'no-such-project' })
  assert.match(out, /^error: unknown project/)
})
