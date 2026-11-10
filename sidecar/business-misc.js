'use strict'
// Batch: HTTP services + misc tools.
// Pattern seeds: doc-library-search (HTTP-service probe + fetch), pick-post
// (external REST with env gating), browser-open / browser-screenshot (minimal
// zero-dependency CDP driver over Node's built-in WebSocket — the sidecar ships
// no playwright, so we talk CDP to the shared browser-desk container directly;
// when the CDP endpoint is unreachable the tools return a start-it hint).
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const H = require('./business-helpers')
const { isSafeMakeVarValue } = require('./security')
const { buildTrafficDigest } = require('./devstats-digest')

// 把整句检索词拆成可单独检索的项：空白 + 中文连接词（的/和/与/及/或）都算分隔，
// 丢掉单字项（命中噪音太大）。用于严格匹配 0 命中时的放宽。
function docSearchTerms(q) {
  return String(q || '')
    .split(/[\s,，、;；:：]+|的|和|与|及|或/)
    .map((t) => t.trim())
    .filter((t) => t && ([...t].length >= 2 || /^[A-Za-z0-9]{2,}$/.test(t)))
}

// ===================== doc-library-search =====================
const MARKDOWN_LIBRARY_URL = process.env.MARKDOWN_LIBRARY_URL || 'http://127.0.0.1:3300'
const MARKDOWN_LIBRARY_KEY = process.env.MARKDOWN_LIBRARY_KEY || ''
const MARKDOWN_LIBRARY_DIR = process.env.MARKDOWN_LIBRARY_DIR || ''

