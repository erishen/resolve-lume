'use strict'
// Built-in tool registry + executor for resolve-lume.
//
// resolve-studio ships ~40 backend-native tools implemented in its TS backend.
// resolve-lume's execution engine is agent-httpd (a C binary) which only knows
// its own lume-tools bridge. Here we register ONLY the tools that resolve-lume
// can genuinely execute (locally in Node, or via a running docker service);
// schemas are mirrored verbatim from resolve-studio's /api/tools so the UI
// stays consistent. Tools whose dependencies are absent are simply not
// registered — no placeholders, no fake listings.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')
// Business tools ported from resolve-studio (PSE pipelines, article publishing,
// HTTP-service readers). Zero-dep; see business-helpers.js for shared runners.
const { BUSINESS } = require('./builtin-business')
const H = require('./business-helpers')
const progress = require('./progress')
const { isSensitivePath } = require('./security')

const SOULS_DIR = process.env.PSE_SOULS_DIR || '/app/souls'
const FS_ROOTS = (process.env.FS_ROOTS || '/app/souls,/app/lume-tools')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/app'

// ---- schemas (verbatim from resolve-studio's /api/tools; filtered below to
//      the locally-executable subset once LOCAL is defined) ----
let ALL_SCHEMAS = []
try {
  ALL_SCHEMAS = require('./builtin-tools.json').tools || []
} catch {
  ALL_SCHEMAS = []
}
const ALL_SCHEMA_NAMES = new Set(ALL_SCHEMAS.map((t) => t.name))
// Schema-level approval flag (mirrors resolve-studio's Tool.needsApproval).
// shell / make / hot-news-publish carry it today; server.js unions this with
// its own GATED_EXTRA list before prompting a human.
const GATED_SCHEMA_NAMES = ALL_SCHEMAS.filter((t) => t.needsApproval === true).map((t) => t.name)
// Tools whose side effects the schema predates: arbitrary profile writes,
// shared browser state, local file moves, external drafts/publishes. Mirrors
// resolve-studio's two-level policy:
//   - `needsApproval: true` / no rule  -> every call needs a human
//   - a predicate (studio's `approvalWhen`) -> only calls whose ARGS match are
//     gated, so read-only variants (list queue, preview) stay friction-free.
// article-publish is the concrete case: `confirm=true` really posts to
// WordPress, while omitting it only lists the queue.
const APPROVAL_RULES = new Map([
  ['write-file', () => true],
  ['browser-open', () => true],
  ['browser-screenshot', () => true],
  ['article-archive', () => true],
  ['article-publish', (a) => !!a && a.confirm === true],
  ['juejin-draft', () => true],
  ['juejin-publish', () => true],
  ['wechat-draft', () => true],
  ['sf-pw-publish', () => true],
  ['build-juejin', () => true],
])
// Names that MAY be gated (union of schema flag + rules), used by the panel to
// flag cards. Runtime decisions go through needsApproval(name, args).
const APPROVAL_GATED_NAMES = new Set(
  [...APPROVAL_RULES.keys(), ...GATED_SCHEMA_NAMES].filter((n) => n !== 'pse-review'),
)

/**
 * Decide whether this concrete call needs a human. Schema flag wins (always
 * gated); otherwise the tool's rule inspects the arguments (studio compat).
 */
function needsApproval(name, args) {
  if (name === 'pse-review') return false
  if (GATED_SCHEMA_NAMES.includes(name)) return true
  const rule = APPROVAL_RULES.get(name)
  return rule ? !!rule(args || {}) : false
}


