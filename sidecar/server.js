'use strict'
// resolve-lume sidecar: API gateway + feature backend.
//
// - Proxies /api/chat, /api/pse, /api/tools, /api/tool/run to the lume
//   agent-httpd C binary (with SSE dialect translation).
// - Implements the rest of resolve-studio's /api/* surface that agent-httpd does
//   not provide: sessions, jobs, tasks, skills, models, usage, fs, mcp, approval,
//   workspace, desktop-login, file preview, memory.
//
// Zero external dependencies (Node built-ins only) so it runs without npm install.
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

// Host-mode env bootstrap: read repo-root .env and inject ONLY whitelisted
// business vars into process.env. Must run BEFORE any `const X = process.env.Y`
// below. Silent no-op when .env is absent (container mode: env comes from
// compose/entrypoint). Already-set ambient env wins over .env (start-host.sh
// explicit values take precedence).
try {
  const { loadEnvFile, whitelist } = require('./envloader')
  loadEnvFile(path.join(__dirname, '..', '.env'), whitelist)
} catch {
  // .env missing/unreadable — rely on ambient env (container entrypoint).
}

const store = require('./store')
const agent = require('./agent')
const builtin = require('./builtin-exec')
const H = require('./business-helpers')
const { isSensitivePath, tokenMatches, MAX_PREVIEW_BYTES } = require('./security')

// Guard against a stray PORT=0 / non-numeric value in the environment: Node
// would bind an ephemeral port and every nginx proxy would silently 502.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000
// Bind loopback by default: this process can run shell commands and write host
// files, so a bare `node server.js` must not be reachable from the network.
// Inside compose the service sets HOST=0.0.0.0 because the port is
// only exposed on the compose network (frontend -> sidecar:3000).
const HOST = process.env.HOST || '127.0.0.1'
// Shared secret injected by the frontend proxy on /api. Fail closed: this
// process can execute shell, so "empty token = no auth" is NOT a safe default
// (it used to be, and the source tree even shipped a public fallback value).
// Frontend, backend bridge and this sidecar all read the same .env value.
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN || ''
if (!SIDECAR_TOKEN) {
  console.error('[sidecar] FATAL: SIDECAR_TOKEN is not set. Add a random value to .env (openssl rand -hex 32); see .env.example.')
  process.exit(1)
}
const SOULS_DIR = process.env.PSE_SOULS_DIR || '/app/souls'
const FS_ROOTS = (process.env.FS_ROOTS || '/app/souls,/app/lume-tools')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || ''
const AGENT_URL = process.env.AGENT_HTTPD_URL || 'http://backend:8080'

// ---------- helpers ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}
// Cap request bodies: this API writes host files and drives an LLM, so an
// unbounded body is both a memory DoS and an easy way to wedge the process.
const MAX_BODY = 10 * 1024 * 1024
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > MAX_BODY) {
        settled = true
        const err = new Error('request body too large')
        err.statusCode = 413
        req.destroy()
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
function uid(prefix) {
  return (prefix || '') + Math.random().toString(36).slice(2, 10)
}
// Resolve symlinks before containment checks: a link placed inside a read root
// must not become a way to read/write outside it.
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
const REAL_FS_ROOTS = FS_ROOTS.map(realOrSelf)
function isInsideRoot(abs) {
  const real = realOrSelf(abs)
  return REAL_FS_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))
}

// Shared guard for /api/file and /api/raw. Returns the absolute path, or null
// after having written the error response. Containment alone is NOT enough:
// FS_ROOTS includes the whole work/ tree, which also contains this repo's own
// .env — so key material must be rejected by name as well as by location.
function guardedFilePath(res, fp) {
  if (!fp) {
    send(res, 400, { error: 'missing path' })
    return null
  }
  const abs = path.resolve(fp)
  if (!isInsideRoot(abs)) {
    send(res, 403, { error: 'path outside read roots' })
    return null
  }
  if (isSensitivePath(abs) || isSensitivePath(realOrSelf(abs))) {
    send(res, 403, { error: 'sensitive file is blocked (.env / keys / credentials)' })
    return null
  }
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    send(res, 404, { error: 'file not found' })
    return null
  }
  if (!st.isFile()) {
    send(res, 400, { error: 'not a regular file' })
    return null
  }
  if (st.size > MAX_PREVIEW_BYTES) {
    send(res, 413, { error: 'file too large for preview' })
    return null
  }
  return abs
}

// In-flight upstream requests for running jobs, so /cancel can abort the LLM
// stream instead of letting it burn tokens until the end.
const activeRuns = new Map()

// ---------- per-collection accessors ----------
const sessions = () => store.read('sessions', {})
const saveSessions = (s) => store.write('sessions', s)
const memory = () => store.read('memory', { items: [] })
const saveMemory = (m) => store.write('memory', m)
const pseState = () => store.read('pse', { enabled: true })
const savePse = (p) => store.write('pse', p)

// UI-controlled free/paid PSE provider (mirrors pseState): the chat 免费/付费
// switch sets this, and every PSE tool defaults to it unless the call passes an
// explicit `provider`.
const pseProviderState = () => store.read('pse-provider', { provider: H.getPseProvider() })
const savePseProvider = (p) => {
  H.setPseProvider(p.provider)
  store.write('pse-provider', p)
}
// Restore the last UI choice on boot (defaults to PSE_REVIEW_PROVIDER env / 'free').
;(() => {
  try {
    const s = pseProviderState()
    H.setPseProvider(s.provider)
  } catch {
    /* store unavailable — keep env default */
  }
})()
const mcpState = () => store.read('mcp', { servers: [] })
const saveMcp = (m) => store.write('mcp', m)

