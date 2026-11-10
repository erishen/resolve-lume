import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import { novncUpstreamPath } from './novnc-route.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Vite builds index.html and assets/ directly at the working directory level
const distDir = __dirname;
const distRoot = path.resolve(distDir);

// ---------------------------------------------------------------------------
// Fail-closed shared secret. This Node process is the ONLY place that injects
// X-Sidecar-Token into upstream requests, so a missing/empty token would turn
// every /api call (which can read host files and run shell) into an open door.
// There is intentionally no default value anywhere in the source tree.
// ---------------------------------------------------------------------------
const sidecarToken = process.env.SIDECAR_TOKEN;
if (!sidecarToken || sidecarToken.length < 16) {
  console.error('FATAL: SIDECAR_TOKEN is missing or too short. Set a random value in .env (openssl rand -hex 32) and recreate the frontend container.');
  process.exit(1);
}

// The generated bridge and the host sidecar read the same .env value. Log only
// a fingerprint so operators can compare three processes without leaking it.
console.log(`[frontend] sidecar token fingerprint ${createHash('sha256').update(sidecarToken).digest('hex').slice(0, 8)}`);

// Mirrors frontend/nginx.conf (which is NOT loaded by this image). The meta CSP
// in index.html also ships in dist; both are applied and the stricter union of
// directives wins, so keep script-src/style-src in sync with that meta tag.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// Host allowlist defeats DNS rebinding: a page served from an attacker domain
// resolves to 127.0.0.1 but still sends its own Host/Origin.
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]',
  '127.0.0.1:80', 'localhost:80', '[::1]:80',
  '127.0.0.1:18085', 'localhost:18085', '[::1]:18085',
]);
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1', 'http://localhost',
  'http://127.0.0.1:18085', 'http://localhost:18085',
  // Vite dev server proxy (see frontend/vite.config.ts)
  'http://127.0.0.1:5173', 'http://localhost:5173',
]);

function reject(req, res, reason) {
  res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
  res.end('Forbidden: ' + reason);
}

function requestIsLocal(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return 'unexpected Host header';
  // Requests without Origin (curl, container healthcheck, same-origin GET) are
  // fine; cross-site POSTs always carry an Origin and must match this app.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) {
    return 'cross-site Origin rejected';
  }
  return null;
}

// Containment check for the /assets/ branch. Without it, a request target like
// /assets/../../../../../../etc/passwd (which clients such as `curl
// --path-as-is` send verbatim; browsers normalize ../ before sending) resolved
// OUTSIDE the docroot and served any file the container could read — including
// /proc/1/environ, which leaks SIDECAR_TOKEN used to guard the host sidecar.
// Vite only ever emits /assets/<file>, so rejecting anything that escapes
// distRoot costs nothing real.
function safeAssetPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(distRoot, '.' + decoded);
  if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) return null;
  return resolved;
}

const sidecarUrl = 'http://host.docker.internal:3000';
const backendUrl = 'http://backend:8080';
// The 桌面 tab embeds noVNC from the browser-desk container. Its 6080 is
// published on the host at 16082, and the frontend container reaches the host
// through the same host-gateway alias the /api proxy already uses. Overridable
// for a different published port without rebuilding the image.
const desktopUrl = process.env.DESKTOP_URL || 'http://host.docker.internal:16082';

// noVNC is a full document with its own inline bootstrapping, so the SPA's CSP
// does not fit it. More importantly the tab embeds it in an iframe, and the
// default X-Frame-Options: DENY made the frame refuse to render even though it
// is same-origin. Desktop responses therefore carry a same-origin framing policy.
const DESKTOP_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

function proxyRequest(req, res, targetUrl, opts = {}) {
  const parsed = new URL(targetUrl);
  // Strip any client-supplied token first, then force our own. Object keys with
  // different casing would otherwise emit TWO X-Sidecar-Token headers and the
  // sidecar could compare against the client-controlled one.
  const headers = { ...req.headers };
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'x-sidecar-token') delete headers[k];
  }
  if (opts.injectToken !== false) headers['X-Sidecar-Token'] = sidecarToken;
  // Keep the ORIGINAL Host. agent-httpd rejects /react/* when Host is rewritten
  // to the upstream address (403) — this was a real incident in this project.
  // Keep SSE streams unbuffered end-to-end.

  const proxyOpts = {
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: opts.path || req.url,
    method: req.method,
    headers,
  };

  const proxyReq = http.request(proxyOpts, (proxyRes) => {
    // Forward upstream headers (notably Content-Type: text/event-stream) instead
    // of dropping them; drop hop-by-hop ones and let Node choose the framing.
    const upstream = { ...proxyRes.headers };
    for (const h of ['connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization', 'x-frame-options']) {
      delete upstream[h];
    }
    res.writeHead(proxyRes.statusCode || 200, { ...upstream, ...(opts.resHeaders || SECURITY_HEADERS) });
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
}

function serveStatic(req, res) {
  let filePath;

  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(distDir, 'index.html');
  } else if (req.url.startsWith('/assets/')) {
    filePath = safeAssetPath(req.url);
    if (filePath === null) {
      // Reject the traversal attempt outright; do not fall back to index.html,
      // which would disguise it as a normal SPA deep link.
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }
  } else {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(distDir, 'index.html');
  }

  const contentType = ext ? {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.json': 'application/json'
  }[ext] : 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('Error loading file');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const denied = requestIsLocal(req);
  if (denied) return reject(req, res, denied);

  if (req.url.startsWith('/api/')) {
    proxyRequest(req, res, sidecarUrl);
  } else if (req.url.startsWith('/react/')) {
    proxyRequest(req, res, backendUrl);
  } else if (novncUpstreamPath(req.url) !== null) {
    // 桌面 tab: /novnc/* -> browser-desk's noVNC root (websockify on 6080).
    proxyRequest(req, res, desktopUrl, {
      path: novncUpstreamPath(req.url),
      injectToken: false,
      resHeaders: DESKTOP_HEADERS,
    });
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('ok');
  } else {
    serveStatic(req, res);
  }
});

// noVNC talks to websockify over a WebSocket, so the HTTP proxy above is only
// half the path: without this upgrade tunnel the frame would show a page that
// can never connect. Only /novnc/* is tunnelled; anything else is refused.
server.on('upgrade', (req, socket, head) => {
  const upstreamPath = novncUpstreamPath(req.url);
  if (upstreamPath === null) {
    socket.destroy();
    return;
  }
  const parsed = new URL(desktopUrl);
  const upstreamReq = http.request({
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: upstreamPath,
    method: 'GET',
    headers: { ...req.headers },
  });
  upstreamReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 101 ${proxyRes.statusMessage}`];
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      lines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  upstreamReq.on('error', () => socket.destroy());
  upstreamReq.end();
});

// Equivalent of nginx.conf's proxy_read/send_timeout 1800s. Node's default
// socket timeout is already 0 (unlimited), but requestTimeout defaults to
// 300s in Node 18+ and can kill a long-running SSE/tool request; make the
// intent explicit so a future runtime upgrade cannot silently truncate streams.
server.timeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

server.listen(80, '0.0.0.0', () => {
  console.log('Frontend server running on port 80 (CSP + SSE timeouts active)');
});
