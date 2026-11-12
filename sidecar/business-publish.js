'use strict'
// Batch: article publishing & wordpress-tools make targets.
// Pattern seed: build-juejin — the canonical "make target in a host project"
// flow (WORDPRESS_TOOLS_DIR-gated). The other wordpress-tools tasks (juejin-draft,
// juejin-publish, wechat-draft, sf-pw-publish) follow the exact same shape with
// per-task timeout/session checks; crewai-pse publish/validate/archive/discover
// follow it with CREWAI_PSE_DIR gating + a preview gate on confirm.
const fs = require('fs')
const path = require('path')
const H = require('./business-helpers')
const { summarizeQueueOutput, QUEUE_TASKS } = require('./queueOutput')
const { runPublishPending } = require('./publishPending')
const { resyncPendingList } = require('./pendingResync')

const WP_TOOLS = process.env.WORDPRESS_TOOLS_DIR

const TASK_TIMEOUT_MS = 300_000
const BROWSER_TASK_TIMEOUT_MS = 600_000 // sf-pw-publish: Chrome boot + login probe + publish
const BROWSER_TASKS = new Set(['sf-pw-publish'])

// Queue-driven make targets print one skip block per article before acting on
// one; queueOutput.js trims that trace down to the real conclusion so the model
// cannot mistake "skipped" for "nothing to do".

// Probe whether the storageState in .sf-state.json is still accepted by the
// server: a 3xx redirect to /user/login means the session truly expired; a 200
// means it is still valid even if the file mtime is old.
async function probeSfSession(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    const cookieStr = ((parsed.cookies || []).map((c) => `${c.name}=${c.value}`)).join('; ')
    if (!cookieStr) return 'unknown'
    const res = await fetch('https://segmentfault.com/write', {
      method: 'GET',
      redirect: 'manual',
      headers: {
        cookie: cookieStr,
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    })
    const status = res.status
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location') || ''
      res.body && res.body.cancel().catch(() => {})
      if (/(user\/login|signin|oauth|passport)/i.test(loc)) return 'expired'
      return 'valid'
    }
    if (status === 200) {
      res.body && res.body.cancel().catch(() => {})
      return 'valid'
    }
    res.body && res.body.cancel().catch(() => {})
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// Generic wordpress-tools make-task runner (shared by all 5 tasks).
async function runWpMakeTask(name, label, makeTarget, timeoutMs) {
  if (!WP_TOOLS) {
    return `error: ${name} 不可用 — WORDPRESS_TOOLS_DIR 未设置，请在 .env 中配置 wordpress-tools 的路径。`
  }
  // 真浏览器发布任务：先校验登录态，避免在容器/无显示环境里傻等登录超时。
  if (name === 'sf-pw-publish') {
    const statePath = path.join(WP_TOOLS, '.sf-state.json')
    if (!fs.existsSync(statePath)) {
      return (
        `error: 登录态未建立（${statePath} 不存在）。\n` +
        `请先登录一次以写回新鲜登录态：在宿主机 wordpress-tools 目录运行 make sf-pw-publish（会弹 Chrome，登录后写回 .sf-state.json）。`
      )
    }
    const ageMs = Date.now() - fs.statSync(statePath).mtimeMs
    const MAX_AGE_MS = 7 * 24 * 3600 * 1000
    if (ageMs > MAX_AGE_MS) {
      const probe = await probeSfSession(statePath)
      const ageDays = (ageMs / 86400000).toFixed(1)
      if (probe === 'expired') {
        return (
          `error: 登录态已过期（${statePath} 最后刷新 ${ageDays} 天前，且服务端已将其重定向到登录页）。\n` +
          `请在宿主机 wordpress-tools 目录运行 make sf-pw-publish 刷新会话后重试。`
        )
      }
    }
  }
  const res = await H.runMakeIn(WP_TOOLS, [makeTarget], {
    timeoutMs: timeoutMs,
    maxOutput: 32 * 1024,
  })
  if (!res.ok) {
    const tail = res.error || '(no output)'
    const hint = /SF_SESSION_EXPIRED|登录态已失效|未登录思否|PHPSESSID/.test(tail)
      ? `\n💡 看起来是登录态失效：请在宿主 wordpress-tools 目录运行 make sf-pw-publish 刷新会话后重试。`
      : ''
    return `error: ${name} failed — ${H.truncateToTail(tail, 4000)}${hint}`
  }
  const combined = (res.stdout || '') + (res.stderr ? '\n--- stderr ---\n' + res.stderr : '')
  if (QUEUE_TASKS.has(name)) {
    // The make target wrote an id back into an article frontmatter. The product
    // convention says the pending list then shortens automatically — that is
    // NOT wordpress-tools' job, so close the loop here (best effort, one line).
    return summarizeQueueOutput(label, combined) + (await resyncPendingList(label))
  }
  return `> ${label} 完成 (make ${makeTarget})\n\n` + H.truncate(combined, 32 * 1024)
}

// ---- crewai-pse article tools (port of tool-crewai-publish.ts / tool-crewai-discover.ts) ----
const CREWAI_TASK_TIMEOUT_MS = 300_000
const CREWAI_VALIDATE_TIMEOUT_MS = 60_000
const CREWAI_DISCOVER_TIMEOUT_MS = 120_000
const CREWAI_EXEC_MAX_OUTPUT = 4 << 20
const CREWAI_DISCOVER_MAX_OUTPUT = 64 * 1024

const CREWAI_TASKS = {
  'article-validate': { label: '校验文章', target: 'validate', preValidate: false },
  // 写操作标记 mutates：归档会把文章移出 articles/pse/zh、发布会把文章标记成已发布，
  // 候选集合本身会变，位置编号随之失效 —— 这两类只认项目名（见下方数字分支）。
  'article-publish': { label: '发布文章', target: 'publish', preValidate: true, mutates: true },
  'article-archive': { label: '归档文章', target: 'archive', preValidate: false, mutates: true },
}

function crewaiPseDir() {
  return process.env.CREWAI_PSE_DIR || null
}

function loadJsonKeys(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return Object.keys(JSON.parse(raw) || {})
  } catch {
    return []
  }
}