// ---- path safety ----
// Symlinks are resolved before the containment check: a link placed inside an
// allowed root must not become a way to read/write outside it.
function realOrSelf(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
    } catch {
      return p
    }
  }
}
const REAL_ROOTS = FS_ROOTS.map(realOrSelf)
function resolveSafe(p) {
  const mapped = path.isAbsolute(p) ? p : H.mapRepoAlias(p)
  const abs = path.isAbsolute(mapped) ? path.resolve(mapped) : path.resolve(WORKSPACE_DIR, mapped)
  const real = realOrSelf(abs)
  const ok = REAL_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))
  if (!ok) throw new Error(`path "${p}" is outside allowed roots: ${FS_ROOTS.join(', ')}`)
  // Containment is not enough: FS_ROOTS includes the whole work/ tree and this
  // repo's own .env sits inside it. Never let a tool read or write key material.
  if (isSensitivePath(real)) {
    throw new Error(`path "${p}" targets a sensitive file (.env / private keys / credentials are blocked for tools)`)
  }
  return real
}

// ---- local implementations ----
// NOTE: fixed a pre-existing tokenizer bug — the old `-?\d+` number pattern
// swallowed the binary minus when directly adjacent to a digit (`12*8-4` was
// tokenized as [12,*,8,-4] and returned the stale output[0]=12). Numbers now
// tokenize without a leading sign, and a '-' in operator position that follows
// the start of the expression / another operator / '(' is treated as unary
// minus via an injected 0 (`-4`, `3*-4`, `2*(-3+4)` all evaluate correctly).
function evaluate(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]|\S/g)
  if (!tokens) throw new Error('empty expression')
  if (/\S/.test(expr.replace(/[-0-9+*/().\s]/g, ''))) {
    throw new Error('only + - * / ( ) and numbers are allowed')
  }
  const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const output = []
  const ops = []
  const apply = (op) => {
    const b = output.pop()
    const a = output.pop()
    output.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b)
  }
  let prev = null // 'num' | 'op' — the token before the current one
  for (const tok of tokens) {
    if (/^\d+(?:\.\d+)?$/.test(tok)) {
      output.push(parseFloat(tok))
      prev = 'num'
    } else if (tok === '(') {
      ops.push(tok)
      prev = 'op'
    } else if (tok === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') apply(ops.pop())
      if (ops.pop() !== '(') throw new Error('mismatched parentheses')
      prev = 'num'
    } else if (tok in PREC) {
      if (tok === '-' && prev !== 'num') {
        // unary minus → (0 - x). Push the 0 AND the '-' WITHOUT the precedence
        // drain: the 0 sits on top of output so the '-' binds to the operand
        // that follows, never to operators already on the stack (`3*-4` = -12,
        // `2*(-3+4)` = 2, while `4-12*8` = -92 stays binary).
        output.push(0)
        ops.push(tok)
        prev = 'op'
        continue
      }
      while (ops.length && ops[ops.length - 1] !== '(' && PREC[ops[ops.length - 1]] >= PREC[tok]) apply(ops.pop())
      ops.push(tok)
      prev = 'op'
    } else throw new Error(`unexpected token "${tok}"`)
  }
  while (ops.length) apply(ops.pop())
  const r = output[0]
  if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error('invalid expression')
  return String(r)
}

function runShell(command) {
  return new Promise((resolvePromise, reject) => {
    const TIMEOUT = 15000
    const MAX = 8 * 1024
    const child = spawn('sh', ['-c', command], {
      cwd: WORKSPACE_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // These two runners spawn locally instead of going through H.spawnCapture,
    // so pick up the same AsyncLocalStorage emitter to keep progress complete.
    const emit = progress.currentEmit()
    const collect = (isStdout) => (c) => {
      const text = c.toString()
      if (isStdout) stdout += text
      else stderr += text
      if (emit) emit(text)
    }
    child.stdout.on('data', collect(true))
    child.stderr.on('data', collect(false))
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== null && code !== 0 && !stdout && !stderr) {
        reject(new Error(`command failed with exit code ${code}`))
        return
      }
      let out = stdout
      if (stderr) out += out ? `\n[stderr]\n${stderr}` : stderr
      if (code !== null && code !== 0) out += `\n[exit code: ${code}]`
      else if (signal) out += `\n[killed by signal: ${signal}]`
      resolvePromise(out.length > MAX ? `${out.slice(0, MAX)}\n… [truncated at ${MAX} chars]` : out)
    }
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => finish(code, signal))
    const timer = setTimeout(() => {
      if (settled) return
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      setTimeout(() => {
        if (settled) return
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ }
        finish(null, 'SIGKILL')
      }, 2000).unref()
    }, TIMEOUT)
    timer.unref()
  })
}