module.exports = {
  docSearchTerms,
  'doc-library-search': async function docLibrarySearch(a) {
    const q = String((a && a.q) || '').trim()
    if (!q) return 'error: doc-library-search 需要 q 参数（检索词）。'
    const probe = await H.httpGetJson(`${MARKDOWN_LIBRARY_URL}/health`, {
      headers: MARKDOWN_LIBRARY_KEY ? { 'x-api-key': MARKDOWN_LIBRARY_KEY } : undefined,
    })
    if (!probe.ok) {
      return (
        `error: markdown-library 服务未运行（${MARKDOWN_LIBRARY_URL}/health 不可达）。\n` +
        `启动：cd ${MARKDOWN_LIBRARY_DIR || '<markdown-library 根目录 (设置 MARKDOWN_LIBRARY_DIR)>'} && make run（需先 cp .env.example .env）`
      )
    }
    const headers = MARKDOWN_LIBRARY_KEY ? { 'x-api-key': MARKDOWN_LIBRARY_KEY } : undefined
    const search = async (term) => {
      const r = await H.httpGetJson(`${MARKDOWN_LIBRARY_URL}/api/docs?q=${encodeURIComponent(term)}`, { headers })
      const list = (r.ok && r.data && r.data.items) || []
      return Array.isArray(list) ? list : []
    }
    const out = []
    let rows = await search(q)
    let relaxedBy = ''
    // 服务端检索是 AND 语义（每个词都要命中），整句提问（"RAG 的实现思路"、
    // "投资 组合"）经常 0 命中，被上层当成"文档库是空的"。这里按词放宽再合并。
    if (!rows.length) {
      const terms = docSearchTerms(q)
      if (terms.length > 1) {
        const merged = []
        const seen = new Set()
        for (const term of terms.slice(0, 4)) {
          for (const d of await search(term)) {
            const key = String(d.id ?? d.relative_path ?? d.title ?? '')
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(d)
          }
        }
        if (merged.length) {
          rows = merged
          relaxedBy = terms.join(' / ')
        }
      }
    }
    if (relaxedBy) {
      out.push(`检索「${q}」严格匹配 0 篇，已按分词放宽（${relaxedBy}）命中 ${rows.length} 篇：`, '')
    } else {
      out.push(`检索「${q}」命中 ${rows.length} 篇：`, '')
    }
    for (const d of rows.slice(0, 12)) {
      const title = d.title || d.name || d.relative_path || '?'
      // 命中高亮由服务端用 \u0001/\u0002 包裹，正文里要清掉，否则模型会当成乱码。
      const snippet = String(d.snippet || d.excerpt || '').replace(/[\u0001\u0002]/g, '')
      const ts = Number(d.updated_at || 0)
      const when = ts > 0 ? new Date(ts * 1000).toLocaleDateString('zh-CN') : ''
      out.push(`- **${title}**${when ? `（${when}）` : ''}`)
      const file = [d.base_path, d.relative_path].filter(Boolean).join('/').replace(/\/{2,}/g, '/')
      if (file) out.push(`  来源：${file}`)
      if (snippet) out.push(`  ${snippet.slice(0, 160)}`)
    }
    if (!rows.length) out.push('（无命中）')
    if (a && a.check_broken) {
      const b = await H.httpGetJson(`${MARKDOWN_LIBRARY_URL}/api/broken`, {
        headers: MARKDOWN_LIBRARY_KEY ? { 'x-api-key': MARKDOWN_LIBRARY_KEY } : undefined,
      })
      const broken = (b.ok && Array.isArray(b.data)) ? b.data : []
      out.push('', `坏链检查：${broken.length} 个坏链`,
        ...broken.slice(0, 10).map((x) => `  - ${x.path || x.from || String(x)}`))
    }
    return out.join('\n')
  },

  // ===================== pick-post =====================
  'pick-post': async function pickPost() {
    const base = process.env.ERISHEN_BASE
    if (!base) {
      throw new Error('ERISHEN_BASE is not set — add it to .env (your WordPress site base URL)')
    }
    let res
    try {
      res = await fetch(`${base}/wp-json/wp/v2/posts?per_page=100&status=publish`, {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      return `error: pick-post 无法访问 WordPress REST API（${base}）— ${e.message}`
    }
    if (!res.ok) return `error: list posts failed: ${res.status}`
    const posts = await res.json()
    if (!Array.isArray(posts) || posts.length === 0) return 'error: no published posts found'
    const p = posts[Math.floor(Math.random() * posts.length)]
    return JSON.stringify({
      id: p.id,
      title: ((p.title && p.title.rendered) || '').trim(),
      link: p.link || '',
    })
  },

  // ===================== browser-open / browser-screenshot =====================
  'browser-open': async function browserOpen(a) {
    const url = assertHttpUrl(a && a.url)
    const cdp = await getCdp()
    const target = await cdp.open(url)
    try {
      await cdp.waitReady(target, 12_000)
      const title = await cdp.evaluate(target, 'document.title')
      const text = String(
        await cdp.evaluate(
          target,
          'document.body ? document.body.innerText.slice(0, 200000) : ""',
        ),
      ).trim()
      const MAX = 8 * 1024
      return text.length > MAX
        ? `title: ${title}\n\n${text.slice(0, MAX)}\n… [truncated at ${MAX} chars]`
        : `title: ${title}\n\n${text}`
    } finally {
      cdp.close(target)
    }
  },

  'browser-screenshot': async function browserScreenshot(a) {
    const url = assertHttpUrl(a && a.url)
    const cdp = await getCdp()
    const target = await cdp.open(url)
    try {
      await cdp.waitReady(target, 12_000)
      const shotDir = path.join(process.env.DATA_DIR || '/app/.data', 'screenshots')
      await fsp.mkdir(shotDir, { recursive: true })
      const file = path.join(shotDir, `${Date.now()}.png`)
      const b64 = await cdp.screenshot(target)
      await fsp.writeFile(file, Buffer.from(b64, 'base64'))
      return `screenshot saved to ${file}`
    } finally {
      cdp.close(target)
    }
  },

  // ===================== analyze-code-dir =====================
  // resolve-studio 用 Serena MCP（symbol skeleton + LSP diagnostics）做语义层，
  // sidecar 没有 serena，直接走参考里的 fallback-raw 降级层：本地 BFS 收集源文件，
  // 每文件只报 path/size/lines，输出 JSON 硬预算 36KiB。
  'analyze-code-dir': async function analyzeCodeDir(a) {
    const p = String((a && a.dir) || '').trim()
    if (!p) return 'error: analyze-code-dir 需要 dir 参数（要分析的代码目录）。'
    // 相对路径锚定 sidecar 工作区（参考用 process.cwd()，sidecar 统一锚 H.WORKSPACE_DIR）。
    // 首段可能是仓库短名（lume-a2a → work/lume/lume-a2a），先做别名映射，
    // 否则模型按仓库名提问时必然 ENOENT 并误判「仓库不在工作区」。
    const mapped = path.isAbsolute(p) ? p : H.mapRepoAlias(p)
    const abs = path.isAbsolute(mapped) ? mapped : path.join(H.WORKSPACE_DIR, mapped)
    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      return `error: cannot access directory: ${abs}`
    }
    if (!st.isDirectory()) return `error: not a directory: ${abs}`

    const maxFiles = typeof (a && a.maxFiles) === 'number' ? a.maxFiles : 14
    const depth = typeof (a && a.depth) === 'number' ? a.depth : 2
    // includeDiagnostics 仅留作 note 文案：sidecar 无 Serena LSP，诊断层整体跳过。
    const includeDiagnostics = !(a && a.includeDiagnostics === false)

    const absFiles = await collectSourceFiles(abs, maxFiles, depth)
    const files = []
    for (const f of absFiles) {
      let size = 0
      let lines = 0
      try {
        const buf = await fsp.readFile(f)
        size = buf.length
        lines = buf.toString('utf8').split('\n').length
      } catch { /* unreadable — keep zeros */ }
      files.push({ path: path.relative(abs, f) || f, size, lines })
    }

    const report = {
      mode: 'fallback-raw',
      reason: 'Serena 未接入 sidecar（无 MCP serena 服务）',
      engine: 'analyze-dir',
      dir: abs,
      filesScanned: files.length,
      files,
      note: `Fallback raw walk：${files.length} 个顶层源文件（depth=${depth}），仅 size/lines，无符号骨架与 LSP 诊断。${includeDiagnostics ? '' : ''}`,
    }
    // Hard output budget: trim files from the tail until under 36KiB.
    let serialized = JSON.stringify(report)
    while (serialized.length > ANALYZE_DIR_BUDGET && files.length > 0) {
      files.pop()
      serialized = JSON.stringify(report)
    }
    if (serialized.length > ANALYZE_DIR_BUDGET) {
      report.note += `\n[report truncated to fit ${Math.round(ANALYZE_DIR_BUDGET / 1024)}KB output budget]`
      serialized = JSON.stringify(report)
    }
    return serialized
  },

  // ===================== portfolio-check =====================
  // 在 analysis-lens 项目里 make calculate/analyze/compare 刷新持仓快照，再扫描数值异常。
  'portfolio-check': async function portfolioCheck() {
    const assetLens = process.env.ASSET_LENS_DIR
    if (!assetLens) {
      return 'error: ASSET_LENS_DIR is not set. Export it to the absolute path of the asset-lens project root (e.g. in .env).'
    }
    // 容器私有 venv 重定向（PSE_UV_VENV_ROOT），同参考注释：避免覆盖宿主 macOS .venv。
    const env = H.uvEnvFor(assetLens)
    const logs = [`数据目录：${assetLens}`, '']

    logs.push('🔄 uv sync（首次为 asset-lens 构建容器私有 venv）...')
    const sync = await H.spawnCapture({
      tool: 'uv sync',
      cwd: assetLens,
      cmdArgs: ['uv', 'sync'],
      timeoutMs: 300_000,
      maxOutput: 16 << 20,
      env,
    })
    if (!sync.ok) {
      return `error: portfolio-check 在 uv sync 阶段失败 — ${H.truncate(sync.error || '', 800)}`
    }

    for (const step of ['calculate', 'analyze', 'compare']) {
      logs.push(`🔄 make ${step} ...`)
      const r = await H.runMakeIn(assetLens, [step], {
        timeoutMs: 300_000,
        maxOutput: 16 << 20,
        env,
      })
      if (!r.ok) {
        return `error: portfolio-check 在 make ${step} 阶段失败 — ${H.truncate(r.error || '', 800)}`
      }
      const notable = `${r.stdout}\n${r.stderr}`
        .split('\n')
        .filter((l) => /[⚠❌]|异常|错误|过期|失败|error|warn/i.test(l))
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 20)
        .join('\n')
      if (notable) logs.push(notable)
    }

    logs.push('', '## 体检结论')
    logs.push(await scanPortfolioAnomalies(assetLens))
    return logs.join('\n')
  },

  // ===================== csv-analyze =====================
  // langgraph-csv-analyst 多智能体分析 → HTML 报告。
  // sidecar 无 web 预览服务器、也无 workspace 复制机制：跳过参考的
  // ensurePreviewServer 与 copyFile 两步，直接返回报告绝对路径。
  'csv-analyze': async function csvAnalyze(a) {
    const dir = process.env.LANGGRAPH_CSV_ANALYST_DIR || ''
    const sampleCsv = dir ? path.join(dir, 'data/sample_sales.csv') : null
    const file = String((a && a.file) || '').trim() || sampleCsv
    if (!file) {
      return 'error: csv-analyze 需要 file 参数，或设置 LANGGRAPH_CSV_ANALYST_DIR 以使用内置样例 data/sample_sales.csv。'
    }
    const usingSample = file === sampleCsv
    const profile = !!(a && a.profile)
    const output = String((a && a.output) || '').trim()

    const logs = [
      `分析目录：${dir || '(未设置 LANGGRAPH_CSV_ANALYST_DIR)'}`,
      `输入：${file}`,
      usingSample ? '> 未指定 CSV，使用内置样例 data/sample_sales.csv。' : '',
      '',
    ]
    const cmdArgs = profile
      ? ['uv', 'run', 'python', '-m', 'langgraph_csv_analyst.cli', 'profile', file]
      : [
          'uv', 'run', 'python', '-m', 'langgraph_csv_analyst.cli', 'analyze', file,
          ...(output ? ['--output', output] : []),
        ]

    const r = await H.spawnCapture({
      tool: 'csv-analyze',
      cwd: dir || undefined,
      cmdArgs,
      timeoutMs: 300_000,
      maxOutput: 16 << 20,
      env: dir ? H.uvEnvFor(dir) : process.env,
    })
    if (!r.ok) {
      return `error: csv-analyze 失败 — ${H.truncate(r.error || '', 800)}`
    }
    const combined = `${r.stdout}\n${r.stderr}`
    const notable = combined
      .split('\n')
      .filter((l) => /[⚠❌]|报告|report|written|保存|error|warn|异常|已输出/i.test(l))
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 30)
      .join('\n')
    if (notable) logs.push(notable)

    const reportDefault = output
      || path.join(path.dirname(file), `${path.basename(file).replace(/\.csv$/i, '')}_report.html`)
    // 部分失败检测：流水线降级（子智能体 503）但报告可能仍落地。
    const partial = /\berrors?\b/i.test(combined) || /503|timeout|timed out|unavailable/i.test(combined)
    if (partial) {
      let landed = false
      try { await fsp.access(reportDefault); landed = true } catch { /* missing */ }
      if (!landed) {
        return `error: csv-analyze 报告未生成 — ${H.truncate(combined.slice(-600), 600)}`
      }
      logs.push(
        '',
        '⚠️ 分析部分失败：趋势/异常检测子智能体报错（如 503），报告缺少趋势(Trend)与异常(Anomaly)两个完整模块，' +
          '不可当作完整结果。应重试（可稍等后再次调用 csv-analyze 以获得完整趋势与异常分析），不要据此判定任务完成。',
      )
    }
    logs.push('', `> 分析报告已生成 → ${reportDefault}`)
    logs.push(
      usingSample
        ? '> 这是内置样例的分析结果；需要分析你自己的数据请再次调用并传 file 参数。'
        : '> 提示：报告为 HTML，可在浏览器打开；需要落库请让用户指定 output 路径。',
    )
    return logs.join('\n')
  },

  // ===================== product-analyze =====================
  // crewai-product-analyst 三智能体产品分析 → Markdown 报告。
  'product-analyze': async function productAnalyze(a) {
    const product = String((a && a.product) || '').trim()
    if (!product) return 'error: product-analyze 需要 product 参数（产品名）。'

    let dir
    try {
      dir = productAnalystDir()
    } catch (e) {
      return `error: product-analyze — ${e.message}`
    }

    const outputArg = String((a && a.output) || '').trim()
    // sidecar 无 resolve-studio 根目录概念，缺省报告落到 PROJECT/sandbox/ 下。
    const outputAbs = outputArg
      ? path.resolve(outputArg)
      : path.join(dir, 'sandbox', `${slugifyProduct(product)}-product-analysis.md`)
    try {
      await fsp.mkdir(path.dirname(outputAbs), { recursive: true })
    } catch { /* best effort */ }

    const logs = [`分析目录：${dir}`, `产品：${product}`, '']
    const cmdArgs = [
      'uv', 'run', 'python', '-m', 'crewai_product_analyst.main',
      'analyze', product, '--output', outputAbs,
    ]
    const r = await H.spawnCapture({
      tool: 'product-analyze',
      cwd: dir,
      cmdArgs,
      timeoutMs: 1_200_000,
      maxOutput: 16 << 20,
      env: H.uvEnvFor(dir),
    })
    if (!r.ok) {
      // H.spawnCapture 不回传退出信号名；被 timeout SIGTERM→SIGKILL 干掉的进程
      // close code 为 null → error 串里拼成 "code undefined"。据此识别超时。
      const timedOut = /exited with code (undefined|null)/.test(r.error || '')
      const detail = H.stripAnsi(r.error || '').trim()
      return 'error: product-analyze 失败 — ' +
        (timedOut
          ? '分析超出 20 分钟仍未完成（已中止）。可重试，或让 agent 指定更聚焦的产品名。'
          : H.truncate(detail || '未知错误（无输出）', 800))
    }
    const notable = `${r.stdout}\n${r.stderr}`
      .split('\n')
      .map(H.stripAnsi)
      .filter((l) => /[⚠❌]|报告|report|written|保存|已输出|save|saved/i.test(l))
      .filter((l) => !/^[│╭╮┆]*$|cdn-cgi|cf-input|data-next-head|font-|\{display:|css/i.test(l))
      .map((l) => l.trim().replace(/^[│┆]+\s*/, ''))
      .filter(Boolean)
      .slice(0, 40)
      .join('\n')
    if (notable) logs.push(notable)
    logs.push('', `> 分析报告已保存 → ${outputAbs}`)
    return logs.join('\n')
  },

  // ===================== photo-duplicates =====================
  'photo-duplicates': async function photoDuplicates(a) {
    const base = process.env.PHOTO_LIBRARY_URL || 'http://127.0.0.1:3100'
    const key = process.env.PHOTO_LIBRARY_KEY || ''
    const dir = process.env.PHOTO_LIBRARY_DIR || ''
    const headers = key ? { 'x-api-key': key } : undefined
    const probe = await H.httpGetJson(`${base}/health`, { headers })
    if (!probe.ok) {
      return (
        `error: photo-library 服务未运行（${base}/health 不可达）。\n` +
        `启动：cd ${dir || '<photo-library 根目录 (设置 PHOTO_LIBRARY_DIR)>'} && make run（需先 cp .env.example .env）`
      )
    }
    const out = []
    if (!a || a.stats !== false) {
      const s = await H.httpGetJson(`${base}/api/stats`, { headers })
      const st = (s.ok && s.data) || {}
      out.push(
        `📊 照片库统计：${st.unique_images ?? st.total_images ?? '?'} 张（去重后）` +
          ` / 重复 ${st.duplicate_groups ?? '?'} 组（${st.duplicate_images ?? '?'} 张）` +
          ` / 相似 ${st.similar_groups ?? '?'} 组（${st.similar_images ?? '?'} 张）`,
        '',
      )
    }
    const d = await H.httpGetJson(`${base}/api/duplicates`, { headers })
    const dupGroups = (d.ok && Array.isArray(d.data && d.data.items)) ? d.data.items : []
    if (!dupGroups.length) {
      out.push('✅ 无重复照片（content 哈希去重）')
    } else {
      out.push(`重复照片 ${dupGroups.length} 组：`)
      for (const g of dupGroups.slice(0, 15)) {
        const items = Array.isArray(g.items) ? g.items : []
        out.push(`- ${g.content_hash || ''} (${g.count != null ? g.count : items.length} 张)`)
        for (const f of items.slice(0, 3)) {
          out.push(`  - ${f.relative_path || f.name || String(f)}`)
        }
      }
    }
    if (a && a.similar) {
      const si = await H.httpGetJson(`${base}/api/similar`, { headers })
      const sg = (si.ok && Array.isArray(si.data && si.data.items)) ? si.data.items : []
      out.push('', `相似照片（感知哈希）${sg.length} 组`)
    }
    return out.join('\n')
  },

  // ===================== video-library-list =====================
  'video-library-list': async function videoLibraryList(a) {
    const base = process.env.VIDEO_LIBRARY_URL || 'http://127.0.0.1:3200'
    const key = process.env.VIDEO_LIBRARY_KEY || ''
    const dir = process.env.VIDEO_LIBRARY_DIR || ''
    const headers = key ? { 'x-api-key': key } : undefined
    const probe = await H.httpGetJson(`${base}/health`, { headers })
    if (!probe.ok) {
      return (
        `error: video-library 服务未运行（${base}/health 不可达）。\n` +
        `启动：cd ${dir || '<video-library 根目录 (设置 VIDEO_LIBRARY_DIR)>'} && make run（需先 cp .env.example .env）`
      )
    }
    const limit = typeof (a && a.limit) === 'number' ? a.limit : 30
    const res = await H.httpGetJson(`${base}/api/videos?limit=${limit}`, { headers })
    const videos = (res.ok && res.data && res.data.items) || (res.ok && res.data) || []
    const out = [
      `视频库共 ${videos.length} 条（展示前 ${Math.min(limit, videos.length)} 条）：`,
      '',
    ]
    for (const v of videos.slice(0, limit)) {
      const name = v.name || v.title || v.path || '?'
      const dur = v.duration_ms != null
        ? Math.round(Number(v.duration_ms) / 1000)
        : (v.duration_sec ?? v.duration ?? '')
      const codec = v.video_codec || v.codec || ''
      const reso = v.resolution || (v.width && v.height ? `${v.width}x${v.height}` : '')
      out.push(
        `- **${name}**${dur ? ` ⏱${dur}s` : ''}${codec ? ` [${codec}]` : ''}${reso ? ` ${reso}` : ''}`,
      )
    }
    if (!videos.length) out.push('（库为空，先扫描再查询）')
    return out.join('\n')
  },

  // ===================== dev-stats =====================
  'dev-stats': async function devStats(a) {
    const dir = process.env.DEV_STATS_DIR
    if (!dir) {
      return 'error: DEV_STATS_DIR is not set. Export it to the absolute path of the dev-stats project root (e.g. in .env).'
    }
    const target = String((a && a.target) || '').trim() || 'report'
    if (!DEV_STATS_TARGETS.includes(target)) {
      return `error: 未知目标 "${target}"，可用目标：${DEV_STATS_TARGETS.join(' / ')}。`
    }
    let rawArgs = String((a && a.args) || '').trim()
    // 容器无 gh 登录态时显式 --user；内容平台子命令语义不同不加。
    // 隐私：DEV_STATS_USER 未配置时不注入 --user（GitHub API 匿名访问公开仓库
    // 仍可用，仅限流更低），绝不硬编码任何真实用户名。
    const needsIdentity =
      target !== 'juejin' &&
      target !== 'segmentfault' &&
      target !== 'report' &&
      !/\b--user\b|\b--token\b/.test(rawArgs) &&
      !process.env.GITHUB_TOKEN &&
      !process.env.GH_TOKEN
    if (needsIdentity) {
      const devUser = process.env.DEV_STATS_USER
      if (devUser) rawArgs = `${rawArgs} --user ${devUser}`.trim()
    }
    // `ARGS` is expanded by /bin/sh inside the dev-stats Makefile recipe.
    // Give the model an actionable, readable rejection instead of letting it
    // retry blindly after a generic make failure (runMakeIn also enforces this
    // for every caller; this check just produces a better explanation).
    if (!isSafeMakeVarValue(rawArgs)) {
      return `error: dev-stats 的 args 含不允许的字符（shell 元字符）。只接受普通 CLI 参数，例如 "--sort daily --limit 10"；分号、反引号、$( )、管道、重定向、引号、换行一律拒绝。收到 ${rawArgs.length} 个字符（不回显原文，避免注入文本进入会话上下文）。`
    }
    const makeArgs = [target]
    if (rawArgs) makeArgs.push(`ARGS=${rawArgs}`)

    // 剥离 TTY 痕迹，避免 Rich spinner 每帧打一行刷屏。
    const env = { ...H.uvEnvFor(dir), NO_COLOR: '1', TERM: 'dumb' }
    delete env.FORCE_COLOR
    delete env.CLICOLOR_FORCE

    const r = await H.runMakeIn(dir, makeArgs, {
      timeoutMs: 600_000,
      maxOutput: 16 << 20,
      env,
    })
    if (!r.ok) {
      return `error: dev-stats make ${target} 失败 — ${H.truncate(String(r.error || ''), 800)}`
    }
    const out = cleanDevStatsOutput(`${r.stdout}\n${r.stderr}`)
    const head = [`dev-stats make ${target}${rawArgs ? ` ARGS=${rawArgs}` : ''}：`]
    const tail = []
    if (out.includes('已导出 CSV') || out.includes('已生成 CSV 预览')) {
      tail.push(`输出目录：${dir}`)
    }
    const previewRel = (/已生成 CSV 预览：(\S+)/.exec(out) || [])[1]
    if (previewRel) {
      tail.push(`预览文件：${path.join(dir, previewRel.replace(/^\.\//, ''))}`)
      const baseUrl = process.env.DEV_STATS_PREVIEW_BASE_URL || 'http://127.0.0.1:18085'
      tail.push(`预览链接：${baseUrl}/api/raw/${String(previewRel).split('/').pop()}`)
    }
    // 流量统计：先把「权威清单」放最前面，模型只需照抄；原始日志压到末尾并大幅截断，
    // 否则 6 万字符的表格会让模型把仓库名现编出来（数字对、名字全是拼凑的）。
    if (target === 'csv' || target === 'csv-traffic') {
      const rows = parseStatsCsv(path.join(dir, 'output', 'stats.csv'))
      const digest = buildTrafficDigest(rows)
      if (digest) {
        head.push('', digest)
        head.push('', '⚠ 上面清单里的名字是唯一定义源；本回复只需照抄，不要改写或补充。')
        tail.push('', '【原始日志（已截断，仅供核对，不要从这里摘仓库名）】', H.truncateToTail(out || '（无输出）', 4000))
      } else {
        head.push('', out || '（无输出）')
      }
    } else {
      head.push('', out || '（无输出）')
    }
    return H.truncateToTail([...head, '', ...tail].join('\n'), 48 * 1024)
  },
}