// Sync the MCP registry with the bundled mcp-servers.json on every startup, so
// the UI reflects the servers agent-httpd actually loads (e.g. lume-tools +
// the npx-based fs/fetch/git/memory/think). Declared servers are always present
// with their static fields; runtime-added servers (not in the config) are kept,
// and previously backfilled status/toolCount/tools are preserved across restarts.
function seedMcpRegistry() {
  const SEED_PATH = process.env.MCP_SEED_FILE || '/app/mcp-servers.json'
  let declared = []
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))
    if (Array.isArray(seed)) declared = seed
  } catch {
    /* no seed file — keep whatever is in the store */
  }
  const existing = mcpState().servers || []
  const byId = new Map(existing.map((s) => [s.id, s]))
  const declaredIds = new Set(declared.map((s) => s.id))
  const merged = declared.map((s) => {
    const prev = byId.get(s.id) || {}
    return {
      id: s.id,
      transport: s.transport || 'stdio',
      command: s.command,
      args: s.args,
      url: s.url,
      approval: s.approval !== false,
      status: prev.status || 'connected',
      toolCount: prev.toolCount || 0,
      tools: prev.tools || [],
    }
  })
  // preserve runtime-added servers that are not in the declared config
  for (const s of existing) {
    if (!declaredIds.has(s.id)) merged.push(s)
  }
  saveMcp({ servers: merged })
  console.log(`[sidecar] synced ${merged.length} MCP server(s) (${declared.length} declared) from ${SEED_PATH}`)
}

// ---------- HTTP MCP client (streamableHttp / SSE) ----------
// The lume-family MCP bridges (mcp-fs / mcp-memory / mcp-think) are supergateway
// instances that wrap a node stdio server and expose it as streamableHttp on :8000.
// agent-httpd's C MCP client only supports stdio (and can't handshake node servers),
// so the sidecar — being a Node process — speaks HTTP MCP to them directly and
// registers them in the registry the frontend reads.
function probeHttpMcp(url) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return resolve({ ok: false, error: 'bad url' })
    }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    function call(method, params, sid) {
      return new Promise((res, rej) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1e6),
          method,
          params,
        })
        const req = http.request(
          {
            host: u.hostname,
            port: u.port || 80,
            path: u.pathname || '/',
            method: 'POST',
            headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
            timeout: 8000,
          },
          (resp) => {
            const outSid = resp.headers['mcp-session-id']
            let buf = ''
            resp.on('data', (c) => (buf += c))
            resp.on('end', () => {
              let txt = buf
              const ct = resp.headers['content-type'] || ''
              if (ct.includes('text/event-stream')) {
                txt = buf
                  .split('\n')
                  .filter((l) => l.startsWith('data:'))
                  .map((l) => l.slice(5).trim())
                  .join('')
              }
              if (!txt.trim()) return res({ sid: outSid || sid, result: null })
              try {
                res({ sid: outSid || sid, result: JSON.parse(txt).result })
              } catch (e) {
                rej(e)
              }
            })
          }
        )
        req.on('error', rej)
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.write(body)
        req.end()
      })
    }
    ;(async () => {
      const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'resolve-lume-sidecar', version: '1.0' },
      })
      const sid = init.sid
      // notifications/initialized is a notification — fire-and-forget, no response.
      const nb = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const nr = http.request(
        { host: u.hostname, port: u.port || 80, path: u.pathname || '/', method: 'POST', headers: { ...headers, 'mcp-session-id': sid } },
        () => {}
      )
      nr.on('error', () => {})
      nr.write(nb)
      nr.end()
      await new Promise((r) => setTimeout(r, 200))
      const tl = await call('tools/list', {}, sid)
      const tools =
        tl.result && tl.result.tools
          ? tl.result.tools.map((t) => ({ name: t.name, description: t.description || '' }))
          : []
      resolve({ ok: true, tools })
    })().catch((e) => resolve({ ok: false, error: e.message }))
  })
}

// Probe each HTTP MCP server and backfill its status/toolCount/tools. Retry while
// the bridges are still warming up (they share the tsm-hub network with us).
let httpRefreshAttempts = 0
function refreshHttpMcpServers() {
  const m0 = mcpState()
  const targets = (m0.servers || []).filter((s) => s.transport === 'http' && s.url)
  if (targets.length === 0) return
  const results = {}
  let pending = targets.length
  let anyOk = false
  const finish = () => {
    if (--pending > 0) return
    // Re-read the store fresh so we never clobber the stdio backfill (which may
    // have saved in the meantime) and only patch the HTTP servers we own.
    const m = mcpState()
    for (const s of m.servers) {
      const r = results[s.id]
      if (!r) continue
      s.status = r.ok ? 'connected' : 'error'
      s.toolCount = r.ok ? r.tools.length : 0
      s.tools = r.ok ? r.tools.map((t) => t.name) : []
      s.toolDetails = r.ok ? Object.fromEntries(r.tools.map((t) => [t.name, t.description || ''])) : {}
      if (r.ok) anyOk = true
    }
    saveMcp(m)
    if (anyOk) {
      console.log(`[sidecar] refreshed ${targets.length} HTTP MCP server(s)`)
    } else if (httpRefreshAttempts++ < 20) {
      setTimeout(refreshHttpMcpServers, 3000)
    } else {
      console.log(`[sidecar] HTTP MCP servers unreachable after retries`)
    }
  }
  for (const s of targets) {
    probeHttpMcp(s.url)
      .then((r) => {
        results[s.id] = r
      })
      .catch((e) => {
        results[s.id] = { ok: false, error: e.message }
      })
      .finally(finish)
  }
}