// analyze-dir 的默认忽略名单。这不是我的偏好，而是 builtin-tools.json 里已经向 LLM
// 承诺过的契约——ignore 参数原文写着「node_modules/.git/.venv/caches are skipped by
// default」，而实现里 ignore 默认是空数组，什么都没跳。实测后果：agent 相信描述、
// 不传 ignore，一次扫描就被 .venv/.git 的上万文件淹没并撞上 MCP 单帧上限截断，
// 于是一个 16 轮的任务里它反复重扫同一个目录。
// 匹配是按「目录名精确相等」（ig.has(e.name)），所以这里只放字面名，不要放 glob。
const DEFAULT_DIR_IGNORE = [
  '.git', '.svn', '.idea', 'node_modules', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.turbo',
  'dist', 'build', '.next',
]
async function analyzeDir(dir, ignore = [], maxFiles = 500) {
  const root = resolveSafe(dir)
  const merged = [...DEFAULT_DIR_IGNORE, ...(Array.isArray(ignore) ? ignore : [])]
  const ig = new Set(merged.map((s) => s.trim()).filter(Boolean))
  const stats = { files: 0, dirs: 0, bytes: 0, byExt: {}, maxFilesHit: false }
  const lines = []
  async function walk(abs, depth, prefix) {
    if (stats.maxFilesHit) return
    let entries
    try { entries = await fsp.readdir(abs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (stats.maxFilesHit) return
      if (ig.has(e.name)) continue
      const full = path.join(abs, e.name)
      if (e.isDirectory()) {
        stats.dirs++
        lines.push(`${prefix}${e.name}/`)
        await walk(full, depth + 1, prefix + '  ')
      } else if (e.isFile()) {
        stats.files++
        let sz = 0
        try { sz = (await fsp.stat(full)).size } catch { /* ignore */ }
        stats.bytes += sz
        const ext = path.extname(e.name).toLowerCase() || '(none)'
        stats.byExt[ext] = (stats.byExt[ext] || 0) + 1
        lines.push(`${prefix}${e.name}  (${sz} B)`)
        if (stats.files >= maxFiles) { stats.maxFilesHit = true; lines.push('… [maxFiles reached]'); return }
      }
    }
  }
  await walk(root, 0, '')
  const extStr = Object.entries(stats.byExt)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join('  ')
  return `Directory report for ${root}\n` +
    `files=${stats.files} dirs=${stats.dirs} bytes=${stats.bytes} (${Math.round(stats.bytes / 1024)} KiB)\n` +
    (extStr ? `by extension: ${extStr}\n` : '') +
    (stats.maxFilesHit ? '(report truncated at maxFiles)\n' : '') +
    `\n${lines.join('\n')}`
}

async function privacyAudit(target, excludePath) {
  const root = resolveSafe(target)
  const ex = new Set((excludePath || '').split(',').map((s) => s.trim()).filter(Boolean))
  const findings = []
  const sensitiveNames = ['.env', 'credentials.json', 'secrets.json', '.npmrc', '.netrc', 'id_rsa', 'id_dsa', '*.pem', '*.key', 'service-account.json']
  const secretRe = /(?:api[_-]?key|secret|token|password|passwd|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/]{8,}/i
  const highEntropyRe = /['"](?:[A-Za-z0-9+/]{40,}={0,2})['"]/
  const gitignore = path.join(root, '.gitignore')
  let gitignoreText = ''
  try { gitignoreText = await fsp.readFile(gitignore, 'utf8') } catch { /* none */ }
  // 1. gitignore coverage of common secret files
  const missingIgnore = sensitiveNames.filter((n) => {
    const base = n.replace(/^\*\./, '')
    return gitignoreText.split('\n').every((l) => l.trim() && !l.trim().startsWith('#') && !l.includes(base) && !l.includes(n.replace('*', '')))
  })
  if (missingIgnore.length) findings.push(`[gitignore] 未忽略常见敏感文件: ${missingIgnore.join(', ')}`)
  // 2. tracked sensitive files present
  for (const n of ['.env', 'secrets.json', 'credentials.json', '.npmrc', '.netrc']) {
    if (fs.existsSync(path.join(root, n))) findings.push(`[文件] 存在敏感文件 ${n}（确认是否应被 gitignore）`)
  }
  // 3. env.example placeholder hygiene
  const eg = path.join(root, '.env.example')
  try {
    const t = await fsp.readFile(eg, 'utf8')
    const bad = t.split('\n').filter((l) => /=.+/.test(l) && !/=(<[^>]+>|your[-_ ]?.+|changeme|xxx+|TODO|example)/i.test(l.split('=')[1] || '') && !/<.+>/.test(l))
    if (bad.length) findings.push(`[env.example] 可能存在硬编码占位符: ${bad.slice(0, 5).join(' | ')}`)
  } catch { /* no env.example */ }
  // 4-5. scan text files for hardcoded secrets
  let scanned = 0
  let hitSecret = 0
  let hitEntropy = 0
  async function scan(abs) {
    if (scanned > 4000) return
    let entries
    try { entries = await fsp.readdir(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned > 4000) return
      if (ex.has(e.name)) continue
      const full = path.join(abs, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.data') continue
        await scan(full)
      } else if (/\.(js|ts|py|go|java|rb|sh|yml|yaml|json|env|txt|md|toml)$/i.test(e.name)) {
        scanned++
        let txt = ''
        try { txt = await fsp.readFile(full, 'utf8') } catch { continue }
        if (secretRe.test(txt)) hitSecret++
        if (highEntropyRe.test(txt)) hitEntropy++
      }
    }
  }
  await scan(root)
  if (hitSecret) findings.push(`[硬编码] ${hitSecret} 个文件命中密钥模式 (api_key/secret/token/password=...)，需人工复核`)
  if (hitEntropy) findings.push(`[高熵] ${hitEntropy} 个文件含高熵字符串（疑似密钥/base64），需人工复核`)
  // summary
  const summary =
    `隐私/密钥审计: ${root}\n扫描文本文件 ~${scanned}\n` +
    (findings.length ? `发现 ${findings.length} 项需关注:\n- ${findings.join('\n- ')}` : '未发现明显泄露迹象（仅做静态正则扫描，不含 git 历史深度扫描）')
  return summary
}

async function skillRun(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('name is required')
  // 常见误用：把「工具名」当「技能名」传给 skill-run（例如 skill-run({skill:
  // "article-write"})）。旧实现回 "skill not found"，模型据此推出「网关没挂载
  // 这个能力」——完全错误的结论。命中工具名时直接指路，别让它绕去读文件。
  if (ALL_SCHEMA_NAMES.has(n)) {
    // 别用 "error:" 开头：tools_api.c 会把以它开头的结果判为工具失败并返回
    // 502，模型/调用方会误以为工具本身挂了。这是一条正常的指路结果。
    return (
      `提示："${n}" 不是技能(skill)，而是已注册的工具(tool)。请直接调用工具 ` +
      `${n}${n === 'article-write' ? '（传 project=<项目名>，省略 project 可得候选清单）' : ''}；` +
      '不要用 read-file / analyze-code-dir 去猜仓库路径，也不要据此判断工具未挂载。'
    )
  }
  const soulPath = path.join(SOULS_DIR, n, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    let avail = ''
    try { avail = (await fsp.readdir(SOULS_DIR)).join(', ') } catch { /* none */ }
    return `error: skill "${n}" not found. Available: ${avail || '(none)'}`
  }
  const txt = await fsp.readFile(soulPath, 'utf8')
  let extra = ''
  try {
    const scripts = (await fsp.readdir(path.join(SOULS_DIR, n, 'scripts'))).filter((f) => !f.startsWith('.'))
    if (scripts.length) extra = `\n\nAvailable scripts:\n${scripts.map((s) => `- scripts/${s}`).join('\n')}`
  } catch { /* no scripts */ }
  return `## Skill: ${n}\n\n${txt}${extra}`
}

function systemInfo(section) {
  const mem = process.memoryUsage()
  const full = [
    `hostname: ${os.hostname()}`,
    `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
    `node: ${process.version}`,
    `cpus: ${os.cpus().length}`,
    `uptime: ${Math.floor(os.uptime())}s`,
    `loadavg: ${os.loadavg().map((n) => n.toFixed(2)).join(', ')}`,
    `totalmem: ${Math.round(os.totalmem() / 1048576)} MiB`,
    `freemem: ${Math.round(os.freemem() / 1048576)} MiB`,
    `rss: ${Math.round(mem.rss / 1048576)} MiB`,
  ]
  const sec = String(section || 'full')
  if (sec === 'memory') return full.filter((l) => /mem|rss/i.test(l)).join('\n')
  if (sec === 'cpu') return full.filter((l) => /cpu|loadavg|uptime/i.test(l)).join('\n')
  if (sec === 'platform') return full.filter((l) => /hostname|platform|node/i.test(l)).join('\n')
  return full.join('\n')
}

// POST JSON to an internal docker service and parse the reply.
function httpJson(url, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      },
      (resp) => {
        let buf = ''
        resp.setEncoding('utf8')
        resp.on('data', (c) => (buf += c))
        resp.on('end', () => {
          try { resolve(JSON.parse(buf)) } catch { reject(new Error(`non-JSON response (${resp.statusCode}): ${buf.slice(0, 120)}`)) }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)) })
    if (data) req.write(data)
    req.end()
  })
}

// stock-scan: A股全市场技术信号扫描 via the running stock-analyzer docker
// service (POST /api/scan, precomputed signals, ~0.1s). Output is a bounded
// summary: totals + per-signal-type counts + top strong signals.
const STOCK_SCAN_URL = process.env.STOCK_SCAN_URL || 'http://host.docker.internal:18001/api/scan'
const STOCK_SCAN_TOP = 20
async function stockScan(args) {
  const body = {}
  if (args && args.output && /^(macd|ma|trend|rsi|buy|sell|all)$/i.test(String(args.output))) body.signal_type = String(args.output)
  if (args && args.limit) body.limit = Number(args.limit)
  const d = await httpJson(STOCK_SCAN_URL, body)
  if (!d || !d.success) throw new Error('scan failed: unexpected service reply')
  const sigs = d.signals || []
  const byType = {}
  let strong = 0
  for (const s of sigs) {
    byType[s.signal_type] = (byType[s.signal_type] || 0) + 1
    if (s.strength === '强') strong++
  }
  const typeStr = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')
  const top = sigs.filter((s) => s.strength === '强').slice(0, STOCK_SCAN_TOP)
  const lines = top.map((s) =>
    `${s.date}  ${s.code} ${s.name}  ${s.signal_type}  score=${s.score}  price=${s.price}  ${s.change_percent >= 0 ? '+' : ''}${s.change_percent}%`)
  return [
    `A股全市场技术信号扫描（stock-analyzer）`,
    `扫描股票数: ${d.total_stocks}    信号总数: ${d.signals_found}    强信号: ${strong}`,
    typeStr ? `按信号类型: ${typeStr}` : '',
    '',
    `强信号 Top ${top.length}（按 score 降序）:`,
    lines.length ? lines.join('\n') : '(无强信号)',
  ].filter(Boolean).join('\n')
}

// Run a make target in a host project. Host repo root is bind-mounted at
// /workspace (writable) so `make -C` operates on real host files. Targets are
// single words (no shell metachars) and extra args must be plain KEY=VALUE
// tokens — anything richer should go through the `shell` tool instead.
function runMake(dir, target, extraArgs) {
  return new Promise((resolvePromise, reject) => {
    const TIMEOUT = 300000
    const MAX = 16 * 1024
    let root
    try {
      root = resolveSafe(String(dir || '').trim())
    } catch (e) {
      reject(e)
      return
    }
    if (!fs.existsSync(path.join(root, 'Makefile'))) {
      reject(new Error(`no Makefile in ${root}`))
      return
    }
    const argv = ['--no-print-directory', '-C', root]
    const t = String(target || '').trim()
    if (t) {
      if (!/^[A-Za-z0-9_./%-]+$/.test(t)) {
        reject(new Error(`invalid target "${t}" (single word only)`))
        return
      }
      argv.push(t)
    }
    const ea = String(extraArgs || '').trim()
    if (ea) {
      if (ea.length > 200 || /[;&|`$"']/.test(ea)) {
        reject(new Error('invalid args (plain KEY=VALUE tokens only)'))
        return
      }
      argv.push(...ea.split(/\s+/))
    }
    const child = spawn('make', argv, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // These two runners spawn locally instead of going through H.spawnCapture,
    // so pick up the same AsyncLocalStorage emitter to keep progress complete.
    const emit = progress.currentEmit()
    const collect = (isStdout) => (c) => {
      const text = c.toString()
      if (isStdout) stdout += text
      else stderr += text
      if (emit) emit(text)
    }
    child.stdout.on('data', collect(true))
    child.stderr.on('data', collect(false))
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let out = `$ make -C ${root}${t ? ' ' + t : ''}${ea ? ' ' + ea : ''}\n`
      out += stdout
      if (stderr) out += out.endsWith('\n') || !out ? stderr : `\n[stderr]\n${stderr}`
      if (code !== null && code !== 0) out += `\n[exit code: ${code}]`
      else if (signal) out += `\n[killed by signal: ${signal}]`
      resolvePromise(out.length > MAX ? `${out.slice(0, MAX)}\n… [truncated at ${MAX} chars]` : out)
    }
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => finish(code, signal))
    const timer = setTimeout(() => {
      if (settled) return
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      setTimeout(() => {
        if (settled) return
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ }
        finish(null, 'SIGKILL')
      }, 2000).unref()
    }, TIMEOUT)
    timer.unref()
  })
}

