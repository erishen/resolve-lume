'use strict'
// Shared helpers for resolve-lume business tools.
//
// These tools are ported from resolve-studio's packages/core/src/plugins/tools/
// (tool-*.ts + util-pse.ts). resolve-lume's execution engine is a zero-dependency
// Node sidecar, so every helper below is reimplemented on Node built-ins:
//   - runPseTask / runPseScript : spawn `uv run python <script>` with a
//     SIGTERM→SIGKILL timeout, bounded output, env-driven framework resolution.
//   - runMakeIn                   : spawn `make` in a host project (bind-mounted
//     under /workspace) with bounded output.
//   - httpGetJson                 : GET + JSON with a short timeout (service
//     probes like /health).
//   - path/truncation/ansi/CSV helpers shared by several tools.
//
// Path resolution is env-driven only (AUTOGEN_PSE_DIR / CREWAI_PSE_DIR /
// LANGGRAPH_PSE_DIR / LLAMAINDEX_PSE_DIR / WORDPRESS_TOOLS_DIR / ...). If the
// variable is unset the tool fails fast with an actionable message instead of
// guessing a location — the resolve-lume container currently ships WITHOUT these
// business env vars, so tools surface a clear "未配置 XX" guidance rather than a
// 500.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { unsafeMakeArgs } = require('./security')

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace'

// ---- repo short-name → real path ----
// 文件类工具的相对路径基准是 WORKSPACE_DIR（<monorepo 根>/work），但项目实际
// 散在 work/<group>/<repo>（如 work/lume/lume-a2a）或 frameworks/ 下。模型按
// 仓库名自然写出的 "lume-a2a/README.md" 会被拼成 work/lume-a2a → ENOENT，
// 进而误判「这个仓库不在工作区里」。这里把首段短名映射回真实目录。
let PROJECT_DIR_CACHE = null
function projectDirMap() {
  if (PROJECT_DIR_CACHE) return PROJECT_DIR_CACHE
  const map = {}
  try {
    const root = process.env.CREWAI_PSE_DIR
    if (root) {
      const raw = fs.readFileSync(
        path.join(root, 'tasks', 'project-articles', 'projects.json'),
        'utf8',
      )
      for (const [k, v] of Object.entries(JSON.parse(raw))) {
        if (v && typeof v.source_dir === 'string' && v.source_dir) map[k] = v.source_dir
      }
    }
  } catch { /* 没配 crewai-pse 就只靠下面的目录探测 */ }
  PROJECT_DIR_CACHE = map
  return map
}

function mapRepoAlias(p) {
  const input = String(p || '')
  if (!input || path.isAbsolute(input)) return input
  const segs = input.split(/[\\/]/)
  const first = segs[0]
  if (!first || first === '.' || first === '..') return input
  // 1) 基准目录下本来就存在 → 不要动
  if (fs.existsSync(path.join(WORKSPACE_DIR, first))) return input
  // 2) projects.json 的 source_dir（相对 monorepo 根 = WORKSPACE_DIR 的父级）
  const src = projectDirMap()[first]
  if (src) {
    const abs = path.isAbsolute(src)
      ? src
      : path.resolve(path.dirname(WORKSPACE_DIR), src)
    return path.join(path.relative(WORKSPACE_DIR, abs), ...segs.slice(1))
  }
  // 3) work/<group>/<first> 一层探测：覆盖未登记进 projects.json 的仓库
  try {
    for (const e of fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (fs.existsSync(path.join(WORKSPACE_DIR, e.name, first))) {
        return path.join(e.name, first, ...segs.slice(1))
      }
    }
  } catch { /* WORKSPACE_DIR 不可读就原样返回，交给调用方报错 */ }
  return input
}

// Free-tier upstream models occasionally emit their tool-call control tokens
// into generated prose. In practice it lands in the YAML frontmatter `title:`
// line (measured: both lume-a2a articles came out as `title: <｜｜DSML｜｜ calls>`),
// which makes the article unpublishable. Clean ONLY that line — never rewrite
// the body, where angle-bracket text can be legitimate.
function sanitizeArticleFrontmatter(text, fallbackTitle) {
  const src = String(text || '')
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!block) return { text: src, fixes: [] }
  const titleRe = /^title:[ \t]*(.*)$/m
  const hit = titleRe.exec(block[1])
  if (!hit) return { text: src, fixes: [] }
  const raw = hit[1].trim()
  const polluted = /<[｜|│][^>]*>/.test(raw) || !raw || /^(calls?|tool_calls?|null|undefined)$/i.test(raw)
  if (!polluted) return { text: src, fixes: [] }
  let title = raw
    .replace(/<[｜|│][^>]*>/g, '')
    .replace(/^[<>\s,.:;｜|│-]+|[<>\s,.:;｜|│-]+$/g, '')
    .trim()
  if (!title || /^(calls?|tool_calls?|null|undefined)$/i.test(title)) title = fallbackTitle || 'Untitled'
  const safe = title.replace(/"/g, '\\"')
  const newBlock = `---\n${block[1].replace(titleRe, `title: "${safe}"`)}\n---`
  return {
    text: src.replace(block[0], () => newBlock),
    fixes: [`title 被上游 tool-call token 污染，已改为 "${title}"`],
  }
}

