#!/usr/bin/env node
/**
 * check-env-perms.cjs — .env 卫生自检
 *
 * 检查三件事，任一不满足即 exit 1：
 *   1. .env 不能被 git 跟踪（密钥不进仓库）
 *   2. .env 必须被 .gitignore 覆盖（防止误 add -f 之外的手滑）
 *   3. .env 权限必须是 0600 或更严格（同机其他账号不可读）
 *
 * 只在 .env 存在时检查；不存在视为通过（该仓库不需要）。
 * 用法：node scripts/check-env-perms.cjs [repoRoot]
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function sh(cwd, args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (e) {
    return { ok: false, out: String((e.stdout || e.message || '')).trim(), code: e.status }
  }
}

function checkEnvPerms(repoRoot) {
  const root = repoRoot || process.cwd()
  const problems = []
  const envPath = path.join(root, '.env')

  if (!fs.existsSync(envPath)) return { problems, skipped: true }

  // 1) 不能已被跟踪
  const tracked = sh(root, ['ls-files', '--error-unmatch', '.env'])
  if (tracked.ok) problems.push('.env 已被 git 跟踪：请 `git rm --cached .env` 并确认历史无该文件')

  // 2) 必须被仓库自己的 .gitignore 覆盖。
  //    注意：`git check-ignore` 会把 ~/.gitignore_global 也算命中，那是本机独有的兜底，
  //    换机器/CI 就失效，所以这里要求命中来源必须是仓库内的相对路径 .gitignore。
  const v = sh(root, ['check-ignore', '-v', '.env'])
  const rule = v.ok ? v.out.split('\t')[0] : '' // 形如 "<source>:<line>:<pattern>"
  const ruleSrc = rule.replace(/:\d+:.+$/, '')
  const fromRepo = Boolean(ruleSrc) && !path.isAbsolute(ruleSrc)
  if (!fromRepo) {
    problems.push('.env 未被仓库内 .gitignore 覆盖（~/.gitignore_global 兜底换机器就失效）：加一行 `.env` 到 .gitignore')
  }

  // 3) 权限不能给组/其他用户读
  const mode = fs.statSync(envPath).mode & 0o777
  if (mode & 0o077) problems.push(`.env 权限 ${mode.toString(8)} 过宽：执行 chmod 600 .env`)

  return { problems, mode, skipped: false }
}

module.exports = { checkEnvPerms }

if (require.main === module) {
  const root = process.argv[2] || process.cwd()
  const { problems, mode, skipped } = checkEnvPerms(root)
  if (skipped) {
    console.log('· 无 .env，跳过')
    process.exit(0)
  }
  if (problems.length) {
    console.error('❌ .env 卫生检查失败：')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log(`✓ .env 卫生检查通过（权限 0${mode.toString(8)}，未跟踪、已忽略）`)
}