// Map of locally-executable tool names -> async (args) => string
const LOCAL = {
  capabilities: async () => capabilities(),
  echo: async (a) => String(a.text ?? ''),
  calculator: async (a) => evaluate(String(a.expression ?? '')),
  'read-file': async (a) => {
    const abs = resolveSafe(String(a.path || ''))
    const offset = Math.max(1, Number(a.offset || 1))
    const limit = Math.min(2000, Math.max(1, Number(a.limit || 2000)))
    const buf = await fsp.readFile(abs)
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    const slice = lines.slice(offset - 1, offset - 1 + limit).join('\n')
    const truncated = buf.length > 65536 ? '\n… [truncated at 64 KiB]' : ''
    return slice + truncated
  },
  'write-file': async (a) => {
    const abs = resolveSafe(String(a.path || ''))
    const content = String(a.content ?? '')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
    return `wrote ${content.length} chars to ${abs}`
  },
  shell: async (a) => {
    const cmd = String(a.command || '').trim()
    if (!cmd) throw new Error('command is required')
    if (cmd.length > 2000) throw new Error('command too long (max 2000)')
    return runShell(cmd)
  },
  'analyze-dir': async (a) => analyzeDir(String(a.dir || WORKSPACE_DIR), a.ignore, Number(a.maxFiles || 500)),
  'skill-run': async (a) => skillRun(a.name || a.skill || a.skill_name),
  'system-info': async (a) => systemInfo(a.section),
  'privacy-audit': async (a) => privacyAudit(String(a.target || ''), a.exclude_path),
  'stock-scan': async (a) => stockScan(a),
  make: async (a) => {
    const dir = String(a.dir || '').trim()
    if (!dir) throw new Error('dir is required, e.g. /workspace/<project-dir>')
    return runMake(dir, a.target, a.args)
  },
}