// ---------- tools: merge backend built-ins + MCP-bridge tools ----------
// resolve-studio's /api/tools returns a FLAT list (built-in tools + MCP tools
// like `fs:read_file`). agent-httpd only knows its own lume-tools bridge, so we
// fetch those from the backend and merge in the tools we discovered from the
// HTTP MCP bridges (fs / memory / think) to mirror that flat shape.
function handleToolsList(res) {
  const finish = (tools) => send(res, 200, { tools })
  let base = []
  const u = new URL(AGENT_URL)
  const req = http.request(
    { method: 'GET', hostname: u.hostname, port: u.port || 80, path: '/react/api/tools', timeout: 5000 },
    (resp) => {
      let body = ''
      resp.on('data', (c) => (body += c))
      resp.on('end', () => {
        try {
          const data = JSON.parse(body)
          // 去掉代理层回灌进来的镜像条目。lume-tools/sidecar_ro.lume 把本仓的 builtin
          // 又包了一层 stdio MCP，agent 会把这些能力以 sidecar__<name> 报回来；而下面
          // 紧接着会追加 BUILTIN_TOOLS 的同名权威条目。不去重，面板就会从 47 涨到 68
          // 并出现同义双条目（read-file 与 sidecar__read-file 并存）。
          // 判据用名字前缀/server id 而不是写死条数，这样以后增减 --only 名单都不用改这里。
          base = (data.tools || [])
            .filter((t) => !/^sidecar__/.test(t.name || '') && (t.server || '') !== 'sidecar')
            .map((t) => ({
              name: t.name,
              description: t.description || t.desc || '',
              server: t.server || 'lume-tools',
              parameters: t.parameters || {},
              fromMcp: false,
            }))
        } catch {
          /* backend returned non-JSON */
        }
        const reg = mcpState()
        const merged = [...base]
        for (const s of reg.servers || []) {
          // Only the HTTP bridges are "MCP tools" here — the stdio lume-tools
          // bridge is already surfaced by the backend as built-ins.
          if (s.transport !== 'http' || !s.tools || !s.tools.length) continue
          const details = s.toolDetails || {}
          for (const tool of s.tools) {
            merged.push({
              name: `${s.id}:${tool}`,
              description: details[tool] || `${s.id} MCP tool`,
              server: s.id,
              parameters: {},
              fromMcp: true,
            })
          }
        }
        for (const t of builtin.BUILTIN_TOOLS) {
          merged.push({
            name: t.name,
            description: t.description || '',
            server: t.server || 'builtin',
            parameters: t.parameters || {},
            needsApproval: !!t.needsApproval,
            fromMcp: false,
          })
        }
        finish(merged)
      })
    }
  )
  req.on('error', () => finish(base))
  req.on('timeout', () => req.destroy())
  req.end()
}

// ---------- tasks catalog (dynamic: built from SOULS_DIR business souls) ----------
// resolve-studio ships a static task registry (packages/core/src/plugins/tasks.ts)
// where each task bundles a tool whitelist + a system prompt. resolve-lume keeps
// the same contract but derives the catalog from the souls on disk: every
// SOULS_DIR subdir whose SOUL.md carries YAML frontmatter is a business task;
// the frontmatter (name/description/triggers/tools) is the task metadata and the
// markdown body is the per-task system prompt injected into agent-httpd. The PSE
// role souls (planner/specialist/evaluator) are consumed by pse.c and are NOT
// user-selectable tasks, so they are skipped here.
const PSE_ROLE_DIRS = new Set(['planner', 'specialist', 'evaluator'])

// Parse a minimal YAML frontmatter block (`---\nkey: value\n---\n`) into a flat
// { key: value } map plus the body text after it. Returns null when the file has
// no frontmatter (e.g. a PSE role soul, which is plain markdown).
function parseSoulFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const data = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const idx = raw.indexOf(':')
    if (idx <= 0) continue
    const key = raw.slice(0, idx).trim()
    let val = raw.slice(idx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    data[key] = val
  }
  return { data, body: text.slice(m[0].length) }
}

// Build the task catalog fresh from disk. Cheap (a handful of small files) and
// keeps the catalog in sync with SOULS_DIR without a restart when a soul is
// added or edited.
function buildTasks() {
  const tasks = [
    {
      id: 'general',
      name: '通用对话',
      description: '默认模式：单 agent 直接对话（不启用 PSE 三角色）。',
      triggers: '',
      includeTools: [],
      systemPrompt: '',
    },
  ]
  try {
    const names = fs.readdirSync(SOULS_DIR)
    for (const name of names) {
      if (PSE_ROLE_DIRS.has(name)) continue
      const soulPath = path.join(SOULS_DIR, name, 'SOUL.md')
      if (!fs.existsSync(soulPath)) continue
      const txt = fs.readFileSync(soulPath, 'utf8')
      const fm = parseSoulFrontmatter(txt)
      if (!fm) continue // plain markdown (PSE role) -> not a user task
      const tools = (fm.data.tools || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      tasks.push({
        id: name,
        name: fm.data.name || name,
        description: fm.data.description || '',
        triggers: fm.data.triggers || '',
        includeTools: tools,
        systemPrompt: fm.body.trim(),
      })
    }
  } catch {
    /* souls dir missing -> only the meta tasks remain */
  }
  tasks.push({
    id: 'pse-review',
    name: 'PSE 三角色评审',
    description: 'Planner / Specialist / Evaluator 三角色协作，适合需要多视角评审的任务。',
    triggers: '',
    includeTools: [],
    systemPrompt: '',
  })
  return tasks
}

// Resolve a task by id (or undefined when absent/empty).
function getTask(id) {
  if (!id) return undefined
  return buildTasks().find((t) => t.id === id)
}
const SCOPES = [
  { id: 'core', name: '核心', description: '仅内置工具', includeTools: [] },
  { id: 'files', name: '+文件', description: '允许读写文件', includeTools: ['read', 'write', 'list'] },
]

// ---------- skills: scan souls dir for SOUL.md ----------
function scanSkills() {
  const out = []
  try {
    const names = fs.readdirSync(SOULS_DIR)
    for (const name of names) {
      const soulPath = path.join(SOULS_DIR, name, 'SOUL.md')
      if (!fs.existsSync(soulPath)) continue
      const txt = fs.readFileSync(soulPath, 'utf8')
      // first non-empty, non-# line as description
      const desc = txt
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))
      out.push({ name, description: desc || '' })
    }
  } catch {
    /* souls dir missing */
  }
  return out
}