// Project enum = union of the pending queue (projects.json) and the generated
// articles directory (WORDPRESS_TOOLS_DIR/articles/pse/zh). Read fresh on every
// call — keys added after startup must be selectable, same as the TS original.
function loadArticleKeys() {
  const keys = new Set()
  const creai = crewaiPseDir()
  if (creai) {
    const projectsFile = path.join(creai, 'tasks', 'project-articles', 'projects.json')
    for (const k of loadJsonKeys(projectsFile)) keys.add(k)
  }
  const wp = process.env.WORDPRESS_TOOLS_DIR
  if (wp) {
    const dir = path.join(wp, 'articles', 'pse', 'zh')
    try {
      for (const name of fs.readdirSync(dir).sort()) {
        const m = /^(.+?)-zh\.md$/.exec(name)
        if (!m) continue
        // 下划线 slug（resolve_tui）→ 连字符 project key（resolve-tui）
        keys.add(m[1].replace(/_/g, '-'))
      }
    } catch {
      // 目录不存在/不可读：仅用 json 队列
    }
  }
  // projects.json 的插入顺序在前，extra 文章按字母序追加在末尾。注意这份集合是活的：
  // 归档会把文章移出 articles/pse/zh，后面的编号随即前移 —— 所以编号只用于展示，
  // 写操作（archive / publish）必须传项目名，见 runCrewaiPublishTask 的数字分支。
  return [...keys]
}

// spawnCapture failure shape: `error: <tool> exited with code <c>\n<last-500>`.
// Pull the exit code and the pure output tail out of that envelope.
function exitOf(errStr) {
  const m = /exited with code (\S+)/.exec(String(errStr || ''))
  return m ? m[1] : 'unknown'
}
function tailOf(errStr) {
  const s = String(errStr || '')
  const nl = s.indexOf('\n')
  return nl >= 0 ? s.slice(nl + 1) : s
}