// Business tools (resolve-studio port) join the local map so every schema in
// builtin-tools.json becomes executable — no more routing to agent-httpd, which
// does not host them.
Object.assign(LOCAL, BUSINESS)


// Validate required params against the schema before executing.
function checkRequired(name, args) {
  const def = BUILTIN_TOOLS.find((t) => t.name === name)
  const req = (def && def.parameters && def.parameters.required) || []
  for (const r of req) {
    if (args[r] === undefined || args[r] === null || args[r] === '') {
      throw new Error(`missing required parameter: ${r}`)
    }
  }
}

// Only the locally-executable subset is registered — schemas are kept verbatim
// from resolve-studio so descriptions/params stay faithful.
const BUILTIN_TOOLS = ALL_SCHEMAS.filter((t) => !!LOCAL[t.name])
// Dispatch set: must match what we can actually run. Using ALL_SCHEMA_NAMES here
// would route ~31 non-executable tools into executeBuiltinTool() ("未注册")
// instead of letting the router proxy them to agent-httpd.
const BUILTIN_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name))

// Execute a built-in tool. Returns a result string. Throws on hard error.
// `onProgress` is optional: when present it is installed in an
// AsyncLocalStorage context so every child process spawned anywhere below this
// call (runPseTask / runPseScript / spawnCapture) streams its stdout as
// progress without any business tool having to accept a callback.
async function executeBuiltinTool(name, args, onProgress) {
  if (!LOCAL[name]) {
    const err = new Error(`unknown built-in tool: ${name}`)
    err.code = 'UNKNOWN_TOOL'
    throw err
  }
  // 模型常把参数写成同义键（skill-run 的 skill、read-file 的 file、
  // article-write 的 repo…），lume-core 会保留未知键，但 checkRequired 会在
  // handler 之前就拒绝。统一在必填校验之前归一化，覆盖全部工具。
  const a = normalizeArgs(name, args)
  checkRequired(name, a)
  const result = await progress.runWithEmit(onProgress, () => LOCAL[name](a))
  // `error: ...` 会被 agent-httpd 判成协议失败(502)并从上下文丢弃，
  // 统一改写成普通文本，让模型能读到真正的失败原因。
  return normalizeToolError(result)
}