function assertHttpUrl(raw) {
  const url = String(raw || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are supported')
  return url
}

// ---- minimal zero-dependency CDP driver ----
// Connects to a shared Chrome via the DevTools HTTP+WS endpoints (browser-desk
// style: <host>:9222). Uses only Node 24 built-ins (global fetch + WebSocket).
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const CDP_CONNECT_RETRIES = 5
const CDP_CONNECT_RETRY_DELAY_MS = 1000

async function getCdp() {
  // Probe the DevTools HTTP endpoint (with retries — browser-desk needs a few
  // seconds to boot Xvfb→VNC→Chrome). A clean failure becomes a "start
  // browser-desk" hint instead of a confusing WebSocket error.
  let lastErr = null
  for (let i = 0; i < CDP_CONNECT_RETRIES; i++) {
    try {
      const probe = await fetch(`${CDP_URL}/json/version`, {
        signal: AbortSignal.timeout(2000),
      })
      if (probe.ok) return new CdpClient()
      lastErr = new Error(`CDP HTTP endpoint returned ${probe.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, CDP_CONNECT_RETRY_DELAY_MS))
  }
  throw new Error(
    `无法连接共享浏览器 browser-desk（${CDP_URL}）：请确认 browser-desk 容器已启动并暴露 CDP 端口` +
      (lastErr && lastErr.message ? `（${lastErr.message}）` : ''),
  )
}

class CdpClient {

  async open(url) {
    const res = await fetch(`${CDP_URL}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`CDP /json/new failed: ${res.status}`)
    const target = await res.json()
    if (!target.webSocketDebuggerUrl) throw new Error('CDP target has no webSocketDebuggerUrl')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolvePromise, reject) => {
      ws.onopen = resolvePromise
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message || 'connect failed'}`))
    })
    let seq = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolvePromise, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`))
        else resolvePromise(msg.result || {})
      }
    }
    const send = (method, params) =>
      new Promise((resolvePromise, reject) => {
        const id = ++seq
        pending.set(id, { resolvePromise, reject })
        ws.send(JSON.stringify({ id, method, params: params || {} }))
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`CDP ${method} timed out`))
          }
        }, 15_000)
      })
    return { ws, send, targetId: target.id }
  }

  async evaluate(target, expression) {
    const r = await target.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error('page evaluate failed')
    return r.result && r.result.value
  }

  async waitReady(target, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const state = await target.send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        if (state.result && state.result.value === 'complete') return
      } catch {
        // page context not ready yet — keep polling
      }
      if (Date.now() > deadline) return // best effort
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  async screenshot(target) {
    const r = await target.send('Page.captureScreenshot', { format: 'png' })
    return r.data || ''
  }

  close(target) {
    try {
      target.ws.close()
    } catch { /* ignore */ }
    try {
      fetch(`${CDP_URL}/json/close/${target.targetId}`, { method: 'GET' }).catch(() => {})
    } catch { /* ignore */ }
  }
}

