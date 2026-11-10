'use strict'
// Minimal .env loader for host-mode sidecar.
//
// Host mode runs the sidecar as a long-lived macOS process (not in Docker), so
// the container-era env surface from docker-compose.yml is no longer injected.
// We read the repo-root .env ourselves, but ONLY inject variables on an
// explicit whitelist. History: a stray ambient PORT=0 (or other dirty shell
// values) leaking into the sidecar process will silently make Node bind an
// ephemeral port and break every reverse proxy. Whitelisting means the host
// sidecar sees exactly the business vars it needs — nothing from the ambient
// shell.
//
// No npm deps — Node built-ins only.

const fs = require('fs')
const path = require('path')

// Business vars the sidecar actually reads. Kept in sync with the compose
// env list + a few host-only infra vars. Container-era vars are deliberately
// absent — they do not apply to host mode:
//   - COMPOSE_FILE            (compose routing, not a runtime var)
//   - *_SRC                   (WORDPRESS_TOOLS_SRC etc. — bind-mount sources)
//   - PSE_UV_VENV_ROOT        (container-private venv root; host uses .venv)
//   - FRAMEWORKS_DIR          (compose-side mount base, not read by sidecar)
const whitelist = [
  // network / process
  'PORT',
  'HOST',
  'SIDECAR_TOKEN',
  'AGENT_HTTPD_URL',
  // directories / roots
  'PSE_SOULS_DIR',
  'FS_ROOTS',
  'WORKSPACE_DIR',
  'DATA_DIR',
  // mcp / misc infra
  'MCP_SEED_FILE',
  'STOCK_SCAN_URL',
  // LLM gateway
  'LLM_MODEL',
  'LLM_API_URL',
  'LLM_API_KEY',
  'LLM_SYSTEM_EXTRA',
  // free/paid model identifiers (UI 开关来源；可在 .env 覆盖)
  'LLM_FREE_MODEL',
  'LLM_PAID_MODEL',
  // PSE switch
  'PSE_ENABLED',
  // PSE framework roots
  'AUTOGEN_PSE_DIR',
  'CREWAI_PSE_DIR',
  'LANGGRAPH_PSE_DIR',
  'LLAMAINDEX_PSE_DIR',
  // sensitive / business project roots
  'WORDPRESS_TOOLS_DIR',
  'ASSET_LENS_DIR',
  'LANGGRAPH_CSV_ANALYST_DIR',
  'PRODUCT_ANALYST_DIR',
  // dev-stats
  'DEV_STATS_DIR',
  'DEV_STATS_USER',
  'DEV_STATS_PREVIEW_BASE_URL',
  // self-hosted content libs
  'MARKDOWN_LIBRARY_URL',
  'MARKDOWN_LIBRARY_DIR',
  'MARKDOWN_LIBRARY_KEY',
  'PHOTO_LIBRARY_URL',
  'PHOTO_LIBRARY_DIR',
  'PHOTO_LIBRARY_KEY',
  'VIDEO_LIBRARY_URL',
  'VIDEO_LIBRARY_DIR',
  'VIDEO_LIBRARY_KEY',
  // external accounts / browser
  'ERISHEN_BASE',
  'CDP_URL',
  // 桌面 tab：browser-desk 登录中心与「打开并登录」目标（SF = SegmentFault 思否）
  'DESK_LOGIN_HUB_URL',
  'SF_LOGIN_ENABLED',
  'SF_LOGIN_URL',
  'SF_LOGIN_BUTTON_LABEL',
]

// Parse a .env file's text into a { KEY: VALUE } object.
// Rules:
//   - trim each line; skip blank lines and `#` comments
//   - split on the FIRST '=' only (VALUE may contain '=')
//   - strip one layer of matching surrounding single/double quotes
//   - NO variable expansion (no $OTHER / ${OTHER} substitution)
function parseEnvText(text) {
  const out = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue // no '=' or leading '=' (malformed) — skip
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip one layer of matching surrounding quotes.
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    out[key] = value
  }
  return out
}

// Read envPath, whitelist-filter, and inject into process.env without
// clobbering already-set vars (start-host.sh explicit values win).
//
// Returns the FULL parsed {KEY:VALUE} object (diagnostics). Logs ONLY key
// names — never values (LLM_API_KEY / SIDECAR_TOKEN must not hit stdout).
// Throws if the file cannot be read; caller (server.js) catches and degrades
// silently to ambient env (container mode).
function loadEnvFile(envPath, whitelist) {
  const text = fs.readFileSync(envPath, 'utf8')
  const parsed = parseEnvText(text)
  const wl = Array.isArray(whitelist) ? whitelist : []
  const injected = []
  for (const key of Object.keys(parsed)) {
    if (!wl.includes(key)) continue
    if (key in process.env) continue // explicit env wins over .env
    process.env[key] = parsed[key]
    injected.push(key)
  }
  // Key names only — values stay out of logs.
  console.log(
    `[envloader] injected ${injected.length} whitelisted var(s) from ${path.basename(envPath)}: ` +
      (injected.length ? injected.join(', ') : '(none)'),
  )
  return parsed
}

module.exports = { whitelist, loadEnvFile, parseEnvText }