// Business tools historically return `error: ...` as a NORMAL result string.
// agent-httpd's tools_api.c treats any MCP result starting with `error:` as a
// PROTOCOL failure (502) and drops the text from the ReAct context, so the
// model sees an opaque failure and loops/retries instead of reading the real
// reason ("service not running", "unknown platform", "pipeline exited 1").
// Normalize once at the single execution choke point: fixes all 42 tools and
// both callers (frontend panel + MCP bridge) without touching each handler.
function normalizeToolError(result) {
  const s = String(result == null ? '' : result)
  return /^error:\s*/i.test(s) ? 'tool error: ' + s.replace(/^error:\s*/i, '') : s
}

// Models routinely use a different but obvious key (skill vs name, file vs
// path, repo vs project). lume-core keeps unknown keys, so they do reach here,
// but checkRequired() then rejects the call before the handler can help.
// Map them back to the schema's canonical name instead of failing silently.
const ARG_ALIASES = {
  'skill-run':           { name: ['skill', 'skill_name'] },
  'read-file':           { path: ['file', 'filename', 'file_path'] },
  'analyze-dir':         { dir: ['path', 'repo', 'folder'] },
  'analyze-code-dir':    { dir: ['path', 'repo', 'folder'] },
  'privacy-audit':       { target: ['dir', 'repo', 'path'] },
  'article-write':       { project: ['repo', 'name'] },
  'article-validate':    { project: ['repo', 'name'] },
  'article-publish':     { project: ['repo', 'name'] },
  'article-archive':     { project: ['repo', 'name'] },
  'doc-library-search':  { q: ['query', 'keyword'] },
  'hot-news':            { topic: ['keyword', 'subject'] },
}

