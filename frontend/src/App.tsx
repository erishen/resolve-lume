import { useCallback, useEffect, useRef, useState } from 'react'
import { streamChat, fetchTools } from './api'
import type { ChatEvent, ToolSchema } from './types'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  notes: string[]
}

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [pse, setPse] = useState(true)
  const [running, setRunning] = useState(false)
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchTools().then(setTools)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || running) return
    setError(null)
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, notes: [] },
      { role: 'assistant', content: '', notes: [] },
    ])
    setInput('')
    setRunning(true)
    try {
      await streamChat({
        message: text,
        history,
        pse,
        onEvent: (e: ChatEvent) => {
          if (e.t === 'error' && e.d) {
            setError(e.d)
            return
          }
          setMessages((prev) => {
            const copy = prev.slice()
            const last = copy[copy.length - 1]
            if (e.t === 'delta' && e.d) last.content += e.d
            else if (e.t === 'note' && e.d) last.notes.push(e.d)
            return copy
          })
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [input, running, messages, pse])

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>resolve-lume</h1>
        <p className="muted">lume · lume-core · react</p>
        <label className="pse-toggle">
          <input type="checkbox" checked={pse} onChange={(e) => setPse(e.target.checked)} />
          PSE 三角色编排
        </label>
        <div className="tools">
          <h2>已注册工具 ({tools.length})</h2>
          {tools.length === 0 ? (
            <p className="muted">连接后端后显示（含 lume-tools 桥接的工具）</p>
          ) : (
            <ul>
              {tools.map((t) => (
                <li key={t.name} title={t.desc}>{t.name}</li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="chat">
        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty">
              发送一条消息开始对话。后端未配置 LLM_API_KEY 时自动走离线 demo 引擎。
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`row ${m.role}`}>
              <div className="bubble">
                {m.content || (m.role === 'assistant' && running ? '…' : '')}
                {m.notes.length > 0 && (
                  <div className="notes">
                    {m.notes.map((n, j) => (
                      <span key={j} className="note">{n}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={3}
          />
          <button onClick={send} disabled={running || !input.trim()}>
            {running ? '生成中…' : '发送'}
          </button>
        </div>
      </main>
    </div>
  )
}
