'use strict'
// Gateway to the lume agent-httpd C binary.
//
// agent-httpd speaks its own SSE dialect: each frame is `data: {"t":"delta","d":"..."}`
// (no `event:` line; the type lives in the JSON `t` field). The resolve-studio
// frontend expects the OpenAI-style dialect: `event: <type>\ndata: <json>\n\n`.
// This module rewrites agent-httpd frames into that dialect on the fly, so the
// ported frontend can consume lume's runtime unchanged.
const http = require('http')
const { URL } = require('url')
const progress = require('./progress')

const AGENT_URL = process.env.AGENT_HTTPD_URL || 'http://backend:8080'

function agentPath(incomingPath) {
  // /api/chat -> /react/api/chat ; /api/tools -> /react/api/tools ; etc.
  if (incomingPath === '/api/tools/call') return '/react/api/tools/call'
  if (incomingPath.startsWith('/api/tools')) return '/react/api/tools'
  if (incomingPath === '/api/tool/run') return '/react/api/tools/call'
  if (incomingPath === '/api/pse') return '/react/api/pse'
  if (incomingPath === '/api/chat') return '/react/api/chat'
  return incomingPath
}

function backendRequest(method, path, bodyBuffer, headers) {
  const u = new URL(AGENT_URL)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 80,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(headers || {}),
        },
      },
      (resp) => resolve(resp),
    )
    req.on('error', reject)
    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })
}

// Translate one agent-httpd frame ({t,d}) into a resolve-studio SSE event string.
//
// agent-httpd streams EVERY round's model text as `delta` and never marks which
// round produced the final answer. A free-tier model that says "output looks
// truncated, let me retry" before a tool call therefore had that sentence
// appended to the answer bubble, and when the run then died on a 429 the
// narration was all the user ever saw. Also, PSE emits Planner / Specialist /
// Evaluator prose into the very same stream, so the frontend used to glue a
// plan + an execution log + a FAIL verdict into one "answer".
//
// `buf` tracks the text pending since the last phase/tool boundary. Only the
// text after the LAST tool call is a legitimate answer; anything before it is
// process narration and must not become `done.answer`.
// When the run ends with an empty answer the old message ("工具已执行，但模型
// 未返回总结；请重试") hid everything that actually happened and invited a
// blind retry. 2026-11-06: 8 rounds, 1 article-write + 6 unrelated hot-news
// calls, zero output — the user had no way to tell which tool failed.
function emptyRunSummary(buf) {
  const steps = buf.tools || []
  const trace = steps.length
    ? steps
        .slice(-12)
        .map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name))
        .join(' → ')
    : '无（模型未发起工具调用）'
  const rounds = buf.roundMax ? `${buf.roundMax} 轮工具预算已用尽` : '本轮提前结束'
  const lines = [
    `⚠️ 本轮没有产生回答：${rounds}，模型在最后一次工具调用后没有输出任何正文。`,
    `调用轨迹：${trace}`,
    buf.lastError ? `最后错误：${buf.lastError}` : '最后错误：无（工具失败通常以普通文本返回，不会触发 error 帧；请展开 Thinking 查看工具结果）',
    '请勿直接点重试：先看 Thinking 里最后一次工具的返回，确认它是失败还是超时。',
    '若目标是生成文章，建议新建会话后直接说项目名（如「写 resolve-lume 的文章」），避免沿用这份已跑偏的上下文。',
  ]
  return lines.join('\n')
}

function translateFrame(json, buf) {
  const t = json.t
  const d = json.d
  if (t === 'delta') {
    // Planner / Evaluator prose is internal deliberation, not a deliverable.
    // Show it in the thinking channel and keep it out of the answer buffer.
    if (buf.suppress) {
      return `event: reasoning\ndata: ${JSON.stringify({ text: d || '' })}\n\n`
    }
    buf.pending += d || ''
    buf.text += d || ''
    return `event: delta\ndata: ${JSON.stringify({ text: d || '' })}\n\n`
  }
  if (t === 'note') {
    const note = String(d || '')
    // Collect the tool trajectory for emptyRunSummary(). Keep consecutive
    // identical calls collapsed so 4 blind retries read as `hot-news ×4`.
    if (/^tool /.test(note)) {
      const m = /^tool\s+([A-Za-z0-9_.:-]+)/.exec(note)
      const name = (m ? m[1] : '?').replace(/^sidecar__/, '')
      const steps = buf.tools || (buf.tools = [])
      const last = steps[steps.length - 1]
      if (last && last.name === name) last.count += 1
      else steps.push({ name, count: 1 })
    }
    const rm = /^round \d+\/(\d+)/.exec(note)
    if (rm) buf.roundMax = Number(rm[1])
    const plannerStart = /^PSE cycle .* - Planner/.test(note)
    const evaluatorStart = /^PSE cycle .* - Evaluator/.test(note)
    const exhausted = /^PSE exhausted/.test(note)
    if (evaluatorStart) {
      // The Specialist's tool-backed prose IS the deliverable. Archive it
      // before the Evaluator phase begins — clearing it here would throw away
      // a perfectly good answer and leave "model returned no summary".
      const text = buf.pending.trim()
      if (text) buf.answer = text
      buf.pending = ''
      buf.suppress = true
    } else if (plannerStart) {
      buf.pending = ''
      buf.suppress = true
    } else if (exhausted) {
      // Backend explicitly says the last Specialist output is the result:
      // keep the archived answer untouched.
    } else if (
      /^tool /.test(note) ||
      /^round \d+\/\d+/.test(note) ||
      /^\[(planner|specialist|evaluator)\]$/.test(note) ||
      /^PSE /.test(note)
    ) {
      // Text before a tool call / round marker is process narration, not an
      // answer ("output looks truncated, let me retry" etc.).
      buf.pending = ''
    }
    // Planner output ends at [planner]; from here the Specialist's text is
    // the visible answer candidate again.
    if (/^\[planner\]$/.test(note)) buf.suppress = false
    return `event: reasoning\ndata: ${JSON.stringify({ text: note })}\n\n`
  }
  if (t === 'error') {
    buf.error = String(d || 'unknown error')
    buf.lastError = buf.error
    buf.pending = '' // the failed attempt's narration is not an answer
    return `event: error\ndata: ${JSON.stringify({ message: buf.error })}\n\n`
  }
  if (t === 'done') {
    // Single-agent: the text after the last tool call. PSE: the archived
    // Specialist output (Evaluator prose never enters the answer buffer).
    // The frontend treats a non-empty `done.answer` as authoritative and
    // overwrites the bubble, so this is where retry narration disappears.
    let answer = buf.pending.trim() || buf.answer.trim()
    if (!answer && buf.error) {
      answer = `⚠️ 本次运行未完成：${buf.error}。请稍后重试，或在 .env 里切换 LLM_MODEL。`
    }
    if (!answer) {
      answer = emptyRunSummary(buf)
    }
    buf.text = answer
    return `event: done\ndata: ${JSON.stringify({ answer })}\n\n`
  }
  // Unknown frame type: forward verbatim as a note so nothing is lost.
  return `event: reasoning\ndata: ${JSON.stringify({ text: JSON.stringify(json) })}\n\n`
}