function normalizeArgs(name, args) {
  const a = { ...(args || {}) }
  for (const [canonical, alts] of Object.entries(ARG_ALIASES[name] || {})) {
    if (a[canonical] !== undefined && a[canonical] !== '') continue
    for (const alt of alts) {
      if (a[alt] !== undefined && a[alt] !== '') { a[canonical] = a[alt]; break }
    }
  }
  // 类型归一化：桥对 LOOSE_PARAMS 不声明类型，由这里把常见误传转成实现
  // 期望的形状，避免 lume-core 在 handler 之前回 `error: invalid argument type`。
  if (name === 'hot-news-fetch' && Array.isArray(a.sources)) a.sources = a.sources.join(',')
  return a
}

// Authoritative set of tools exposed to the conversational Agent. It is parsed
// from the GENERATED bridge, so it can never drift from what the agent actually
// sees. server.js enforces this set on /api/tools/call: previously the 24-tool
// allowlist only constrained the .lume bridge, while any local HTTP client
// could invoke all 44 builtins (shell / write / publish) at that endpoint.
function readAgentToolAllow() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lume-tools', 'sidecar_ro.lume'), 'utf8')
    return new Set([...src.matchAll(/^tool "([^"]+)"/gm)].map((m) => m[1]))
  } catch {
    return new Set() // bridge not generated yet -> fail closed
  }
}
const AGENT_TOOL_ALLOW = readAgentToolAllow()