// ---------- jobs: background PSE/chat run with event log ----------
function startJobRun(id, input) {
  const j = store.job.get(id)
  if (!j) return
  const usePse = input.taskId === 'pse-review' || j.taskId === 'pse-review'
  const backendPath = usePse ? '/react/api/pse' : '/react/api/chat'
  // `history` carries the prior transcript on /resume; `instruction` is the
  // optional steer the UI collected, appended to the original prompt.
  const history = Array.isArray(input.history) ? input.history : []
  const prompt = input.instruction
    ? `${input.prompt}\n\n补充要求：${input.instruction}`
    : input.prompt
  const body = JSON.stringify({ message: prompt, history })
  const u = new URL(AGENT_URL)
  const req = http.request(
    {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 80,
      path: backendPath,
      headers: { 'Content-Type': 'application/json' },
    },
    (resp) => {
      let pending = ''
      let answer = ''
      let seq = 0
      resp.setEncoding('utf8')
      resp.on('data', (chunk) => {
        pending += chunk
        let idx
        while ((idx = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, idx)
          pending = pending.slice(idx + 2)
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          let json
          try {
            json = JSON.parse(dataLine.slice(5).trim())
          } catch {
            continue
          }
          seq += 1
          if (json.t === 'delta') {
            answer += json.d || ''
            appendJobEvent(id, { seq, type: 'delta', text: json.d || '' })
          } else if (json.t === 'note') {
            appendJobEvent(id, { seq, type: 'reasoning', text: json.d || '' })
          } else if (json.t === 'error') {
            appendJobEvent(id, { seq, type: 'error', message: json.d || '' })
            finishJob(id, 'failed', null, json.d)
          } else if (json.t === 'done') {
            appendJobEvent(id, { seq, type: 'done', answer })
            finishJob(id, 'succeeded', answer, null)
          }
        }
      })
      resp.on('end', () => {
        if (j.status === 'running') finishJob(id, 'succeeded', answer, null)
      })
      resp.on('error', () => {
        if (j.status === 'running') finishJob(id, 'failed', null, 'stream error')
      })
    },
  )
  req.on('error', () => finishJob(id, 'failed', null, 'agent-httpd unreachable'))
  activeRuns.set(id, req)
  req.write(body)
  req.end()
}
function appendJobEvent(id, ev) {
  store.job.appendEvent(id, ev)
}
function finishJob(id, status, answer, error) {
  activeRuns.delete(id)
  const j = store.job.get(id)
  if (!j || j.status !== 'running') return
  const patch = { status, finishedAt: new Date().toISOString() }
  if (answer != null) patch.answer = answer
  if (error) patch.error = error
  store.job.update(id, patch)
}

// Execute a built-in tool and stream its result as resolve-studio SSE frames.
function runBuiltinSSE(res, name, args) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const frame = (event, obj) => 'event: ' + event + '\n' + 'data: ' + JSON.stringify(obj) + '\n\n'
  ;(async () => {
    try {
      const text = await builtin.executeBuiltinTool(name, args)
      res.write(frame('delta', { text: String(text) }))
      res.write(frame('done', { answer: String(text) }))
    } catch (err) {
      if (err.code === 'UNKNOWN_TOOL') {
        res.write(frame('delta', { text: '[' + name + '] 未注册' }))
        res.write(frame('done', { answer: '' }))
      } else {
        res.write(frame('error', { message: err.message || 'tool execution failed' }))
      }
    }
    res.end()
  })()
}

// ---------- tool-layer 归属探测 ----------
// 归属不能写死：宿主模式下 sidecar 是 launcher(:3099) 监管的子进程，容器模式下才归
// compose，裸跑 `node server.js` 则无人监管。判据 = 问 launcher 控制面它监管的 pid
// 是不是本进程（认领 = 'launcher'）。无人认领时按运行环境回落：/.dockerenv 存在 = 容器。
// 为什么不用 /proc/1/cgroup 判容器：实测 OrbStack 容器里它是 "0::/"，不含 docker 字样；
// /.dockerenv 在这个环境里确实存在。macOS 宿主两者都没有 → 'detached'。
function inContainer() {
  try {
    return fs.existsSync('/.dockerenv')
  } catch {
    return false
  }
}

function managedFallback() {
  return inContainer() ? 'compose' : 'detached'
}

function probeManaged() {
  const url = process.env.LAUNCHER_STATUS_URL || 'http://127.0.0.1:3099/status'
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return resolve(managedFallback())
    }
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname || '/status',
        method: 'GET',
        timeout: 400,
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          let pid = null
          try {
            pid = JSON.parse(buf).pid
          } catch {
            /* 非 JSON 应答 = 不是本项目的 launcher，不可认领 */
          }
          resolve(pid === process.pid ? 'launcher' : managedFallback())
        })
      },
    )
    // 超时/连不上（宿主模式没有 launcher、或容器里没有 :3099）都走回落分支。
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(managedFallback()))
    req.end()
  })
}