// Proxy a chat/pse request, translating the SSE stream.
async function proxySSE(req, res, method, incomingPath, bodyBuffer) {
  const backendPath = agentPath(incomingPath)
  let resp
  try {
    resp = await backendRequest(method, backendPath, bodyBuffer)
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `agent-httpd unreachable: ${err.message}` }))
    return
  }
  // Non-200 (e.g. 502 for an unknown tool / upstream LLM failure) carries a JSON
  // error body, not SSE. Forward it as JSON so the frontend's !res.ok path shows
  // the real message instead of an empty, "successful" stream.
  if (resp.statusCode !== 200) {
    const chunks = []
    resp.on('data', (c) => chunks.push(c))
    resp.on('end', () => {
      const body = Buffer.concat(chunks)
      res.writeHead(resp.statusCode, { 'Content-Type': 'application/json' })
      res.end(body.length ? body : JSON.stringify({ error: `upstream ${resp.statusCode}` }))
    })
    resp.on('error', () => res.end())
    return
  }
  res.writeHead(resp.statusCode, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // Long-running tools (article-write etc.) execute in a SEPARATE blocking
  // /api/tools/call request while C emits nothing. Register this live chat
  // response so progress.js can inject `reasoning` frames into it. Only
  // conversational runs register — /api/tool/run owns its own SSE response.
  const isChatStream = incomingPath === '/api/chat' || incomingPath === '/api/pse'
  const streamId = isChatStream ? progress.registerChatStream(res) : null
  const releaseStream = () => progress.unregisterChatStream(streamId)
  if (isChatStream) res.on('close', releaseStream)
  // text: full delta stream (kept for callers that inspect it);
  // pending: only the text since the last tool/phase boundary (answer candidate).
  const buf = {
    text: '', pending: '', answer: '', error: '', suppress: false,
    tools: [], roundMax: 0, lastError: '',
  }
  let pending = ''
  resp.setEncoding('utf8')
  resp.on('data', (chunk) => {
    pending += chunk
    let idx
    while ((idx = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, idx)
      pending = pending.slice(idx + 2)
      // agent-httpd frames look like `data: {...}` (possibly multiple `data:` lines)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let json
      try {
        json = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      res.write(translateFrame(json, buf))
    }
  })
  resp.on('end', () => {
    if (pending.trim()) {
      const dataLine = pending.split('\n').find((l) => l.startsWith('data:'))
      if (dataLine) {
        try {
          const json = JSON.parse(dataLine.slice(5).trim())
          res.write(translateFrame(json, buf))
        } catch {
          /* ignore */
        }
      }
    }
    releaseStream()
    res.end()
  })
  resp.on('error', () => {
    releaseStream()
    res.end()
  })
}

// Proxy a plain JSON request (tools list / tools/call) and echo the JSON.
async function proxyJSON(req, res, method, incomingPath, bodyBuffer) {
  const backendPath = agentPath(incomingPath)
  let resp
  try {
    resp = await backendRequest(method, backendPath, bodyBuffer)
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `agent-httpd unreachable: ${err.message}` }))
    return
  }
  const chunks = []
  resp.on('data', (c) => chunks.push(c))
  resp.on('end', () => {
    const body = Buffer.concat(chunks)
    res.writeHead(resp.statusCode, { 'Content-Type': 'application/json' })
    res.end(body)
  })
}

// Normalize the agent-httpd tools payload into the frontend ToolSchema shape.
function normalizeTools(payload) {
  const tools = (payload && payload.tools) || []
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.desc || t.description || '',
      parameters: t.parameters || {},
      fromMcp: !!t.server,
      needsApproval: !!t.needsApproval,
    })),
  }
}

module.exports = { proxySSE, proxyJSON, normalizeTools, agentPath, translateFrame }
