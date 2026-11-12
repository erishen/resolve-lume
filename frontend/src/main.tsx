import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

// SPA 自己控制滚动（空状态置顶、会话底部跟随），禁止浏览器在刷新时恢复旧
// 滚动位置，否则会跟上面的受控逻辑打架、出现「刷新停在示例区中间」的观感。
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
