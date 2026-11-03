import type { ChatEvent, ToolSchema } from './types'

// lume agent-httpd 的 SSE 契约（见 agent-httpd/src/agent/chatio.c）：
//   每个事件是一帧 `data: {"t":"delta"|"note"|"error"|"done","d":"..."}` 以两个换行分隔。
// 注意：没有 `event:` 行，类型信息在 JSON 的 `t` 字段里。
export async function streamChat(opts: {
  message: string
  history: { role: string; content: string }[]
  pse: boolean
  onEvent: (e: ChatEvent) => void
  signal?: AbortSignal
}): Promise<void> {
  const { message, history, pse, onEvent, signal } = opts
  const res = await fetch(pse ? '/react/api/pse' : '/react/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      try {
        const ev = JSON.parse(dataLine.slice(5).trim()) as ChatEvent
        onEvent(ev)
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export async function fetchTools(): Promise<ToolSchema[]> {
  try {
    const res = await fetch('/react/api/tools')
    if (!res.ok) return []
    const data = (await res.json()) as { tools?: ToolSchema[] }
    return data.tools ?? []
  } catch {
    return []
  }
}
