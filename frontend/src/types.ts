export interface ChatEvent {
  t: 'delta' | 'note' | 'error' | 'done'
  d?: string
  [k: string]: unknown
}

export interface ToolSchema {
  name: string
  server?: string
  desc?: string
}
