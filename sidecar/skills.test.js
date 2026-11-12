'use strict'
// `/api/skills` used to report `---` as the description of every soul with
// frontmatter. The frontend then generated generic prompts from the soul name
// alone and auto-matched the wrong task. Pin the parser contract here.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanSkills, soulDescription, soulTitle } = require('./skills')

const ROOT = path.join(__dirname, '..', 'souls')

const FM_SOUL = [
  '---',
  'name: 热点营销内容',
  'description: 抓取热门新闻素材、生成小红书热点文案并校验合规。',
  'triggers: 热点, 小红书',
  'tools: sidecar__hot-news',
  '---',
  '',
  '# 热点营销内容',
  '这是正文，不应该被当成描述。',
].join('\n')

function withSouls(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-skills-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      const d = path.join(dir, name)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'SOUL.md'), text, 'utf8')
    }
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('frontmatter description wins and `---` is never returned', () => {
  assert.equal(soulDescription(FM_SOUL), '抓取热门新闻素材、生成小红书热点文案并校验合规。')
  assert.notEqual(soulDescription(FM_SOUL), '---')
  // Quoted values are unquoted, same rule as parseSoulFrontmatter in server.js.
  assert.equal(
    soulDescription('---\ndescription: "带引号的描述"\n---\n'),
    '带引号的描述',
  )
})

test('frontmatter without a description falls back to the first prose line', () => {
  assert.equal(
    soulDescription('---\nname: x\n---\n\n# 标题\n这是正文第一行。\n'),
    '这是正文第一行。',
  )
})

test('plain markdown keeps the historical first-prose-line behaviour', () => {
  // PSE role souls have no frontmatter at all.
  assert.equal(
    soulDescription('# Planner\n\n你是 Planner，多智能体协作 PSE 工作流的第一棒。\n'),
    '你是 Planner，多智能体协作 PSE 工作流的第一棒。',
  )
})

test('taskCopy owns the Chinese card title, frontmatter name is the fallback', () => {
  // hot-news-post has an English frontmatter name but a Chinese registry name.
  assert.equal(soulTitle(FM_SOUL, 'hot-news-post'), '热点营销内容')
  assert.equal(soulTitle(FM_SOUL, 'alpha'), '热点营销内容')
  assert.equal(soulTitle(FM_SOUL, 'unknown-soul'), '热点营销内容')
})

test('scanSkills reads every SOUL.md and tolerates a missing tree', () => {
  withSouls({ alpha: FM_SOUL, beta: '---\ndescription: Beta 描述\n---\n' }, (dir) => {
    const out = scanSkills(dir).sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(out, [
      { name: 'alpha', title: '热点营销内容', description: '抓取热门新闻素材、生成小红书热点文案并校验合规。' },
      { name: 'beta', title: 'beta', description: 'Beta 描述' },
    ])
  })
  assert.deepEqual(scanSkills(path.join(os.tmpdir(), 'rl-skills-does-not-exist')), [])
})

test('every real soul exposes a non-placeholder description', () => {
  const out = scanSkills(ROOT)
  assert.ok(out.length >= 15, `only ${out.length} souls found — SOULS_DIR drifted`)
  for (const s of out) {
    assert.ok(s.description, `${s.name} has an empty description`)
    assert.notEqual(s.description, '---', `${s.name} still returns the frontmatter fence`)
    assert.ok(!s.description.startsWith('# '), `${s.name} returned a heading`)
    assert.ok(s.title, `${s.name} has no card title`)
  }
})
