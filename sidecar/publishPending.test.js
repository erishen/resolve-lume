'use strict'
// Regression for the 2026-11-12 "各平台未发清单" card: the frontend shipped the
// card but the backend had NO publish-pending tool at all (43 tools, none of
// them), so the model fell back to article-write / read-file and invented an
// answer. Port of resolve-studio's publish-pending.test.ts, plus three lume
// contracts: conclusion-first output, stale-snapshot labelling, and the
// post-publish resync that makes "草稿=已发 → 清单缩短" actually happen.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  renderPendingList, runPublishPending, pendingHeadline, lifeDashRoot, pendingFile, staleCount, NEXT_STEP,
} = require('./publishPending')
const { resyncCommand } = require('./pendingResync')

const ROOT = path.resolve(__dirname, '..')
const cell = (s) => ({ s })

function row(base, title, statuses, missing = []) {
  return {
    base, title,
    wp: cell(statuses.wp || 'pub'),
    en: cell(statuses.en || 'pub'),
    juejin: cell(statuses.juejin || 'pub'),
    sf: cell(statuses.sf || 'pub'),
    wechat: cell(statuses.wechat || 'pub'),
    missing,
  }
}

function fixture() {
  return {
    summary: { total: 4, full: 1, missingWp: 1, missingEn: 1, jjNotPub: 3, sfNotPub: 1, wcNoConv: 1 },
    queue: [{ plat: 'juejin', label: '掘金', pending: 3, nextCmd: 'make juejin-draft', note: '' }],
    rows: [
      row('a', '已发', {}, []),
      row('b', '有稿未建草稿', { juejin: 'draft' }, ['juejin']),
      row('c', '可建稿', { juejin: 'seed' }, ['juejin']),
      row('d', '需归档', { wp: 'missing', en: 'missing', juejin: 'missing', sf: 'missing', wechat: 'missing' },
        ['wp', 'en', 'juejin', 'segmentfault', 'wechat']),
    ],
  }
}

