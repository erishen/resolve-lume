'use strict'
// Tool-chain drift guard for resolve-lume.
//
// Four lists must agree, and historically they did NOT (that is how the agent
// ended up answering "the gateway has no article-write tool"):
//   1. sidecar/builtin-tools.json      — schemas shown in the frontend panel
//   2. deploy/gen-sidecar-tools.mjs   — DEFAULT_ALLOW (what SHOULD be exposed)
//   3. lume-tools/sidecar_ro.lume     — `tool "name"` (what the agent CAN see)
//   4. builtin-exec.js BUILTIN_NAMES  — what is actually implemented
//
// The generator only checks C-side hard limits (name/desc/type sizes); it does
// NOT check that the generated bridge matches DEFAULT_ALLOW, nor that every
// exposed tool exists. This module turns any drift into an explicit startup
// failure instead of a silently missing capability.
//
// Usage:
//   node sidecar/consistency.js --check       # CLI, exits 1 on drift
//   require('./consistency').checkToolChain({ implemented })
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SCHEMA_FILE = path.join(ROOT, 'sidecar', 'builtin-tools.json')
const GENERATOR_FILE = path.join(ROOT, 'deploy', 'gen-sidecar-tools.mjs')
const BRIDGE_FILE = path.join(ROOT, 'lume-tools', 'sidecar_ro.lume')

// Pure: easy to unit-test with deliberately broken inputs.
function computeDrift({ schemaNames, allow, bridge, implemented }) {
  const problems = []
  const arr = (x) => [...(x || [])]
  const schema = arr(schemaNames)
  const impl = arr(implemented)
  const allowList = arr(allow)
  const bridgeList = arr(bridge)
  const diff = (a, b) => a.filter((n) => !b.includes(n))
  const dup = (xs, label) => {
    const seen = new Set()
    for (const n of xs) {
      if (seen.has(n)) problems.push(`${label} 有重复工具名: ${n}`)
      seen.add(n)
    }
  }
  dup(schema, 'builtin-tools.json')
  dup(impl, 'builtin-exec.js')
  dup(allowList, 'DEFAULT_ALLOW')
  dup(bridgeList, 'sidecar_ro.lume')

  const allowNotSchema = diff(allowList, schema)
  if (allowNotSchema.length) {
    problems.push(`DEFAULT_ALLOW 引用了 schema 里不存在的工具: ${allowNotSchema.join(', ')}`)
  }
  const allowNotBridge = diff(allowList, bridgeList)
  const bridgeNotAllow = diff(bridgeList, allowList)
  if (allowNotBridge.length || bridgeNotAllow.length) {
    problems.push(
      `生成物与 DEFAULT_ALLOW 不一致（需 make tools-lume）: ` +
      `缺 ${allowNotBridge.join(', ') || '无'}；多 ${bridgeNotAllow.join(', ') || '无'}`)
  }
  const bridgeNotImpl = diff(bridgeList, impl)
  if (bridgeNotImpl.length) {
    problems.push(`工具桥声明了但没有真实实现（agent 会调到空实现）: ${bridgeNotImpl.join(', ')}`)
  }
  const implNotSchema = diff(impl, schema)
  if (implNotSchema.length) {
    problems.push(`有实现但没有 schema（前端面板看不到）: ${implNotSchema.join(', ')}`)
  }
  const schemaNotImpl = diff(schema, impl)
  if (schemaNotImpl.length) {
    problems.push(`有 schema 但没有实现（面板显示却点不动）: ${schemaNotImpl.join(', ')}`)
  }
  // capabilities is the agent's escape hatch when a tool is intentionally not
  // exposed. Losing it is what produced the "网关没挂载 article-write" answer.
  if (!allowList.includes('capabilities') || !bridgeList.includes('capabilities')) {
    problems.push('capabilities 必须对 Agent 开放（否则它无法区分「没开放」和「不存在」）')
  }
  return problems
}

function readToolChain() {
  const gen = fs.readFileSync(GENERATOR_FILE, 'utf8')
  const block = gen.match(/const DEFAULT_ALLOW\s*=\s*\[([\s\S]*?)\]/)
  if (!block) throw new Error(`无法从 ${path.relative(ROOT, GENERATOR_FILE)} 解析 DEFAULT_ALLOW`)
  const allow = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  const bridgeSrc = fs.readFileSync(BRIDGE_FILE, 'utf8')
  const bridge = [...bridgeSrc.matchAll(/^tool ['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const schemaNames = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')).tools.map((t) => t.name)
  return { schemaNames, allow, bridge }
}

function checkToolChain({ implemented } = {}) {
  const disk = readToolChain()
  // BUILTIN_NAMES is a Set; normalise so stats/console output is a real count.
  const impl = [...(implemented || require('./builtin-exec').BUILTIN_NAMES)]
  const problems = computeDrift({ ...disk, implemented: impl })
  return {
    ok: problems.length === 0,
    problems,
    stats: {
      schema: disk.schemaNames.length,
      allow: disk.allow.length,
      bridge: disk.bridge.length,
      implemented: impl.length,
    },
  }
}

if (require.main === module) {
  try {
    const r = checkToolChain()
    const { schema, allow, bridge, implemented } = r.stats
    console.log(`schema=${schema} allow=${allow} bridge=${bridge} implemented=${implemented}`)
    if (r.ok) {
      console.log('✓ 四处工具名单一致（schema / DEFAULT_ALLOW / 生成桥 / 真实实现）')
    } else {
      console.error('✗ 工具链漂移:\n  ' + r.problems.join('\n  '))
      process.exitCode = 1
    }
  } catch (err) {
    console.error(`✗ 无法读取工具链文件: ${err.message}`)
    process.exitCode = 1
  }
}

module.exports = { computeDrift, readToolChain, checkToolChain }
