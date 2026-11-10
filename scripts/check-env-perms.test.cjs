#!/usr/bin/env node
/**
 * check-env-perms.test.cjs — .env 卫生自检的三条规则各来一个红样本
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { checkEnvPerms } = require('./check-env-perms.cjs')

let failures = 0
function ok(name, fn) {
  try {
    fn()
    console.log('ok   ' + name)
  } catch (e) {
    failures++
    console.log('FAIL ' + name + ' — ' + e.message)
  }
}

function repo({ envMode = 0o600, gitignore = '.env\n', tracked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-perms-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (gitignore) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore)
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n')
  fs.chmodSync(path.join(dir, '.env'), envMode)
  if (tracked) execFileSync('git', ['add', '-f', '.env'], { cwd: dir })
  return dir
}

ok('无 .env 时跳过（不算失败）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-none-'))
  const r = checkEnvPerms(dir)
  if (!r.skipped || r.problems.length) throw new Error(JSON.stringify(r))
})

ok('0600 + 已忽略 + 未跟踪 → 通过', () => {
  const r = checkEnvPerms(repo())
  if (r.problems.length) throw new Error('不应报问题：' + r.problems.join('; '))
})

ok('0644 → 报「权限过宽」', () => {
  const r = checkEnvPerms(repo({ envMode: 0o644 }))
  if (!r.problems.some((p) => p.includes('权限'))) throw new Error('未报权限问题：' + r.problems.join('; '))
})

ok('未被 .gitignore 覆盖 → 报「未忽略」', () => {
  const r = checkEnvPerms(repo({ gitignore: '' }))
  if (!r.problems.some((p) => p.includes('未被仓库内 .gitignore'))) throw new Error('未报忽略问题：' + r.problems.join('; '))
})

ok('已被跟踪 → 报「已被 git 跟踪」', () => {
  const r = checkEnvPerms(repo({ tracked: true }))
  if (!r.problems.some((p) => p.includes('已被 git 跟踪'))) throw new Error('未报跟踪问题：' + r.problems.join('; '))
})

process.exit(failures ? 1 : 0)
