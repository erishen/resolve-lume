// Pure path mapping for the 桌面 tab proxy. Kept separate from
// server-entrypoint.mjs so the rule is testable without booting the server.
const PREFIX = '/novnc'

/**
 * Maps a browser URL under /novnc to the upstream (noVNC / websockify) path.
 * Returns null when the URL is not handled by the desktop proxy, so the caller
 * can fall through to the API proxy or the SPA.
 */
export function novncUpstreamPath (url) {
  const raw = String(url || '')
  if (raw === PREFIX || raw.startsWith(`${PREFIX}/`)) {
    const rest = raw.slice(PREFIX.length)
    return rest === '' || rest === '/' ? '/' : rest
  }
  return null
}