// ---------- router ----------
async function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = parsed.pathname
  const method = req.method
  const q = parsed.searchParams

  // Defense in depth: the frontend proxy injects the shared token on /api.
  // Any other local process therefore cannot drive this API (which can write
  // host files and run shell) even though it can reach sidecar:3000.
  // /health stays open for the container healthcheck and the launcher probe.
  if (p !== '/health' && !tokenMatches(req.headers['x-sidecar-token'], SIDECAR_TOKEN)) {
    return send(res, 401, { error: 'unauthorized' })
  }

  // ---- PSE toggle ----
  // Must be handled BEFORE the chat gateway below: POST /api/pse is the UI's
  // toggle (body {enabled}), not a chat turn. Forwarding it to agent-httpd's
  // /react/api/pse would start a three-role run with an empty message.
  if (p === '/api/pse' && method === 'GET') {
    const st = pseState()
    return send(res, 200, {
      enabled: st.enabled,
      roles: [
        { name: 'planner', description: '拆解任务、规划步骤' },
        { name: 'specialist', description: '执行具体工具调用' },
        { name: 'evaluator', description: '评审产物、给出结论' },
      ],
    })
  }
  if (p === '/api/pse' && method === 'POST') {
    const body = await readBody(req)
    const st = pseState()
    st.enabled = body.enabled !== false
    savePse(st)
    return send(res, 200, { enabled: st.enabled })
  }
  // ---- pse provider (free/paid) ----
  if (p === '/api/pse-provider' && method === 'GET') {
    return send(res, 200, pseProviderState())
  }
  if (p === '/api/pse-provider' && method === 'POST') {
    const body = await readBody(req)
    const provider = body.provider === 'deepseek' ? 'deepseek' : 'free'
    const st = { provider }
    savePseProvider(st)
    return send(res, 200, st)
  }

  // ---- gateway: chat / tools / tool/run -> agent-httpd ----
  if (p === '/api/chat' && method === 'POST') {
    const body = await readBody(req)
    // resolve-studio frontend sends { messages:[{role,content}], model, ... };
    // agent-httpd expects { message, history }. Translate the request shape.
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const history = messages
      .filter((m) => m !== lastUser)
      .map((m) => ({ role: m.role, content: m.content }))
    const agentBody = {
      message: lastUser ? lastUser.content : '',
      history,
      model: typeof body.model === 'string' ? body.model : '',
    }
    // Mirror resolve-studio's task resolution (agent.ts:394-395): the selected
    // task's soul is the task-level system prompt, and the run-level
    // systemPrompt the frontend computed (prompt template + memory) is appended
    // after it. agent-httpd appends both onto its default agent prompt, so the
    // model sees the business context this run is supposed to operate in.
    const task = getTask(body.taskId)
    const parts = []
    if (task && task.systemPrompt) parts.push(task.systemPrompt)
    if (typeof body.systemPrompt === 'string' && body.systemPrompt) {
      parts.push(body.systemPrompt)
    }
    if (parts.length) agentBody.system = parts.join('\n\n---\n\n')
    // Optional per-task tool allow-list (frontmatter `tools:`); absent/empty =
    // expose all registered tools (resolve-studio's "no scope filter" fallback).
    if (task && task.includeTools && task.includeTools.length) {
      agentBody.tools = task.includeTools
    }
    // The UI toggle picks the route: /react/api/pse always runs the three-role
    // orchestrator, /react/api/chat is the single ReAct agent (the container
    // runs with PSE_ENABLED=false so this route is genuinely non-PSE).
    const target = pseState().enabled ? '/api/pse' : '/api/chat'
    return agent.proxySSE(req, res, 'POST', target, Buffer.from(JSON.stringify(agentBody)))
  }
  if (p === '/api/tool/run' && method === 'POST') {
    const body = await readBody(req)
    const toolName = body.name
    const toolArgs = body.arguments || body.args || {}
    // Built-in tools (resolve-studio's backend-native set) execute locally in
    // the sidecar; everything else proxies to agent-httpd.
    if (builtin.BUILTIN_NAMES.has(toolName)) {
      // The UI tool panel intentionally exposes every implemented tool to the
      // local operator. Log the ones the conversational Agent cannot reach so
      // high-privilege runs stay auditable (token + Origin/Host gate upstream).
      if (!builtin.AGENT_TOOL_ALLOW.has(toolName)) {
        console.log(`[sidecar] panel-only tool run: ${toolName}`)
      }
      return runBuiltinSSE(res, toolName, toolArgs)
    }
    // resolve-studio shape: { name, arguments } -> agent shape: { name, args }
    const agentBody = JSON.stringify({ name: toolName, args: toolArgs })
    return agent.proxySSE(req, res, 'POST', p, Buffer.from(agentBody))
  }
  if (p === '/api/tools' && method === 'GET') {
    return handleToolsList(res)
  }
  if (p === '/api/tools/call' && method === 'POST') {
    const body = await readBody(req)
    const toolName = body.name
    const toolArgs = body.arguments || body.args || {}
    if (builtin.BUILTIN_NAMES.has(toolName)) {
      // Called by the agent-httpd bridge (SIDECAR_TOOLS_URL), NOT by the UI.
      // Enforce the generated bridge's allowlist server-side: previously the
      // "24 exposed tools" only constrained what the model could SEE, while
      // this HTTP surface still offered all 44 builtins (shell/publish/write).
      if (!builtin.AGENT_TOOL_ALLOW.has(toolName)) {
        return send(res, 403, {
          error: `tool "${toolName}" is not exposed to the agent bridge; run it from the frontend tool panel (call capabilities for the full list)`,
        })
      }
      try {
        const text = await builtin.executeBuiltinTool(toolName, toolArgs)
        return send(res, 200, { name: toolName, result: String(text) })
      } catch (err) {
        return send(res, 200, { name: toolName, error: err.message || 'tool execution failed' })
      }
    }
    return agent.proxyJSON(req, res, 'POST', p, Buffer.from(JSON.stringify(body)))
  }

  // ---- models ----
  if (p === '/api/models' && method === 'GET') {
    // Free/paid pair, both routed through the same llm-router gateway (model
    // name selects the backend). Override the identifiers via LLM_FREE_MODEL /
    // LLM_PAID_MODEL when a different gateway vocabulary is in use.
    const free = process.env.LLM_FREE_MODEL || 'agnes-2.0-flash'
    const paid = process.env.LLM_PAID_MODEL || 'deepseek-v4-flash'
    const current = process.env.LLM_MODEL || paid
    return send(res, 200, {
      models: [
        { id: free, ownedBy: 'lume', tier: 'free', label: '免费' },
        { id: paid, ownedBy: 'lume', tier: 'paid', label: '付费' },
      ],
      defaultModel: current,
    })
  }

  // ---- skills ----
  if (p === '/api/skills' && method === 'GET') {
    return send(res, 200, { skills: scanSkills() })
  }

  // ---- tasks ----
  if (p === '/api/tasks' && method === 'GET') {
    return send(res, 200, { tasks: buildTasks(), scopes: SCOPES })
  }
  if (p === '/api/tasks/match' && method === 'POST') {
    const body = await readBody(req)
    const msg = (body.message || '').toLowerCase()
    // Match against each task's id + triggers keywords (frontmatter `triggers:`);
    // falls back to an id substring match for the meta tasks without triggers.
    let best = null
    let bestScore = 0
    for (const t of buildTasks()) {
      if (t.id === 'general') continue
      let score = 0
      if (msg.includes(t.id.replace(/-/g, ' '))) score += 1
      for (const kw of (t.triggers || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (msg.includes(kw.toLowerCase())) score += 2
      }
      if (score > bestScore) {
        bestScore = score
        best = t
      }
    }
    return send(res, 200, { id: best ? best.id : null, name: best ? best.name : null })
  }

  // ---- usage ----
  if (p === '/api/usage' && method === 'GET') {
    const u = store.read('usage', {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      requests: 0,
    })
    return send(res, 200, { usage: u })
  }

  // ---- sessions ----
  if (p === '/api/sessions' && method === 'GET') {
    const all = sessions()
    const list = Object.values(all).map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: (s.messages || []).length,
    }))
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return send(res, 200, { sessions: list })
  }
  if (p === '/api/sessions' && method === 'POST') {
    const body = await readBody(req)
    const all = sessions()
    const id = body.id || uid('s_')
    const now = new Date().toISOString()
    all[id] = {
      id,
      title: body.title || '未命名对话',
      taskMode: body.taskMode || 'auto',
      messages: body.messages || [],
      createdAt: all[id]?.createdAt || now,
      updatedAt: now,
    }
    saveSessions(all)
    return send(res, 200, { session: all[id] })
  }
  if (p === '/api/sessions' && method === 'DELETE') {
    store.write('sessions', {})
    return send(res, 200, { ok: true })
  }
  const sessMatch = p.match(/^\/api\/sessions\/([^/]+)$/)
  if (sessMatch) {
    const id = decodeURIComponent(sessMatch[1])
    const all = sessions()
    if (method === 'GET') {
      return all[id] ? send(res, 200, { session: all[id] }) : send(res, 404, { error: 'not found' })
    }
    if (method === 'DELETE') {
      delete all[id]
      saveSessions(all)
      return send(res, 200, { ok: true })
    }
  }

  // ---- memory ----
  if (p === '/api/memory' && method === 'GET') {
    return send(res, 200, { items: memory().items, count: memory().items.length })
  }
  if (p === '/api/memory' && method === 'POST') {
    const body = await readBody(req)
    const m = memory()
    m.items.push({ id: uid('m_'), content: body.content || '', at: new Date().toISOString() })
    saveMemory(m)
    return send(res, 200, { items: m.items, count: m.items.length })
  }
  if (p === '/api/memory' && method === 'DELETE') {
    store.write('memory', { items: [] })
    return send(res, 200, { ok: true })
  }
  const memMatch = p.match(/^\/api\/memory\/([^/]+)$/)
  if (memMatch && method === 'DELETE') {
    const m = memory()
    m.items = m.items.filter((x) => x.id !== memMatch[1])
    saveMemory(m)
    return send(res, 200, { ok: true })
  }

  // ---- fs browser ----
  if (p === '/api/fs' && method === 'GET') {
    const requested = q.get('path') || ''
    let dir
    let parent = null
    let atRoot = false
    if (!requested) {
      return send(res, 200, {
        dir: '',
        parent: null,
        atRoot: true,
        entries: FS_ROOTS.map((r) => ({
          name: path.basename(r),
          path: r,
          isDir: true,
          size: 0,
        })),
      })
    }
    dir = path.resolve(requested)
    if (!isInsideRoot(dir)) return send(res, 403, { error: 'path outside read roots' })
    try {
      const parentDir = path.dirname(dir)
      parent = FS_ROOTS.includes(parentDir) ? null : parentDir
      atRoot = FS_ROOTS.includes(dir)
      const entries = fs
        .readdirSync(dir)
        .map((name) => {
          const abs = path.join(dir, name)
          let isDir = false
          let size = 0
          try {
            const st = fs.statSync(abs)
            isDir = st.isDirectory()
            size = st.size
          } catch {
            /* ignore */
          }
          return { name, path: abs, isDir, size }
        })
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      return send(res, 200, { dir, parent, atRoot, entries })
    } catch (err) {
      return send(res, 400, { error: err.message })
    }
  }

  // ---- mcp servers (registry; tool execution still via agent-httpd) ----
  if (p === '/api/mcp' && method === 'GET') {
    const m = mcpState()
    // surface agent-httpd's own tool server groups as read-only entries
    return send(res, 200, { servers: m.servers })
  }
  if (p === '/api/mcp' && method === 'POST') {
    const body = await readBody(req)
    const m = mcpState()
    const srv = {
      id: body.id,
      transport: body.transport || 'stdio',
      command: body.command,
      args: body.args,
      url: body.url,
      approval: body.approval !== false,
      status: 'connected',
      toolCount: 0,
      tools: [],
    }
    const existing = m.servers.findIndex((s) => s.id === srv.id)
    if (existing >= 0) m.servers[existing] = srv
    else m.servers.push(srv)
    saveMcp(m)
    return send(res, 200, { server: srv })
  }
  const mcpMatch = p.match(/^\/api\/mcp\/([^/]+)$/)
  if (mcpMatch && method === 'DELETE') {
    const m = mcpState()
    m.servers = m.servers.filter((s) => s.id !== decodeURIComponent(mcpMatch[1]))
    saveMcp(m)
    return send(res, 200, { ok: true })
  }

  // ---- approval (no gated tools in the lume runtime; be explicit) ----
  if (p === '/api/approval' && method === 'POST') {
    const body = await readBody(req)
    const decision = String(body.decision || '')
    const callId = String(body.callId || '')
    if (decision !== 'approve' && decision !== 'reject') {
      return send(res, 400, { error: 'decision must be "approve" or "reject"' })
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) {
      return send(res, 400, { error: 'invalid callId' })
    }
    // agent-httpd currently emits no approval-request frames, so there is no
    // pending gate to release. Say so instead of silently pretending that a
    // human decision changed anything; keep an audit trail for when it does.
    console.log(`[sidecar] approval recorded (no active gate): ${callId} ${decision}`)
    return send(res, 200, {
      ok: true, applied: false, callId, decision,
      note: 'current lume runtime has no gated tools; decision recorded, nothing was unblocked',
    })
  }

  // ---- jobs ----
  if (p === '/api/jobs' && method === 'GET') {
    const list = store.job
      .list()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return send(res, 200, { jobs: list })
  }
  if (p === '/api/jobs' && method === 'POST') {
    const body = await readBody(req)
    const id = uid('j_')
    const now = new Date().toISOString()
    const rec = {
      id,
      name: body.name || body.prompt?.slice(0, 40) || 'job',
      prompt: body.prompt || '',
      taskId: body.taskId,
      model: body.model,
      includeTools: body.includeTools || [],
      excludeTools: body.excludeTools || [],
      workspace: body.workspace || WORKSPACE_DIR || '/app/.data/jobs/' + id,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      events: [],
      eventCount: 0,
    }
    store.job.create(rec)
    startJobRun(id, body)
    return send(res, 200, { job: rec })
  }
  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(\/stream|\/cancel|\/resume|\/files)?$/)
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1])
    const j = store.job.get(id)
    if (!j) return send(res, 404, { error: 'job not found' })
    const sub = jobMatch[2]
    if (!sub && method === 'GET') {
      return send(res, 200, { job: { ...j, events: store.job.events(id, 0) } })
    }
    if (!sub && method === 'DELETE') {
      store.job.remove(id)
      // Drop the in-flight run too, otherwise a deleted job keeps streaming
      // (and billing) in the background with nowhere to record its output.
      const upstream = activeRuns.get(id)
      if (upstream) {
        activeRuns.delete(id)
        try {
          upstream.destroy()
        } catch {
          /* already closed */
        }
      }
      return send(res, 200, { ok: true })
    }
    if (sub === '/cancel' && method === 'POST') {
      if (j.status === 'running') {
        store.job.update(id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        })
        // Abort the upstream agent-httpd request; otherwise the stream keeps
        // running (and billing) until the model finishes, while its events are
        // silently dropped because the job is no longer 'running'.
        const upstream = activeRuns.get(id)
        if (upstream) {
          activeRuns.delete(id)
          try {
            upstream.destroy()
          } catch {
            /* already closed */
          }
        }
      }
      return send(res, 200, { ok: true })
    }
    if (sub === '/resume' && method === 'POST') {
      if (j.status === 'failed' || j.status === 'cancelled') {
        const body = await readBody(req)
        const now = new Date().toISOString()
        store.job.update(id, { status: 'running', startedAt: now, updatedAt: now })
        // Continue from the stored transcript instead of restarting blank.
        startJobRun(id, {
          prompt: j.prompt,
          taskId: j.taskId,
          history: j.answer ? [{ role: 'assistant', content: j.answer }] : [],
          instruction: body.instruction,
        })
      }
      return send(res, 200, { ok: true })
    }
    if (sub === '/files' && method === 'GET') {
      const files = []
      const ws = j.workspace
      try {
        const walk = (dir, rel) => {
          for (const name of fs.readdirSync(dir)) {
            const abs = path.join(dir, name)
            const r = rel ? rel + '/' + name : name
            const st = fs.statSync(abs)
            if (st.isDirectory()) walk(abs, r)
            else files.push({ path: r, size: st.size, mtime: st.mtime.toISOString() })
          }
        }
        if (fs.existsSync(ws)) walk(ws, '')
      } catch {
        /* ignore */
      }
      return send(res, 200, { files })
    }
    if (sub === '/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      let lastSeq = 0
      res.write(
        `event: snapshot\ndata: ${JSON.stringify({
          status: j.status,
          events: store.job.events(id, 0),
        })}\n\n`,
      )
      const timer = setInterval(() => {
        const cur = store.job.get(id)
        if (!cur) {
          clearInterval(timer)
          res.end()
          return
        }
        const fresh = store.job.events(id, lastSeq)
        for (const e of fresh) {
          lastSeq = e.seq
          res.write(`event: job\ndata: ${JSON.stringify(e)}\n\n`)
        }
        if (cur.status !== 'running') {
          clearInterval(timer)
          res.end()
        }
      }, 400)
      req.on('close', () => clearInterval(timer))
      return
    }
  }

  // ---- workspace scan (simplified: list top-level projects under WORKSPACE_DIR) ----
  if (p === '/api/workspace' && method === 'GET') {
    const projects = scanWorkspace()
    return send(res, 200, { generatedAt: new Date().toISOString(), projects })
  }
  if (p === '/api/workspace/status' && method === 'GET') {
    return send(res, 200, workspaceStatus())
  }
  if (p === '/api/workspace/rescan' && method === 'POST') {
    const projects = scanWorkspace()
    store.write('workspace', { generatedAt: new Date().toISOString(), projects })
    return send(res, 200, { started: true })
  }
  if (p === '/api/workspace/stop' && method === 'POST') {
    return send(res, 200, { stopped: true })
  }

  // ---- desktop-login (disabled by default; no VNC/Chrome in lume image) ----
  if (p === '/api/desktop-login/sites' && method === 'GET') {
    return send(res, 200, {
      ok: true,
      sites: [],
      sfLoginEnabled: process.env.SF_LOGIN_ENABLED === '1',
      sfLoginLabel: process.env.SF_LOGIN_BUTTON_LABEL || '桌面登录',
      sfLoginUrl: process.env.SF_LOGIN_URL || '',
    })
  }
  if (p === '/api/desktop-login' && method === 'GET') {
    return send(res, 200, {
      ok: false,
      sites: [],
      message: '桌面登录在此镜像中未启用（需 VNC + headed Chrome）。',
      sfLoginEnabled: process.env.SF_LOGIN_ENABLED === '1',
    })
  }

  // ---- file preview (text) + raw ----
  if (p === '/api/file' && method === 'GET') {
    const abs = guardedFilePath(res, q.get('path'))
    if (!abs) return
    try {
      const st = fs.statSync(abs)
      const content = fs.readFileSync(abs, 'utf8')
      return send(res, 200, { content, size: st.size })
    } catch (err) {
      return send(res, 400, { error: err.message })
    }
  }
  if (p === '/api/raw' && method === 'GET') {
    const abs = guardedFilePath(res, q.get('path'))
    if (!abs) return
    try {
      const st = fs.statSync(abs)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `inline; filename="${path.basename(abs)}"`,
      })
      fs.createReadStream(abs).pipe(res)
    } catch (err) {
      send(res, 400, { error: err.message })
    }
    return
  }

  // ---- tool layer status ----
  // managed 由 probeManaged() 实测得出（launcher / compose / detached）。不要再写死
  // 'compose'：现在实际监管它的是宿主 launcher，写死会让前端显示错误的启停方式。
  if (p === '/api/tool-layer' && method === 'GET') {
    const managed = await probeManaged()
    return send(res, 200, { running: true, managed, pid: process.pid })
  }

  // ---- health ----
  if (p === '/health' && method === 'GET') {
    return send(res, 200, { ok: true, service: 'resolve-lume-sidecar' })
  }

  send(res, 404, { error: `no route for ${method} ${p}` })
}

