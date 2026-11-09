'use strict'
// The markdown-library search is AND-based, so a whole-sentence query such as
// "RAG 的实现思路" returns 0 and looks like an empty library. These cases pin
// the term split used by the relaxed retry.
const test = require('node:test')
const assert = require('node:assert')
const { docSearchTerms } = require('./business-misc')

test('splits whole-sentence queries into searchable terms', () => {
  assert.deepStrictEqual(docSearchTerms('RAG 的实现思路'), ['RAG', '实现思路'])
  assert.deepStrictEqual(docSearchTerms('投资 组合'), ['投资', '组合'])
  assert.deepStrictEqual(docSearchTerms('RAG的实现思路'), ['RAG', '实现思路'])
})

test('drops one-character noise terms', () => {
  assert.deepStrictEqual(docSearchTerms('的'), [])
  assert.deepStrictEqual(docSearchTerms('RAG 的 实现'), ['RAG', '实现'])
})
