'use strict'
// The 桌面 tab is a shared browser-desk surface (WeChat, Xianyu, … and 思否 all
// live in it), so "open a login page" must be an explicit, validated action —
// otherwise the tab keeps showing whatever the previous task left on screen.

const test = require('node:test')
const assert = require('node:assert/strict')
const { deskSiteNames, normalizeLoginUrl } = require('./desktop-desk.js')

test('adds https:// when the user types a bare domain', () => {
  assert.equal(normalizeLoginUrl('segmentfault.com/user/login'), 'https://segmentfault.com/user/login')
  assert.equal(normalizeLoginUrl('  https://segmentfault.com/write  '), 'https://segmentfault.com/write')
})

test('keeps http for local targets', () => {
  assert.equal(normalizeLoginUrl('http://127.0.0.1:18088/'), 'http://127.0.0.1:18088/')
})

test('rejects non-web schemes and empty input', () => {
  assert.equal(normalizeLoginUrl(''), null)
  assert.equal(normalizeLoginUrl('   '), null)
  assert.equal(normalizeLoginUrl('javascript:alert(1)'), null)
  assert.equal(normalizeLoginUrl('file:///etc/passwd'), null)
  assert.equal(normalizeLoginUrl('data:text/html,<b>x</b>'), null)
})

test('maps the login hub payload to a flat site list', () => {
  const payload = {
    sites: [
      { name: '微信公众号', domain: 'mp.weixin.qq.com', status: 'logged' },
      { name: '思否', domain: 'segmentfault.com', status: 'not_logged' },
    ],
  }
  assert.deepEqual(deskSiteNames(payload), ['微信公众号', '思否'])
  assert.deepEqual(deskSiteNames({}), [])
  assert.deepEqual(deskSiteNames(null), [])
})
