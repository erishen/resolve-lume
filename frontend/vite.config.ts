import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地 dev 时把 /react 反代到 agent-httpd（默认 8080）。
// 生产由 nginx 反代（见 nginx.conf），此处仅为 dev 体验。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/react': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
