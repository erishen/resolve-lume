#!/usr/bin/env node
// 静态拦截 shell 脚本里「$VAR 后面紧跟非 ASCII 字符」的写法。
//
// 背景：macOS 自带 /bin/bash 是 3.2，它在 UTF-8 locale 下会把紧跟 $VAR 的
// 多字节首字节也当成变量名的一部分：
//     echo "pid=$old（连带 sidecar）"
//   → old\xEF: unbound variable（set -u 下脚本直接退出）
// 而 bash 5、LC_ALL=C、以及绝大多数开发者本机都不复现，靠人眼 review 必漏。
// 修法：变量引用一律写 ${VAR}。$(...) / $((...)) / curl 的 %{...} 不受影响。
//
// 只扫入库的顶层脚本目录（scripts / sidecar / deploy / 仓库根），不递归进
// vendored 的 agent-httpd/、lume-core/ 等外部源码；纯注释行跳过。

'use strict'

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const scanDirs = ['.', 'scripts', 'sidecar', 'deploy']
// 变量名后紧跟一个非 ASCII 字符（含中文、全角标点、emoji）。
const BAD = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g

const problems = []
let scanned = 0

for (const dir of scanDirs) {
  const absDir = path.join(root, dir)
  let entries
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sh')) continue
    const rel = path.join(dir, entry.name).replace(/^\.\//, '')
    const lines = fs.readFileSync(path.join(absDir, entry.name), 'utf8').split('\n')
    scanned += 1
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return // 注释里的示例不算代码
      const hits = line.match(BAD)
      if (hits) problems.push(`${rel}:${i + 1}  ${hits.join(' ')}`)
    })
  }
}

if (problems.length) {
  console.error('✗ $VAR 后紧跟非 ASCII：macOS /bin/bash 3.2 会把它吃进变量名（set -u 下直接崩）。')
  console.error('  改成 ${VAR} 即可。命中位置：')
  for (const p of problems) console.error('    ' + p)
  process.exit(1)
}

console.log(`✓ shell 变量引用兼容 bash 3.2（扫描 ${scanned} 个 .sh，无 $VAR+中文 写法）`)