// ===================== analyze-code-dir helpers =====================
// 以下集合照参考 tool-analyze-code-dir.ts 原样移植。
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php', '.swift',
  '.scala', '.vue', '.svelte', '.cs', '.sh',
])
const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', '.venv',
  'venv', '__pycache__', 'target', '.idea', '.vscode', 'coverage', '.turbo', 'out',
  '.pse_tmp', '.ruff_cache', '.mypy_cache', '.pytest_cache', '.eggs', '.gradle',
  'bin', 'obj',
])
const ANALYZE_DIR_BUDGET = 36 * 1024 // hard cap on the serialized report (bytes)

/** BFS-collect up to `limit` source-file absolute paths, top-level first. */
async function collectSourceFiles(absDir, limit, depth) {
  const out = []
  let queue = [absDir]
  let level = 0
  while (queue.length && out.length < limit && level <= depth) {
    const next = []
    for (const dir of queue) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name))
      for (const e of sorted) {
        if (out.length >= limit) break
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!DEFAULT_IGNORE.has(e.name)) next.push(p)
        } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name).toLowerCase())) {
          out.push(p)
        }
      }
    }
    queue = next
    level++
  }
  return out
}

// ===================== portfolio-check helpers =====================
const ANNUAL_RETURN_CAP = 10000 // 年化收益率超过此绝对值视为失真（短周期暴利被年化）

