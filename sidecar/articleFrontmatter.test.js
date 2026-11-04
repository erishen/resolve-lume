'use strict'
// Regression tests for the article frontmatter sanitizer.
// Upstream free-tier models sometimes leak their tool-call control tokens into
// the generated YAML `title:` line; publishing that verbatim gives a garbled
// headline. Run with `make test-gateway`.
const assert = require('node:assert/strict')
const H = require('./business-helpers')

const cases = []
function test(name, fn) { cases.push([name, fn]) }

test('DSML token in title is replaced with the fallback, body untouched', () => {
  const src = [
    '---',
    'tags: ["AI"]',
    'title: <｜｜DSML｜｜ calls>',
    'slug: lume_a2a',
    '---',
    '',
    '## Body with <|legit|> text',
  ].join('\n')
  const r = H.sanitizeArticleFrontmatter(src, 'lume-a2a 技术实践解析')
  assert.equal(r.fixes.length, 1)
  assert.match(r.text, /^title: "lume-a2a 技术实践解析"$/m)
  assert.ok(!r.text.includes('DSML'))
  assert.ok(r.text.includes('## Body with <|legit|> text'), 'body must not be rewritten')
})

test('clean frontmatter is left byte-for-byte unchanged', () => {
  const src = '---\ntitle: "A proper title"\ndate: 2026-11-04\n---\n\ntext\n'
  const r = H.sanitizeArticleFrontmatter(src, 'fallback')
  assert.equal(r.fixes.length, 0)
  assert.equal(r.text, src)
})

test('empty title gets a fallback', () => {
  const src = '---\ntitle:\nslug: x\n---\n'
  const r = H.sanitizeArticleFrontmatter(src, 'Fallback Title')
  assert.equal(r.fixes.length, 1)
  assert.match(r.text, /^title: "Fallback Title"$/m)
})

test('no frontmatter is a no-op', () => {
  const src = '# Just an article\n\nno yaml here\n'
  const r = H.sanitizeArticleFrontmatter(src, 'fallback')
  assert.equal(r.fixes.length, 0)
  assert.equal(r.text, src)
})

let failed = 0
for (const [name, fn] of cases) {
  try { fn(); console.log('PASS ', name) }
  catch (e) { failed++; console.error('FAIL ', name, '\n     ', e.message) }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