async function runCrewaiPublishTask(name, def, args) {
  const rawProject = args && args.project
  const confirm = args && args.confirm
  // 每次调用现取，别用注册时的快照。
  const projectKeys = loadArticleKeys()

  // 数字编号选择（1-based）：用户/agent 回 "4" → projectKeys[3]。
  // 写操作例外：编号是「此刻列表的第 N 项」，而归档/发布会改变这个集合本身。
  // 2026-11-10 实测：并行发 7 与 8，7 归档后 pse/zh 少一篇，8 就报
  // 「超出范围（1-7）」；若 8 后面还有项目，这个 8 会静默落到别的项目上
  //（归档错文章且不报错）。所以写操作只认项目名，数字交回调用方自己翻译。
  let project = rawProject
  const asIndex = project != null && /^\d+$/.test(String(project).trim())
  if (asIndex && def.mutates) {
    return (
      `error: ${name} 不接受编号选择。本工具的候选编号会随归档/发布而前移，` +
      `同一个「${String(project).trim()}」在不同时刻指向不同项目，可能归档错文章。\n` +
      `请按你上次呈现给用户的那份清单，把编号翻成项目名再传（project=<项目名>）。\n` +
      `当前可用项目名：${projectKeys.join(', ')}`
    )
  }
  if (asIndex) {
    const idx = parseInt(String(project).trim(), 10) - 1
    if (idx >= 0 && idx < projectKeys.length) project = projectKeys[idx]
    else return `error: 编号 ${project} 超出范围（1-${projectKeys.length}）`
  }

  // 未指定 project → 返回清单，不循环追问。
  if (!project) {
    if (projectKeys.length === 0) {
      return 'error: no projects configured in crewai-pse projects.json.'
    }
    return (
      `(清单模式：未指定 project) 可用项目如下 —— 编号只供人阅读，${name} 不接受编号：\n` +
      projectKeys.map((k, i) => `${i + 1}. ${k}`).join('\n') +
      `\n\n要预览并执行某篇，请再次调用本工具并带 \`project=<项目名>\`（如 project="resolve-studio"）；` +
      `用户回数字时，按上面这份清单把数字翻成项目名再传，不要把编号透传给工具。` +
      `本工具默认只预览不执行，确认执行需另带 confirm=true。`
    )
  }

  if (projectKeys.length > 0 && !projectKeys.includes(project)) {
    return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
  }

  // 每次只能处理一篇：拒绝逗号/空白分隔的多项目。
  if (/[,\s]/.test(project)) {
    return `error: ${name} 每次只能处理一篇文章（一个 project）。收到 "${project}" 疑似含多个项目；请只传单个 project，需要多篇时分别调用本工具。`
  }

  const CREWAI_PSE = crewaiPseDir()
  if (!CREWAI_PSE) {
    return 'error: CREWAI_PSE_DIR is not set. Export it to the absolute path of the crewai-pse framework root (e.g. in .env).'
  }

  // 发布前只读校验（article-publish 在预览与执行两道门前各跑一次）。
  const runValidate = () =>
    H.runMakeIn(CREWAI_PSE, ['validate', `P=${project}`], {
      timeoutMs: CREWAI_VALIDATE_TIMEOUT_MS,
      maxOutput: CREWAI_EXEC_MAX_OUTPUT,
      env: H.uvEnvFor(CREWAI_PSE, process.env),
    })

  // 预览安全闸门：confirm !== true 时绝不真正执行。
  if (confirm !== true) {
    let validated = false
    if (def.preValidate) {
      const res = await runValidate()
      if (!res.ok) {
        return (
          `⚠️ 预览中止：article-validate 未通过（exit ${exitOf(res.error)}），执行会被拦截。请先修复后再带 confirm=true 调用。\n\n` +
          H.truncate(tailOf(res.error), 4000)
        )
      }
      validated = true
    }
    const ready = validated ? '，且发布前校验已通过（文章文件存在、frontmatter 完整）' : ''
    return (
      `👁️ 预览模式（未真正执行，仅展示将执行的操作）${ready}：\n` +
      `📋 project=${project} 已在队列中，可${def.label}。\n` +
      `📤 确认后将执行 \`make ${def.target} P=${project}\`（${def.label}）。\n` +
      `👉 请让用户确认；用户确认后再次调用本工具并带 \`confirm=true\`（只针对这一篇 project）即真正执行。`
    )
  }

  // confirm=true 执行前：article-publish 再跑一次校验，有错误则拦截。
  if (def.preValidate) {
    const res = await runValidate()
    if (!res.ok) {
      return (
        `⛔ 执行已拦截：article-validate 未通过（exit ${exitOf(res.error)}），请先修复以下问题：\n\n` +
        H.truncate(tailOf(res.error), 4000) +
        `\n\n修复后可重新调用 ${name}，或先用 article-validate 单独复查。`
      )
    }
  }

  // FLAGS=--yes 只有 publish 配方消费（非交互 exec 下 input() 读到 EOF 会被当成
  // 未确认而直接取消），故仅对 article-publish 追加，语义最窄。
  const makeArgs = [def.target, `P=${project}`]
  if (name === 'article-publish') makeArgs.push('FLAGS=--yes')

  const res = await H.runMakeIn(CREWAI_PSE, makeArgs, {
    timeoutMs: CREWAI_TASK_TIMEOUT_MS,
    maxOutput: CREWAI_EXEC_MAX_OUTPUT,
    env: H.uvEnvFor(CREWAI_PSE, process.env),
  })
  if (!res.ok) {
    return `error: ${name} failed (exit ${exitOf(res.error)}) — ${H.truncateToTail(tailOf(res.error), 4000)}`
  }
  const combined = (res.stdout || '') + (res.stderr ? '\n--- stderr ---\n' + res.stderr : '')
  return (
    `> ${def.label}完成 (make ${def.target} P=${project})\n\n` + H.truncate(combined, 32 * 1024)
  )
}