// ---------- workspace scanning ----------
let _wsStatus = { status: 'idle' }
function workspaceStatus() {
  return _wsStatus
}
function scanWorkspace() {
  if (!WORKSPACE_DIR || !fs.existsSync(WORKSPACE_DIR)) return []
  try {
    return fs
      .readdirSync(WORKSPACE_DIR)
      .map((name) => {
        const abs = path.join(WORKSPACE_DIR, name)
        let fileCount = 0
        let languages = []
        try {
          const st = fs.statSync(abs)
          if (st.isDirectory()) {
            const entries = fs.readdirSync(abs)
            fileCount = entries.length
            languages = [...new Set(entries.map((e) => path.extname(e).replace('.', '')).filter(Boolean))]
          }
        } catch {
          /* ignore */
        }
        return {
          key: name,
          repo: name,
          github: '',
          article: {},
          sourceDir: abs,
          desc: '',
          highlights: '',
          status: 'idle',
          lspStatus: 'unknown',
          cached: false,
          mixed: false,
          languages,
          symbolCount: 0,
          diagCount: 0,
          fileCount,
          note: '',
          units: [],
        }
      })
      .filter((p) => p.fileCount > 0)
  } catch {
    return []
  }
}

// kick off an initial workspace scan so /api/workspace has data
if (WORKSPACE_DIR) {
  try {
    store.write('workspace', { generatedAt: new Date().toISOString(), projects: scanWorkspace() })
  } catch {
    /* ignore */
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* client already gone */
      }
      return
    }
    send(res, err.statusCode || 500, { error: err.message })
  })
})
// Four tool lists must agree (schema / DEFAULT_ALLOW / generated bridge /
// real implementations). Silently drifting one of them is exactly what made
// the agent claim "article-write is not mounted", so refuse to start instead.
// ALLOW_TOOL_DRIFT=1 is an explicit escape hatch for local generator work.
try {
  const drift = require('./consistency').checkToolChain({ implemented: builtin.BUILTIN_NAMES })
  if (!drift.ok) {
    console.error('[sidecar] FATAL: 工具链漂移，拒绝启动:\n  ' + drift.problems.join('\n  '))
    console.error('[sidecar] 修法: make tools-lume；临时绕过: ALLOW_TOOL_DRIFT=1（不推荐）')
    if (process.env.ALLOW_TOOL_DRIFT !== '1') process.exit(1)
  } else {
    const s = drift.stats
    console.log(`[sidecar] tool chain consistent: schema=${s.schema} allow=${s.allow} bridge=${s.bridge} implemented=${s.implemented}`)
  }
} catch (err) {
  console.error(`[sidecar] FATAL: 工具链一致性校验失败: ${err.message}`)
  if (process.env.ALLOW_TOOL_DRIFT !== '1') process.exit(1)
}
seedMcpRegistry()
server.listen(PORT, HOST, () => {
  console.log(`[sidecar] listening on ${HOST}:${PORT}  agent=${AGENT_URL}  souls=${SOULS_DIR}`)
})