// ---- bounded output ----
function truncate(s, max) {
  s = String(s ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}
// Keep the TAIL: publish/build-style make tasks print their real conclusion at
// the end of the log ("✅ 已发布 → URL", final make status), while the head is
// skipped-article noise. Failure paths use this so conclusions survive.
function truncateToTail(s, max) {
  s = String(s ?? '')
  return s.length <= max ? s : `…[truncated ${s.length - max} chars head]…\n${s.slice(-max)}`
}

// ---- framework dir resolution (env-only, port of util-pse.ts) ----
const PSE_FRAMEWORK_ENVS = {
  autogen: 'AUTOGEN_PSE_DIR',
  crewai: 'CREWAI_PSE_DIR',
  langgraph: 'LANGGRAPH_PSE_DIR',
  llamaindex: 'LLAMAINDEX_PSE_DIR',
}

function resolvePseDir(framework) {
  const env = PSE_FRAMEWORK_ENVS[framework]
  const dir = process.env[env]
  if (!dir) {
    throw new Error(
      `${env} is not set. Export it to the absolute path of the ${framework}-pse framework root (e.g. in .env).`,
    )
  }
  if (!path.isAbsolute(dir)) {
    // Host mode: env values are absolute host paths (e.g. /Users/<you>/...).
    // A relative value means the user pasted the wrong thing.
    throw new Error(
      `${env} must be an absolute host path (got "${dir}"). ` +
        `Hint: e.g. /Users/<you>/.../frameworks/${framework}-pse.`,
    )
  }
  return dir
}

function resolvePseDirOrNull(framework) {
  const dir = process.env[PSE_FRAMEWORK_ENVS[framework]]
  return dir && dir.length ? dir : null
}

function resolveTaskDir(framework, task) {
  return path.join(resolvePseDir(framework), 'tasks', task)
}

// Anchor a model-supplied relative path (e.g. the documented "tasks/hot-news/news")
// at the framework root; absolute values pass through untouched.
function absolutizeTaskPath(rawPath, frameworkRoot) {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(frameworkRoot(), rawPath)
}

// ---- uv environment (port of util-pse.ts uvEnvFor) ----
// When PSE_UV_VENV_ROOT is set (container deployments), redirect each project's
// uv venv into a container-private dir (/opt/pse-venvs/<name>) so Linux venvs are
// never written into the shared bind mount (which would clobber the host macOS
// .venv). Locally (unset) it returns baseEnv unchanged.
function uvEnvFor(cwd, baseEnv) {
  const venvRoot = process.env.PSE_UV_VENV_ROOT
  if (!venvRoot || (baseEnv && baseEnv.UV_PROJECT_ENVIRONMENT)) return baseEnv || process.env
  let name = 'default'
  const fw = String(cwd).match(/\/frameworks\/([^/]+)\//)
  const app = String(cwd).match(/\/workspace\/[^/]+\/(?:apps\/)?([^/]+)(?:\/|$)/)
  if (fw) name = fw[1]
  else if (app) name = app[1]
  const env = { ...(baseEnv || process.env), UV_PROJECT_ENVIRONMENT: path.join(venvRoot, name) }
  // llamaindex-pse is not editable-installed inside the container: without the
  // framework src on PYTHONPATH, run.py's `from llamaindex_pse.model import …`
  // fails in noSync mode. Only inject when the src actually exists. Derive the
  // src from LLAMAINDEX_PSE_DIR when set (env-driven), else fall back to the
  // default FRAMEWORKS_DIR mount point.
  if (name === 'llamaindex-pse') {
    const base = process.env.LLAMAINDEX_PSE_DIR || '/workspace/frameworks/llamaindex-pse'
    const src = path.join(base, 'src')
    try {
      if (fs.statSync(src).isDirectory()) {
        env.PYTHONPATH = env.PYTHONPATH ? `${src}:${env.PYTHONPATH}` : src
      }
    } catch {
      // no /workspace mount (local runs) — skip
    }
  }
  env.PYTHONUNBUFFERED = '1'
  return env
}

// ---- child process runner (port of util-pse.ts spawnCapture) ----
const DEFAULT_RUN_TIMEOUT_MS = 300_000
const MAX_OUTPUT = 64 * 1024

// Python 框架普遍用 load_dotenv(..., override=False)：环境变量里存在「空
// 字符串」也算「已设置」，会把框架自己 .env 里真正的凭据挡在外面 → LLM
// 启动即 401/429。article-write 曾单独修过一次（buildArticleRunEnv），但
// resume-tailor / interview-questions / crm-task / hot-news 等走默认 env
// 的流水线仍会中招。放到所有子进程的统一入口根治：只删空串，保留显式
// 配置的有效值（pse-review 的 buildRunEnv 会写非空的 OPENAI_MODEL）。
function cleanChildEnv(env) {
  const out = { ...(env || process.env) }
  for (const k of Object.keys(out)) {
    if (/^(OPENAI_|ANTHROPIC_|DEEPSEEK_)/.test(k) && (out[k] === '' || out[k] == null)) delete out[k]
  }
  return out
}

async function spawnCapture(opts) {
  const { tool, cwd, cmdArgs, timeoutMs, maxOutput, env, onProgress } = opts
  let stdout = ''
  let stderr = ''
  let spawnErr = null
  try {
    const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
      cwd,
      env: cleanChildEnv(uvEnvFor(cwd, env)),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timeout = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* ignore */ }
      }, 5000).unref()
    }, timeoutMs)
    const collect = (sink) => (chunk) => {
      const text = chunk.toString()
      if (sink === 'stdout') {
        stdout += text
        if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput)
      } else {
        stderr += text
        if (stderr.length > maxOutput) stderr = stderr.slice(-maxOutput)
      }
      if (typeof onProgress === 'function') onProgress(text)
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    const code = await new Promise((done) => {
      child.on('close', done)
      child.on('error', (e) => {
        spawnErr = `${e.code || ''} ${e.message}`.trim()
        done(-1)
      })
    })
    clearTimeout(timeout)
    if (code !== 0) {
      const tail = stderr.slice(-500) || stdout.slice(-500)
      const why = spawnErr ? ` (spawn error: ${spawnErr})` : ''
      return { ok: false, error: `error: ${tool} exited with code ${code}${why}\n${tail}` }
    }
  } catch (e) {
    return { ok: false, error: `error: ${tool} spawn failed: ${e.message}` }
  }
  return { ok: true, stdout, stderr }
}