async function runArticleDiscover(args) {
  const add = !args || args.add !== false
  const CREWAI_PSE = crewaiPseDir()
  if (!CREWAI_PSE) {
    return 'error: article-discover — CREWAI_PSE_DIR is not set. Export it to the absolute path of the crewai-pse framework root (e.g. in .env).'
  }
  // --add 必须作为 make 变量传（FLAGS=--add），裸 `make discover --add` 会被 GNU
  // Make 当成自己的选项而中止。
  const makeArgs = ['discover']
  if (add) makeArgs.push('FLAGS=--add')
  const res = await H.runMakeIn(CREWAI_PSE, makeArgs, {
    timeoutMs: CREWAI_DISCOVER_TIMEOUT_MS,
    maxOutput: CREWAI_DISCOVER_MAX_OUTPUT,
    env: H.uvEnvFor(CREWAI_PSE, process.env),
  })
  if (!res.ok) {
    return `error: article-discover failed (exit ${exitOf(res.error)}) — ${H.truncate(tailOf(res.error), 4000)}`
  }
  const combined = (res.stdout || '') + (res.stderr ? '\n--- stderr ---\n' + res.stderr : '')
  // 读回 projects.json 的当前项目【详情】，附在返回值里——调用方（agent / PSE
  // Specialist）不必再 read-file 拿项目 desc/highlights：一次调用即拿到
  // 「产物路径 + 每个项目的 repo/desc/source_dir + discover 扫描输出」。
  // 仅给 key 清单不够：agent 为呈现项目详情仍会去 read projects.json，路径传错
  // 就空转（2026-11 连续两次 PSE/ReAct FAIL 的根因）。
  const projectsFile = path.join(CREWAI_PSE, 'tasks', 'project-articles', 'projects.json')
  const projectLines = []
  try {
    const obj = JSON.parse(fs.readFileSync(projectsFile, 'utf8')) || {}
    // 顺序必须与 article-write 的候选清单完全一致。旧实现用插入顺序而
    // article-write 用字母序，同一个「7」在两份清单里指向不同项目
    //（11-06 实测串台）；现在统一为插入顺序，7 = resolve-lume。
    for (const k of H.articleProjectKeys(CREWAI_PSE)) {
      const v = obj[k] || {}
      const repo = v.repo || ''
      const desc = String(v.desc || '').replace(/\s+/g, ' ').slice(0, 80)
      const src = v.source_dir || ''
      projectLines.push(`${k} — ${repo}：${desc}${src ? `（${src}）` : ''}`)
    }
  } catch {
    /* projects.json 缺失或解析失败 — discover stdout 仍返回 */
  }
  const header =
    `> projects.json: ${projectsFile}\n` +
    `> 当前已有 ${projectLines.length} 个项目（repo / desc / source_dir）：\n` +
    (projectLines.length
      ? projectLines.map((l, i) => `  ${i + 1}. ${l}`).join('\n') + '\n'
      : '  （空）\n') +
    `> ${add ? '已写入（含本次新增）' : 'dry-run（未写入，建议新增见下方日志）'}\n` +
    `> ⚠️ 以上编号列表即为完整项目清单，直接呈现给用户即可，无需再 read-file。\n` +
    `> ⚠️ 编号与 article-write 的候选清单完全一致：用户回「7」时，直接给 article-write 传 project="7"，由工具自行解析，不要自己翻译成项目名。\n` +
    (add ? '' : '> ⚠️ 下方扫描日志里出现的项目名都是【未注册候选】（可见性未确认为 public / 未写入 projects.json），不可直接用于 article-write。\n') +
    '\n'
  if (add) {
    // 写入模式：projects.json 已含本次新增，header 即权威完整清单。
    // 不透传 discover 的扫描日志——它很长（扫描 79 个项目 + 建议清单），
    // 经 sidecar_ro.lume 代理时会被 MCP 单帧限制截断到 20000 字符，agent
    // 看到"[truncated]"会误以为关键信息丢失而重试（2026-11 连续复发）。
    return header
  }
  // dry-run 模式：header 是当前清单，discover 日志含「建议新增」详情。
  // 摘要截到 8000，加 header 后总长 ~9000，远小于代理层 20000 限制。
  // 文案里不要出现「截断」字样：模型看到后会把完整返回误判为不完整，
  // 反复重跑同一工具并撞上游 429（2026-11 实测）。
  return (
    header +
    '--- discover 扫描日志（dry-run 摘要）---\n' +
    H.truncate(combined, 8000)
  )
}

