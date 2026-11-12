'use strict'
// Port of resolve-studio's util-resync.ts.
//
// The product convention is "草稿=已发 → 未发清单自动缩短". wordpress-tools'
// make targets only write the frontmatter id back; they do NOT touch life-dash.
// resolve-studio closes that loop by re-running life-dash's generator after a
// publish. Without it, resolve-lume's publish-pending tool would keep reporting
// an article as pending immediately after it was drafted (the exact confusion
// seen on 2026-11-12).
//
// Best effort: a resync failure must never turn a successful publish into a
// reported failure. It only adds a one-line notice.

const fs = require('fs')
const path = require('path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { lifeDashRoot } = require('./publishPending')

const execFileAsync = promisify(execFile)
const GENERATOR_REL = path.join('scripts', 'gen-article-publish.mts')

// Pure: lets the test assert the exact command/env without spawning node.
function resyncCommand(root = lifeDashRoot(), nodeBin = process.execPath, baseEnv = process.env) {
  if (!root) return null
  const gen = path.join(root, GENERATOR_REL)
  if (!fs.existsSync(gen)) return null
  const env = { ...baseEnv }
  // Container compose may inject ARTICLES_DIR pointing at articles/pse; the
  // generator needs the articles ROOT (its own default relative path).
  delete env.ARTICLES_DIR
  return { cmd: nodeBin, args: ['--experimental-strip-types', gen], env, timeout: 60_000 }
}

async function resyncPendingList(taskLabel = '发布') {
  const root = lifeDashRoot()
  const spec = resyncCommand(root)
  if (!spec) return '' // life-dash not configured/absent: nothing to resync
  try {
    const { stdout } = await execFileAsync(spec.cmd, spec.args, {
      timeout: spec.timeout,
      maxBuffer: 1 << 20,
      env: spec.env,
      cwd: root,
    })
    const summary = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
    return `\n\n📋 未发清单已自动同步（${summary || 'life-dash articlePublish.json 已刷新'}）`
  } catch (e) {
    return `\n\n⚠️ ${taskLabel} 已完成，但自动同步未发清单失败（${e.message}）。可手动在 life-dash 跑 make export-pending。`
  }
}

module.exports = { resyncCommand, resyncPendingList, GENERATOR_REL }