// Run any Python script via uv in a given cwd (port of runPseScript).
async function runPseScript(opts) {
  const {
    tool,
    script,
    cwd,
    args = [],
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxOutput = MAX_OUTPUT,
    env,
    noSync = false,
    onProgress,
  } = opts
  const cmdArgs = ['uv', 'run', ...(noSync ? ['--no-sync'] : []), 'python', script, ...args]
  const res = await spawnCapture({
    tool,
    cwd,
    cmdArgs,
    timeoutMs,
    maxOutput,
    env: env || { ...process.env },
    onProgress,
  })
  if (!res.ok) return res
  return { ok: true, stdout: res.stdout, stderr: res.stderr, cwd }
}

// Run `<framework>/tasks/<task>/run.py` via uv (port of runPseTask).
async function runPseTask(opts) {
  const {
    tool,
    framework,
    task,
    args = [],
    runFile = 'run.py',
    taskDir,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxOutput = MAX_OUTPUT,
    env,
    noSync = false,
    onProgress,
  } = opts
  let dir = taskDir
  let envName = PSE_FRAMEWORK_ENVS[framework]
  if (!dir) {
    try {
      dir = resolveTaskDir(framework, task)
    } catch (e) {
      return { ok: false, error: `error: ${tool} — ${e.message}` }
    }
  }
  const run = path.join(dir, runFile)
  try {
    await fsp.readFile(run)
  } catch {
    return {
      ok: false,
      error: `error: ${tool} — ${runFile} not found at ${run}. Check ${envName} path.`,
    }
  }
  // spawnCapture 把 cmdArgs[0] 当可执行文件（第 181 行），所以必须显式带
  // `uv`。此前这里写成 ['run', ...]，实际执行 spawn("run") → ENOENT，所有走
  // runPseTask 的流水线（article-write / pse-review / resume-tailor / ...）
  // 一调用就报 "exited with code -1 (spawn error: ENOENT spawn run ENOENT)"，
  // 模型只看到 runner 缺失，反复换参数重试也永远跑不起来。
  // runPseScript 一直是对的（['uv','run',...]），照它对齐。
  const cmdArgs = ['uv', 'run', ...(noSync ? ['--no-sync'] : []), 'python', run, ...args]
  const res = await spawnCapture({
    tool,
    cwd: dir,
    cmdArgs,
    timeoutMs,
    maxOutput,
    env: env || { ...process.env },
    onProgress,
  })
  if (!res.ok) return res
  return { ok: true, stdout: res.stdout, stderr: res.stderr, taskDir: dir, run }
}