// A withEnv helper: none of these tests may leak env vars into the next one.
function withEnv(patch, fn) {
  const saved = {}
  for (const k of Object.keys(patch)) saved[k] = process.env[k]
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('draft / seed / missing get three different next-steps (studio regression)', () => {
  const out = renderPendingList(fixture(), { file: 'articlePublish.json' })
  assert.match(out, /有稿未建草稿.*make juejin-draft/)
  assert.match(out, /可建稿.*make build-juejin/)
  assert.match(out, /需归档.*make archive/)
  assert.doesNotMatch(out, /已发.*→/)
})

// 2026-11-12: "掘金 3" was read as "3 drafts waiting to be created", while all
// three rows were actually `missing` (no articles/juejin/*.md at all). The
// model then retried juejin-draft four times after a correct empty-queue answer.
test('the Juejin count is split into draftable vs not-yet-ready articles', () => {
  const out = renderPendingList(fixture(), { file: 'x' })
  assert.match(out, /可直接建草稿 1 · 缺本地稿\/未归档 2/)
  assert.match(out, /不等于「待建草稿」/)
  assert.doesNotMatch(out, /掘金 3 篇待建草稿/)
})

test('when nothing is draftable the queue command is explicitly called out as a no-op', () => {
  const data = fixture()
  data.rows = data.rows.filter((r) => r.base !== 'b').concat(
    row('e', '仍缺本地稿', { juejin: 'missing' }, ['juejin']),
  )
  data.summary.jjNotPub = 3
  data.queue = [{ plat: 'juejin', label: '掘金', pending: 3, nextCmd: 'make juejin-draft', note: '' }]
  const out = renderPendingList(data, { file: 'x' })
  assert.match(out, /可直接建草稿 0/)
  assert.match(out, /0 篇可直接建草稿/)
  assert.match(out, /全部已发布，无需操作/)
  assert.match(out, /重复调用或加 --force 都无效/)
})

test('the conclusion and the read-only disclaimer come BEFORE the long detail', () => {
  const lines = renderPendingList(fixture(), { file: 'x' }).split('\n')
  assert.match(lines[0], /共 4 篇中文原稿/)
  assert.match(lines[1], /汇总（待办篇数）/)
  assert.match(lines.slice(0, 6).join('\n'), /本工具只读/)
  // The old failure mode: a long trace ending in the verdict was misread.
  assert.ok(lines.indexOf(lines.find((l) => l.includes('各平台待办'))) > 3)
  assert.match(lines.join('\n'), /不要据此自行调用写工具/)
  // 2026-11-12: the model wrote a tool-call line INTO its final answer; ReAct
  // read it as a new call and re-ran the tool. No literal template in the
  // warning (that would hand the model a format to imitate).
  assert.match(lines.join('\n'), /严禁在最终答案里复述工具调用行/)
})

test('a stale snapshot is labelled, and queue commands are copied verbatim', () => {
  const out = renderPendingList(fixture(), { file: 'x', snapshotMs: Date.now(), staleCount: 87 })
  assert.match(out, /数据快照可能滞后：有 87 篇原稿比快照新/)
  assert.match(out, /make export-pending/)
  assert.match(out, /\[掘金 待办 3\] make juejin-draft/)
})

test('fresh snapshot is explicit; commands are notes, not an action list', () => {
  const out = renderPendingList(fixture(), { file: 'x', snapshotMs: Date.now(), staleCount: 0 })
  assert.match(out, /数据快照为最新/)
  assert.doesNotMatch(out, /数据快照可能滞后/)
  assert.match(out, /各平台下一步（供用户参考，本轮不要执行）/)
  assert.doesNotMatch(out, /复制即用/)
  assert.match(out.trim().split('\n').pop(), /工具结果到此结束.*不要再发起任何工具调用/)
})

test('every non-published status has a distinct next-step string', () => {
  for (const key of [
    'wp:missing', 'en:missing', 'juejin:draft', 'juejin:seed', 'juejin:missing',
    'segmentfault:draft', 'segmentfault:missing', 'wechat:missing', 'wechat:conv',
  ]) assert.ok(NEXT_STEP[key], `missing NEXT_STEP for ${key}`)
  assert.notEqual(NEXT_STEP['juejin:draft'], NEXT_STEP['juejin:seed'])
  assert.notEqual(NEXT_STEP['juejin:seed'], NEXT_STEP['juejin:missing'])
})

test('staleCount only counts source files newer than the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-pending-'))
  try {
    const zh = path.join(dir, 'zh')
    const jj = path.join(dir, 'juejin')
    fs.mkdirSync(zh)
    fs.mkdirSync(jj)
    fs.writeFileSync(path.join(zh, 'new.md'), 'x')
    fs.writeFileSync(path.join(zh, 'ignored.txt'), 'x')
    fs.writeFileSync(path.join(jj, 'old.md'), 'x')
    const old = Date.now() - 100_000
    fs.utimesSync(path.join(jj, 'old.md'), old / 1000, old / 1000)
    assert.equal(staleCount(dir, Date.now() - 50_000), 1)
    assert.equal(staleCount(null, Date.now()), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lifeDashRoot: LIFE_DASH_DIR wins, otherwise derive from WORDPRESS_TOOLS_DIR', () => {
  const wp = '/tmp/personal/personal-site/wordpress-tools'
  withEnv({ LIFE_DASH_DIR: null, WORDPRESS_TOOLS_DIR: wp }, () => {
    assert.equal(lifeDashRoot(), '/tmp/personal/life-dash')
    assert.equal(pendingFile(), path.join('/tmp/personal/life-dash', 'src/data/articlePublish.json'))
  })
  withEnv({ LIFE_DASH_DIR: '/tmp/explicit-life-dash', WORDPRESS_TOOLS_DIR: wp }, () => {
    assert.equal(lifeDashRoot(), '/tmp/explicit-life-dash')
  })
  withEnv({ LIFE_DASH_DIR: null, WORDPRESS_TOOLS_DIR: null }, () => {
    assert.equal(lifeDashRoot(), null)
    assert.equal(pendingFile(), null)
  })
})