async function scanPortfolioAnomalies(assetLensDir) {
  const outDir = path.join(assetLensDir, 'output')
  let files
  try {
    files = (await fsp.readdir(outDir))
      .filter((f) => f.startsWith('投资收益率分析_') && f.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return '⚠️ 未找到 analysis-lens 生成的快照 JSON（output/投资收益率分析_*.json），请确认 make analyze 已成功执行。'
  }
  if (!files.length) {
    return '⚠️ 未找到 analysis-lens 生成的快照 JSON（output/投资收益率分析_*.json）。'
  }
  const latest = path.join(outDir, files[0])
  let data
  try {
    data = JSON.parse(await fsp.readFile(latest, 'utf8'))
  } catch {
    return `⚠️ 无法解析快照文件：${latest}`
  }
  const lines = [`快照文件：${files[0]}（生成于 ${data.generated_at || '未知'}）`, '']
  const ev = data.comprehensive_evaluation || {}
  const w = parseFloat(String(ev.weighted_annual_return ?? '').replace('%', ''))
  if (!Number.isNaN(w) && Math.abs(w) > ANNUAL_RETURN_CAP) {
    lines.push(
      `- ⚠️ 加权年化收益率异常：${ev.weighted_annual_return}（合理上限约 ${ANNUAL_RETURN_CAP}%，疑似短周期暴利被年化，已失真）`,
    )
  } else {
    lines.push(`- 加权年化收益率：${ev.weighted_annual_return ?? 'N/A'}`)
  }
  lines.push(`- 整体收益率：${ev.overall_return_rate ?? 'N/A'}`)
  lines.push(`- 当前总资产：${ev.total_current_amount ?? 'N/A'}`)
  const prods = Array.isArray(data.products) ? data.products : []
  const outliers = prods
    .map((p) => ({
      name: p['名称'] || p.name || '?',
      ar: parseFloat(String(p['年化收益率(%)'] ?? p.annual_return ?? '').replace('%', '')),
    }))
    .filter((p) => !Number.isNaN(p.ar) && Math.abs(p.ar) > ANNUAL_RETURN_CAP)
  if (outliers.length) {
    lines.push(`- ⚠️ ${outliers.length} 只产品年化收益率异常（> ${ANNUAL_RETURN_CAP}%）：`)
    for (const o of outliers.slice(0, 10)) lines.push(`  - ${o.name}：${o.ar}%`)
  }
  const warns = data.risk_warnings
  if (Array.isArray(warns) && warns.length) {
    lines.push(`- 内置风险提示 ${warns.length} 条（详见快照 JSON 的 risk_warnings）`)
  }
  if (lines.length <= 3) lines.push('- ✅ 未发现明显数值异常')
  return lines.join('\n')
}

// ===================== product-analyze helpers =====================
function productAnalystDir() {
  const dir = process.env.PRODUCT_ANALYST_DIR
  if (!dir) {
    throw new Error(
      'PRODUCT_ANALYST_DIR is not set. Export it to the absolute path of the crewai-product-analyst project root (e.g. in .env).',
    )
  }
  return dir
}

/** Lowercase, slugify a product name into a safe filename segment. */
function slugifyProduct(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'report'
  )
}