// ---- make runner ----
// Runs `make <args...>` inside a host project (bind-mounted under /workspace).
// Extra args must be plain tokens (target names / KEY=VALUE); anything richer
// should go through the `shell` tool instead.
async function runMakeIn(cwd, makeArgs, opts) {
  // GNU make expands $(VAR) into a shell recipe. Even though we spawn `make`
  // with an argv array, any shell metacharacter inside KEY=value is eventually
  // interpreted by /bin/sh. Reject it once, here, for every caller.
  const unsafe = unsafeMakeArgs(makeArgs)
  if (unsafe.length) {
    return {
      ok: false,
      error: `error: unsafe make arguments rejected — ${unsafe.join('; ')}. ` +
        'make variable values are expanded by /bin/sh; only plain flags, slugs, paths and numbers are allowed.',
    }
  }
  const timeoutMs = (opts && opts.timeoutMs) || 300_000
  const maxOutput = (opts && opts.maxOutput) || 32 * 1024
  const env = (opts && opts.env) || uvEnvFor(cwd, process.env)
  const res = await spawnCapture({
    tool: `make ${(makeArgs || []).join(' ')}`,
    cwd,
    cmdArgs: ['make', '--no-print-directory', ...(makeArgs || [])],
    timeoutMs,
    maxOutput,
    env: { ...env, TERM: 'dumb' },
  })
  return res
}

// ---- http GET + JSON with a short timeout ----
async function httpGetJson(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 4000
  const headers = (opts && opts.headers) || undefined
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal, headers })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false }
  }
}

// ---- stage inline text to a temp file (JD/resume text inputs) ----
async function writeTempText(prefix, filename, content) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  const file = path.join(dir, filename)
  await fsp.writeFile(file, content, 'utf8')
  return file
}

// ---- hot-news: newest generated article (shared by check/publish) ----
async function latestHotNewsArticle(platform, hotNewsDir) {
  for (const dir of [path.join(hotNewsDir, 'articles'), hotNewsDir]) {
    try {
      const files = (await fsp.readdir(dir)).filter(
        (f) => f.endsWith('.md') && f.startsWith('hot_news_'),
      )
      if (!files.length) continue
      const matched = files.filter((f) => f.includes(`_${platform}_`))
      const pool = (matched.length ? matched : files).sort().reverse()
      return path.join(dir, pool[0])
    } catch {
      // dir missing / unreadable → try the next candidate
    }
  }
  return null
}

// ---- misc ----
// Strip ANSI escape codes (Rich panels / colored logs).
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '')
}

// ---- UI-controlled free/paid PSE provider preference ----
// The chat UI's 免费/付费 switch doubles as the PSE provider selector: when the
// user picks the paid model the sidecar sets this to 'deepseek', otherwise
// 'free'. Every PSE tool uses it as its default provider unless the tool call
// passes an explicit `provider`. Kept here (a module shared by all business
// tools) so the sidecar HTTP layer and the tool implementations agree.
let _pseProvider = process.env.PSE_REVIEW_PROVIDER === 'deepseek' ? 'deepseek' : 'free'
function getPseProvider() {
  return _pseProvider
}
function setPseProvider(p) {
  _pseProvider = p === 'deepseek' ? 'deepseek' : 'free'
}

module.exports = {
  WORKSPACE_DIR,
  mapRepoAlias,
  sanitizeArticleFrontmatter,
  PSE_FRAMEWORK_ENVS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_OUTPUT,
  truncate,
  truncateToTail,
  resolvePseDir,
  resolvePseDirOrNull,
  resolveTaskDir,
  absolutizeTaskPath,
  uvEnvFor,
  runPseScript,
  runPseTask,
  runMakeIn,
  httpGetJson,
  writeTempText,
  latestHotNewsArticle,
  stripAnsi,
  cleanChildEnv,
  spawnCapture,
  getPseProvider,
  setPseProvider,
}