// Process-level guards. A rejected promise used to disappear silently, and a
// stray exception could leave SSE clients / detached child processes behind.
// A clean exit(1) lets the host launcher apply its respawn budget.
process.on('unhandledRejection', (err) => {
  console.error('[sidecar] unhandledRejection:', err && err.stack ? err.stack : err)
})
process.on('uncaughtException', (err) => {
  console.error('[sidecar] uncaughtException:', err && err.stack ? err.stack : err)
  process.exit(1)
})
function shutdown() {
  console.log('[sidecar] received SIGTERM/SIGINT, closing')
  server.close(() => process.exit(0))
  // Long SSE streams can keep server.close() pending; never hang the launcher.
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// After startup, backfill each seeded MCP server's toolCount/tools from the live
// agent-httpd /api/tools response so the UI shows real counts instead of "0 tools".
// agent-httpd may still be warming up, so retry until it answers.
let mcpRefreshDone = false
let mcpRefreshAttempts = 0
function refreshMcpToolCounts() {
  if (mcpRefreshDone) return
  // Hit our own /api/tools proxy (which rewrites the path for agent-httpd) rather
  // than calling agent-httpd directly — the raw /api/tools path 404s on backend.
  // This is a loopback call to OUR OWN authenticated API, so it must carry the
  // same token as every other /api request. Forgetting it returned 401 with an
  // empty `tools` array and made the MCP toolCount backfill retry 30 times.
  const req = http.request(
    { method: 'GET', hostname: '127.0.0.1', port: PORT, path: '/api/tools', timeout: 5000,
      headers: { 'X-Sidecar-Token': SIDECAR_TOKEN } },
    (resp) => {
      let body = ''
      resp.on('data', (c) => (body += c))
      resp.on('end', () => {
        try {
          const data = JSON.parse(body)
          const tools = data.tools || []
          const byServer = {}
          for (const t of tools) {
            const srv = t.server || 'unknown'
            ;(byServer[srv] = byServer[srv] || []).push(t.name)
          }
          // Re-read the store fresh and only patch stdio servers, so we never
          // clobber the concurrent HTTP-bridge refresh that may have saved first.
          const m = mcpState()
          let changed = false
          for (const s of m.servers) {
            if (s.transport !== 'stdio') continue
            if (byServer[s.id] && byServer[s.id].length) {
              s.toolCount = byServer[s.id].length
              s.tools = byServer[s.id].map((n) => n.replace(/^[^_]*__/, ''))
              changed = true
            }
          }
          if (changed) {
            saveMcp(m)
            mcpRefreshDone = true
            console.log(`[sidecar] backfilled tool counts for ${m.servers.length} MCP server(s)`)
          }
        } catch {
          /* ignore malformed response */
        }
      })
    }
  )
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
  req.end()
}
function scheduleMcpRefresh() {
  if (mcpRefreshDone) return
  refreshMcpToolCounts()
  if (!mcpRefreshDone && mcpRefreshAttempts++ < 30) setTimeout(scheduleMcpRefresh, 3000)
}
scheduleMcpRefresh()
// HTTP MCP bridges (mcp-fs/mcp-memory/mcp-think) are probed independently of the
// stdio backfill above, since agent-httpd can't host them and they live on the
// tsm-hub network.
refreshHttpMcpServers()