// Read-only capability catalogue. The previous incident ("网关没挂载
// article-write") happened because the agent could only see its own 23 tools
// and concluded the other 19 did not exist. Give it the authoritative list —
// derived from the generated bridge, so it can never drift from what is real.
function capabilities() {
  const exposed = [...AGENT_TOOL_ALLOW]
  const set = new Set(exposed)
  const implemented = BUILTIN_TOOLS.map((t) => t.name)
  const held = implemented.filter((n) => !set.has(n))
  return [
    `# resolve-lume 能力清单（已实现 ${implemented.length} 个）`,
    '',
    `## 对当前 Agent 开放（${exposed.length} 个，可直接调用）`,
    ...exposed.map((n) => `- ${n}`),
    '',
    `## 已实现、但未对 Agent 开放（${held.length} 个）`,
    ...held.map((n) => `- ${n}`),
    '',
    '重要：这些工具在本系统里确实存在并有真实实现，只是未挂到 Agent 的工具桥（写盘 / 对外发布 / 任意命令 / 付费流水线，安全考虑）。',
    '当用户要求它们时，禁止回答「网关没有挂载 / 能力不存在 / 请换网关 / 请提供素材代替」。',
    '正确回答：说明该能力存在但未对当前对话 Agent 开放，给出工具名，指引用户在前端工具面板执行。',
    '调用本工具本身永远安全（只读）。遇到「某能力是否可用」「帮我发布」「跑 make / shell」这类问题时先调本工具。',
  ].join('\n')
}

module.exports = { BUILTIN_TOOLS, BUILTIN_NAMES, ALL_SCHEMA_NAMES, GATED_SCHEMA_NAMES, APPROVAL_GATED_NAMES, needsApproval, AGENT_TOOL_ALLOW,
                   executeBuiltinTool, normalizeToolError, normalizeArgs, capabilities }
