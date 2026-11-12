import fs from 'fs'
import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import reactRoute from './react-route.cjs'

// Dev-mode proxy. The production frontend is a Node server inside the compose
// frontend container (:18085) that injects X-Sidecar-Token itself. Vite has no
// such server, so it must inject the token on the Node side of the proxy —
// never ship it to the browser bundle (only VITE_*-prefixed vars are exposed).
//
// Old config pointed /api at :8787 ("web-server plugin"), which does not exist
// in this project: every dev request returned 502. The real endpoints are
//   sidecar (host)  :3000  -> /api/*
//   agent-httpd     :8080  -> /react/* (compose publishes it on loopback)
// Both are reachable from the host, so `npm run dev` works with just the host
// launcher running; the frontend/backend containers are optional.
// Don't rely on import.meta.url here: package.json has no "type": "module",
// so Vite may bundle this config as CJS (where import.meta is undefined).
// The repo-root .env is the reliable anchor from either cwd.
const CWD = process.cwd()
const ROOT = fs.existsSync(path.join(CWD, '.env'))
  ? CWD
  : fs.existsSync(path.join(CWD, '..', '.env'))
    ? path.resolve(CWD, '..')
    : CWD

export default defineConfig(({ mode }) => {
  // prefixes: '' -> read every key from the repo-root .env (SIDECAR_TOKEN is
  // deliberately NOT VITE_-prefixed, so it can never leak into client code).
  const env = loadEnv(mode, ROOT, '')
  const token = env.SIDECAR_TOKEN || process.env.SIDECAR_TOKEN || ''
  // Overridable from the repo-root .env or the shell (e.g. point /api at the
  // compose frontend :18085 instead of the host sidecar).
  const apiTarget = env.VITE_API_TARGET || process.env.VITE_API_TARGET || 'http://127.0.0.1:3000'
  const backendTarget =
    env.VITE_BACKEND_TARGET || process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:8080'
  // browser-desk publishes noVNC (websockify) on host 127.0.0.1:16082.
  const desktopTarget =
    env.VITE_DESKTOP_TARGET || process.env.VITE_DESKTOP_TARGET || 'http://127.0.0.1:16082'
  if (!token) {
    console.warn(
      '[vite] SIDECAR_TOKEN not found in repo-root .env — /api proxy will get 401. ' +
        'See README / .env.example (openssl rand -hex 32).',
    )
  }

  // Force OUR token: a same-origin browser fetch can set X-Sidecar-Token too,
  // so remove any client-supplied value before injecting the trusted one.
  const withToken = (proxy: { on: (event: string, cb: (req: import('http').ClientRequest) => void) => void }) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('x-sidecar-token')
      if (token) proxyReq.setHeader('X-Sidecar-Token', token)
    })
  }

  return {
    plugins: [
      react(),
      // Dev parity with server-entrypoint.mjs: the /react proxy is for static
      // demo pages only. Without this, `npm run dev` would let the browser
      // bypass the per-task tool allow-list via /react/api/chat|tools/call.
      {
        name: 'block-direct-backend-api',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!reactRoute.reactPathIsPublic(req.url)) {
              res.statusCode = 403
              res.setHeader('Content-Type', 'text/plain')
              res.end('Forbidden: direct backend API is disabled')
              return
            }
            next()
          })
        },
      },
    ],
    envDir: ROOT,
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
          // Long agent runs stream for minutes; never cut the SSE connection.
          timeout: 0,
          proxyTimeout: 0,
          configure: withToken,
        },
        '/react': {
          target: backendTarget,
          // CRITICAL: keep the original Host. agent-httpd does a same-origin
          // check and answers 403 when Host is rewritten to the upstream.
          changeOrigin: false,
          timeout: 0,
          proxyTimeout: 0,
        },
        // 桌面 tab in dev: proxy noVNC to the published browser-desk port and
        // tunnel the websocket, mirroring server-entrypoint.mjs.
        '/novnc': {
          target: desktopTarget,
          changeOrigin: true,
          ws: true,
          rewrite: (p) => p.replace(/^\/novnc/, '') || '/',
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  }
})
