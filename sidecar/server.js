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
const store = require('./store')
const agent = require('./agent')

const PORT = Number(process.env.PORT || 3000)
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
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}
function uid(prefix) {
  return (prefix || '') + Math.random().toString(36).slice(2, 10)
}
function isInsideRoot(abs, roots) {
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep))
}

// ---------- per-collection accessors ----------
const jobs = () => store.read('jobs', {})
const saveJobs = (j) => store.write('jobs', j)
const sessions = () => store.read('sessions', {})
const saveSessions = (s) => store.write('sessions', s)
const memory = () => store.read('memory', { items: [] })
const saveMemory = (m) => store.write('memory', m)
const pseState = () => store.read('pse', { enabled: true })
const savePse = (p) => store.write('pse', p)
const mcpState = () => store.read('mcp', { servers: [] })
const saveMcp = (m) => store.write('mcp', m)

// ---------- tasks catalog (static; lume has no task registry of its own) ----------
const TASKS = [
  {
    id: 'general',
    name: '通用对话',
    description: '默认模式：单 agent 直接对话（不启用 PSE 三角色）。',
    includeTools: [],
    systemPrompt: '',
  },
  {
    id: 'pse-review',
    name: 'PSE 三角色评审',
    description: 'Planner / Specialist / Evaluator 三角色协作，适合需要多视角评审的任务。',
    includeTools: [],
    systemPrompt: '',
  },
]
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
  const j = jobs()[id]
  if (!j) return
  const usePse = input.taskId === 'pse-review' || j.taskId === 'pse-review'
  const backendPath = usePse ? '/react/api/pse' : '/react/api/chat'
  const body = JSON.stringify({ message: input.prompt, history: [] })
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
  req.write(body)
  req.end()
}
function appendJobEvent(id, ev) {
  const all = jobs()
  const j = all[id]
  if (!j) return
  j.events.push(ev)
  j.eventCount = j.events.length
  j.updatedAt = new Date().toISOString()
  saveJobs(all)
}
function finishJob(id, status, answer, error) {
  const all = jobs()
  const j = all[id]
  if (!j || j.status !== 'running') return
  j.status = status
  j.finishedAt = new Date().toISOString()
  if (answer != null) j.answer = answer
  if (error) j.error = error
  saveJobs(all)
}