test('runPublishPending fails loudly (and readably) when the data source is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-pending-empty-'))
  try {
    const out = withEnv({ LIFE_DASH_DIR: dir, WORDPRESS_TOOLS_DIR: null }, () => runPublishPending())
    assert.match(out, /^error: 未找到未发清单数据源/)
    assert.match(out, /make export-pending/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pendingHeadline gives an empty queue the concrete pending-list numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-pending-head-'))
  try {
    const data = fixture()
    data.rows = [
      row('a', '需归档 A', { juejin: 'missing' }, ['juejin']),
      row('b', '需归档 B', { juejin: 'missing' }, ['juejin']),
      row('c', '需归档 C', { juejin: 'missing' }, ['juejin']),
    ]
    data.summary.jjNotPub = 3
    fs.mkdirSync(path.join(dir, 'src/data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/data/articlePublish.json'), JSON.stringify(data))
    const out = withEnv({ LIFE_DASH_DIR: dir, WORDPRESS_TOOLS_DIR: null }, () => pendingHeadline())
    assert.match(out, /掘金待办 3 篇（可直接建草稿 0 篇 · 缺本地稿\/未归档 3 篇）/)
    assert.match(out, /需归档 A/)
    assert.match(out, /不是「待建草稿」/)
    // No data source -> no invented numbers.
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-pending-none-'))
    try {
      const empty = withEnv({ LIFE_DASH_DIR: none, WORDPRESS_TOOLS_DIR: null }, () => pendingHeadline())
      assert.equal(empty, '')
    } finally {
      fs.rmSync(none, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('publish-pending schema is zero-arg, read-only and NOT gated', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecar/builtin-tools.json'), 'utf8'))
  const t = schema.tools.find((x) => x.name === 'publish-pending')
  assert.ok(t, 'publish-pending must exist in builtin-tools.json')
  assert.deepEqual(t.parameters.properties, {})
  assert.deepEqual(t.parameters.required, [])
  assert.equal(t.needsApproval, false)
  assert.match(t.description, /只读/)
  assert.match(t.description, /不要传参数/)
  // The allow-list + bridge + implementation agree (consistency.js also checks
  // this at startup; here we pin the exact card name too).
  const gen = fs.readFileSync(path.join(ROOT, 'deploy/gen-sidecar-tools.mjs'), 'utf8')
  assert.match(gen, /'publish-pending'/)
  const bridge = fs.readFileSync(path.join(ROOT, 'lume-tools/sidecar_ro.lume'), 'utf8')
  assert.match(bridge, /tool ["']publish-pending["']/)
  const impl = require('./business-publish')
  assert.equal(typeof impl['publish-pending'], 'function')
})

test('resyncCommand drops ARTICLES_DIR and targets the life-dash generator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-resync-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(path.join(dir, 'scripts/gen-article-publish.mts'), '// stub')
    const spec = withEnv({ LIFE_DASH_DIR: dir, ARTICLES_DIR: '/tmp/wrong' }, () =>
      resyncCommand(dir, '/usr/bin/node', { ...process.env, ARTICLES_DIR: '/tmp/wrong' }))
    assert.ok(spec)
    assert.equal(spec.cmd, '/usr/bin/node')
    assert.deepEqual(spec.args, ['--experimental-strip-types', path.join(dir, 'scripts/gen-article-publish.mts')])
    assert.equal('ARTICLES_DIR' in spec.env, false)
    assert.equal(resyncCommand(path.join(dir, 'missing')), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('queue publish results actually close the resync loop', () => {
  // Static pin: runWpMakeTask must append resyncPendingList after a successful
  // queue call, otherwise "草稿=已发 → 清单缩短" stays a lie.
  const src = fs.readFileSync(path.join(ROOT, 'sidecar/business-publish.js'), 'utf8')
  assert.match(src, /QUEUE_TASKS\.has\(name\)/)
  assert.match(src, /await resyncPendingList\(label\)/)
})

test('inventory SOUL/SKILL pin only the read-only tool and keep query != execute', () => {
  for (const f of ['SOUL.md', 'SKILL.md']) {
    const body = fs.readFileSync(path.join(ROOT, 'souls/publish-inventory', f), 'utf8')
    assert.match(body, /只调用一次 `sidecar__publish-pending`/)
    assert.match(body, /没有任何写工具/)
    assert.match(body, /不是让你执行的授权/)
    assert.match(body, /严禁在最终答案里复述工具调用行/)
  }
  const fm = fs.readFileSync(path.join(ROOT, 'souls/publish-inventory/SOUL.md'), 'utf8')
  assert.match(fm, /tools: sidecar__publish-pending, sidecar__capabilities/)
  const exec = fs.readFileSync(path.join(ROOT, 'souls/publish-dispatch/SOUL.md'), 'utf8')
  assert.doesNotMatch(exec, /tools:.*sidecar__publish-pending/)
})
