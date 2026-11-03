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
// `buf` accumulates streamed text so `done` can carry the full answer.
function translateFrame(json, buf) {
  const t = json.t
  const d = json.d
  if (t === 'delta') {
    buf.text += d || ''
    return `event: delta\ndata: ${JSON.stringify({ text: d || '' })}\n\n`
  }
  if (t === 'note') {
    // agent status line -> reasoning channel (shown as thinking/status in UI)
    return `event: reasoning\ndata: ${JSON.stringify({ text: d || '' })}\n\n`
  }
  if (t === 'error') {
    return `event: error\ndata: ${JSON.stringify({ message: d || 'unknown error' })}\n\n`
  }
  if (t === 'done') {
    return `event: done\ndata: ${JSON.stringify({ answer: buf.text })}\n\n`
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
  res.writeHead(resp.statusCode, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const buf = { text: '' }
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
    res.end()
  })
  resp.on('error', () => res.end())
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

module.exports = { proxySSE, proxyJSON, normalizeTools, agentPath }
