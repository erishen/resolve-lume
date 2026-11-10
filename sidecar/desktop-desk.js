'use strict'
// Browser-desk bridge for the 桌面 tab.
//
// The desk is a shared, long-lived Chrome on a virtual display (Xvfb + x11vnc +
// websockify). Everything that ever used it — WeChat drafts, Xianyu, 思否 — shares
// the same tabs, so the desktop tab shows whatever was left on screen unless
// we explicitly open the page we need. This module is that explicit action, and
// it is also why the login endpoint must validate the URL: the caller can type
// anything into the box, and we push it into a browser that holds live sessions.
//
// Node built-ins only (global fetch), same constraint as the rest of sidecar/.

// Published desk CDP port on the host (container 9223 -> 127.0.0.1:10023).
const DEFAULT_CDP_URL = 'http://127.0.0.1:10023'
// browser-desk 登录中心 (drives the same desk through CDP).
const DEFAULT_LOGIN_HUB = 'http://127.0.0.1:18088'

function cdpUrl() {
  return (process.env.CDP_URL || DEFAULT_CDP_URL).replace(/\/$/, '')
}

function loginHubUrl() {
  return (process.env.DESK_LOGIN_HUB_URL || DEFAULT_LOGIN_HUB).replace(/\/$/, '')
}

/**
 * Normalizes a user-typed login URL. Bare hosts get https:// (the common case:
 * "segmentfault.com/user/login"); anything that is not http(s) is rejected so
 * javascript:/file:/data: URLs can never reach the shared browser.
 */
function normalizeLoginUrl(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return null
  if (/^(javascript|file|data|vbscript|about|blob):/i.test(text)) return null
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.toString()
}

/** Flattens the login hub payload into the site names the UI shows as chips. */
function deskSiteNames(payload) {
  const sites = payload && Array.isArray(payload.sites) ? payload.sites : []
  return sites.map((s) => (s && typeof s.name === 'string' ? s.name : null)).filter(Boolean)
}

/** True when the desk's DevTools endpoint answers (used for a clear error). */
async function probeDesk(timeoutMs = 2500) {
  try {
    const res = await fetch(`${cdpUrl()}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Opens `url` in a fresh tab of the desk and brings it to the front. Returns
 * the created target; throws with an actionable message when the desk is down.
 */
async function openInDesk(url, { timeoutMs = 8000 } = {}) {
  const target = normalizeLoginUrl(url)
  if (!target) throw new Error('无效的登录网址（只接受 http/https）')
  let res
  try {
    res = await fetch(`${cdpUrl()}/json/new?${encodeURIComponent(target)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(`无法连接 browser-desk（${cdpUrl()}）：${e.message || 'connection failed'}`)
  }
  if (!res.ok) throw new Error(`browser-desk 拒绝打开页面：HTTP ${res.status}`)
  return res.json()
}

/** Reads the login hub's site list; degrades to [] when the hub is down. */
async function deskSites({ timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(`${loginHubUrl()}/api/sites`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { sites: [], error: `HTTP ${res.status}` }
    return await res.json()
  } catch (e) {
    return { sites: [], error: e.message || 'login hub unreachable' }
  }
}

module.exports = {
  cdpUrl,
  loginHubUrl,
  normalizeLoginUrl,
  deskSiteNames,
  probeDesk,
  openInDesk,
  deskSites,
}