// ---------- router ----------
async function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = parsed.pathname
  const method = req.method
  const q = parsed.searchParams

  // ---- gateway: chat / pse / tools / tool/run -> agent-httpd ----
  if ((p === '/api/chat' || p === '/api/pse') && method === 'POST') {
    const body = await readBody(req)
    // resolve-studio frontend sends { messages:[{role,content}], model, ... };
    // agent-httpd expects { message, history }. Translate the request shape.
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const history = messages
      .filter((m) => m !== lastUser)
      .map((m) => ({ role: m.role, content: m.content }))
    const agentBody = { message: lastUser ? lastUser.content : '', history }
    return agent.proxySSE(req, res, 'POST', p, Buffer.from(JSON.stringify(agentBody)))
  }
  if (p === '/api/tool/run' && method === 'POST') {
    const body = await readBody(req)
    // resolve-studio shape: { name, arguments } -> agent shape: { name, args }
    const agentBody = JSON.stringify({ name: body.name, args: body.arguments || {} })
    return agent.proxySSE(req, res, 'POST', p, Buffer.from(agentBody))
  }
  if (p === '/api/tools' && method === 'GET') {
    return agent.proxyJSON(req, res, 'GET', p, null)
  }
  if (p === '/api/tools/call' && method === 'POST') {
    const body = await readBody(req)
    return agent.proxyJSON(req, res, 'POST', p, Buffer.from(JSON.stringify(body)))
  }

  // ---- models ----
  if (p === '/api/models' && method === 'GET') {
    const model = process.env.LLM_MODEL || 'gpt-4o-mini'
    return send(res, 200, { models: [{ id: model, ownedBy: 'lume' }], defaultModel: model })
  }

  // ---- skills ----
  if (p === '/api/skills' && method === 'GET') {
    return send(res, 200, { skills: scanSkills() })
  }

  // ---- tasks ----
  if (p === '/api/tasks' && method === 'GET') {
    return send(res, 200, { tasks: TASKS, scopes: SCOPES })
  }
  if (p === '/api/tasks/match' && method === 'POST') {
    const body = await readBody(req)
    const msg = (body.message || '').toLowerCase()
    // crude keyword match against task descriptions
    const hit = TASKS.find((t) => t.id !== 'general' && msg.includes(t.id.replace('-', ' ')))
    return send(res, 200, { id: hit ? hit.id : null, name: hit ? hit.name : null })
  }

  // ---- pse status / toggle ----
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
    if (!isInsideRoot(dir, FS_ROOTS)) return send(res, 403, { error: 'path outside read roots' })
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

  // ---- approval (passthrough; lume demo does not gate tools) ----
  if (p === '/api/approval' && method === 'POST') {
    const body = await readBody(req)
    // No gated tools in the current lume runtime; accept the decision as a no-op.
    return send(res, 200, { ok: true, callId: body.callId, decision: body.decision })
  }

  // ---- jobs ----
  if (p === '/api/jobs' && method === 'GET') {
    const all = jobs()
    const list = Object.values(all)
      .map(({ events, ...meta }) => meta)
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
    const all = jobs()
    all[id] = rec
    saveJobs(all)
    startJobRun(id, body)
    return send(res, 200, { job: rec })
  }
  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(\/stream|\/cancel|\/resume|\/files)?$/)
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1])
    const all = jobs()
    const j = all[id]
    if (!j) return send(res, 404, { error: 'job not found' })
    const sub = jobMatch[2]
    if (!sub && method === 'GET') return send(res, 200, { job: j })
    if (!sub && method === 'DELETE') {
      delete all[id]
      saveJobs(all)
      return send(res, 200, { ok: true })
    }
    if (sub === '/cancel' && method === 'POST') {
      if (j.status === 'running') {
        j.status = 'cancelled'
        j.finishedAt = new Date().toISOString()
        saveJobs(all)
      }
      return send(res, 200, { ok: true })
    }
    if (sub === '/resume' && method === 'POST') {
      if (j.status === 'failed' || j.status === 'cancelled') {
        j.status = 'running'
        j.startedAt = new Date().toISOString()
        j.updatedAt = j.startedAt
        saveJobs(all)
        startJobRun(id, { prompt: j.prompt, taskId: j.taskId })
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
      res.write(`event: snapshot\ndata: ${JSON.stringify({ status: j.status, events: j.events })}\n\n`)
      const timer = setInterval(() => {
        const cur = jobs()[id]
        if (!cur) {
          clearInterval(timer)
          res.end()
          return
        }
        const fresh = cur.events.filter((e) => e.seq > lastSeq)
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
    const fp = q.get('path')
    if (!fp) return send(res, 400, { error: 'missing path' })
    const abs = path.resolve(fp)
    if (!isInsideRoot(abs, FS_ROOTS)) return send(res, 403, { error: 'path outside read roots' })
    try {
      const st = fs.statSync(abs)
      const content = fs.readFileSync(abs, 'utf8')
      return send(res, 200, { content, size: st.size })
    } catch (err) {
      return send(res, 400, { error: err.message })
    }
  }
  if (p === '/api/raw' && method === 'GET') {
    const fp = q.get('path')
    if (!fp) return send(res, 400, { error: 'missing path' })
    const abs = path.resolve(fp)
    if (!isInsideRoot(abs, FS_ROOTS)) return send(res, 403, { error: 'path outside read roots' })
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
    send(res, 500, { error: err.message })
  })
})
server.listen(PORT, () => {
  console.log(`[sidecar] listening on :${PORT}  agent=${AGENT_URL}  souls=${SOULS_DIR}`)
})