// ===================== dev-stats helpers =====================
const DEV_STATS_TARGETS = [
  'report', 'juejin', 'segmentfault', 'ci', 'actions', 'csv', 'csv-traffic', 'run',
]
// Avoid control characters in the regex literal (no-control-regex lint rule).
const DEV_STATS_ESC = String.fromCharCode(27)
const DEV_STATS_ANSI_RE = new RegExp(`${DEV_STATS_ESC}\\[[0-9;?]*[A-Za-z]`, 'g')
// Rich's status spinner frames start with a braille glyph.
// Rich 的 spinner 帧以盲文图案字符开头（U+2800–U+28FF）；管道输出时每帧重复一行。
const DEV_STATS_SPINNER_RE = /^[\u2800-\u28ff]/

/** Strip ANSI escapes, drop spinner frames, collapse consecutive duplicates. */
function cleanDevStatsOutput(raw) {
  const lines = String(raw).replace(DEV_STATS_ANSI_RE, '').split('\n')
  const kept = []
  for (const line of lines) {
    if (DEV_STATS_SPINNER_RE.test(line)) continue
    if (line.trim() && kept.length > 0 && kept[kept.length - 1] === line) continue
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Parse manifest-level stats.csv (name + traffic columns) without a dep. */
function parseStatsCsv(csvPath) {
  let raw
  try {
    raw = fs.readFileSync(csvPath, 'utf8')
  } catch {
    return []
  }
  const rows = []
  let fields = []
  let cur = []
  let inQ = false
  let field = ''
  const flushField = () => {
    cur.push(field)
    field = ''
  }
  const flushRow = () => {
    if (cur.length === 0) return
    if (!fields.length) fields = cur
    else rows.push(cur)
    cur = []
  }
  for (const ch of raw) {
    if (inQ) {
      if (ch === '"') inQ = false
      else field += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      flushField()
    } else if (ch === '\n' || ch === '\r') {
      flushField()
      flushRow()
    } else {
      field += ch
    }
  }
  flushField()
  flushRow()
  return rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i] || ''])))
}