module.exports = {
  'build-juejin': async () =>
    runWpMakeTask('build-juejin', '掘金建稿', 'build-juejin', TASK_TIMEOUT_MS),
  'juejin-draft': async () =>
    runWpMakeTask('juejin-draft', '掘金草稿', 'juejin-draft', TASK_TIMEOUT_MS),
  'juejin-publish': async () =>
    runWpMakeTask(
      'juejin-publish',
      '掘金草稿上线（可选）',
      'juejin-publish',
      TASK_TIMEOUT_MS,
    ),
  'wechat-draft': async () =>
    runWpMakeTask('wechat-draft', '微信草稿', 'wechat-draft', TASK_TIMEOUT_MS),
  'sf-pw-publish': async () =>
    runWpMakeTask('sf-pw-publish', '思否发布', 'sf-pw-publish', BROWSER_TASK_TIMEOUT_MS),
  'article-validate': async (args) =>
    runCrewaiPublishTask('article-validate', CREWAI_TASKS['article-validate'], args),
  'article-publish': async (args) =>
    runCrewaiPublishTask('article-publish', CREWAI_TASKS['article-publish'], args),
  'article-archive': async (args) =>
    runCrewaiPublishTask('article-archive', CREWAI_TASKS['article-archive'], args),
  'article-discover': async (args) => runArticleDiscover(args),
  // Read-only: list what is still unpublished per platform. Never writes, so
  // needsApproval is false and the model may call it freely to answer 清单 questions.
  'publish-pending': async () => runPublishPending(),
}
