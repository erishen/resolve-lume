'use strict'
// Batch: PSE pipelines (autogen-pse portfolio review).
// Pattern seeds: pse-review / pse-review-latest — the canonical runPseTask flow.
// Remaining tools of this family live here too: article-write, resume-tailor,
// interview-questions, crm-task, hot-news, hot-news-fetch, hot-news-topics,
// hot-news-check, hot-news-publish.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const H = require('./business-helpers')

// ---- pse-review: full autogen-pse weekly review ----
// 1) prepare.py regenerates output/portfolio_review_prompt.md (≤180s);
// 2) run.py runs the Planner/Specialist/Evaluator team + KB retrieval (≤1800s;
//    slow free-gateway runs have exceeded 15 min, so a generous timeout only
//    costs waiting time while a mid-run kill wastes the whole round);
// 3) parse the "Review 已保存 → <path>" marker and return the full report.
const PREPARE_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 1_800_000
const RUN_MAX_OUTPUT = 4 << 20 // match execFile maxBuffer so the marker survives
const REVIEW_SAVED_RE = /Review 已保存 →\s*(\S+)/

function buildRunEnv(provider) {
  const env = { ...process.env }
  if (provider === 'deepseek') {
    // Route through the llm-router gateway (same base_url/key as free branch)
    // and force the deepseek-v4-flash exact route. Non-streaming only: tsm-hub
    // does not pass Accept-Encoding through, so zstd SSE corrupts on read.
    env.OPENAI_MODEL = 'deepseek-v4-flash'
    env.PSE_MODEL_STREAM = 'false'
  } else {
    // free: inherit harness OPENAI_* (gateway) creds; pin non-streaming and
    // disable KB injection (free gateway context is small — avoids 413 on the
    // opening request; autogen-pse's 413 self-healing covers the Evaluator).
    env.PSE_MODEL_STREAM = 'false'
    env.PSE_INJECT_KB = '0'
  }
  return env
}

// ---- article-write (crewai-pse project-articles) child env ----
// Fork the env and strip the OPENAI_* trio: free branch re-pins to the harness's
// OpenAI-compatible gateway creds (or empty defaults); deepseek branch leaves
// them stripped so crewai-pse/.env's own deepseek creds take over via cwd
// load_dotenv. (Distinct from buildRunEnv above, which targets autogen-pse.)
const ARTICLE_STYLE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F']
const ARTICLE_PROVIDER_NAMES = ['free', 'deepseek']
function buildArticleRunEnv(provider) {
  const env = { ...process.env }
  delete env.OPENAI_MODEL
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_API_KEY
  if (provider !== 'deepseek') {
    // 只透传宿主「显式且非空」的凭据，绝不塞空串。crewai-pse 的 bootstrap
    // 用 load_dotenv(..., override=False)：环境变量里存在空字符串也算「已有」，
    // 会把 crewai-pse/.env 里真正的 OPENAI_API_KEY / OPENAI_BASE_URL 挡在外面，
    // 三角色流水线一启动就 401。宿主 sidecar 的 envloader 白名单并不含
    // OPENAI_*，所以正常情况下这里全部不设，由框架自己的 .env 接管。
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']) {
      if (process.env[k]) env[k] = process.env[k]
    }
  }
  return env
}

// ---- crm-task (langgraph-pse) task registry ----
const CRM_TASKS = {
  'crm-qa': { outputRel: 'crm-qa/qa_report.md', label: 'CRM 数据质量报告' },
  'follow-up-draft': { outputRel: 'follow-up-draft/follow_up_drafts.md', label: '跟进消息草稿' },
  'weekly-review': { outputRel: 'weekly-review/weekly_review.md', label: '每周关系复盘' },
}

// ---- hot-news shared constants (llamaindex-pse) ----
const HOT_NEWS_SOURCES = ['weibo', 'kr36', 'sspai', 'qbitai', 'infoq']
const HOT_NEWS_PLATFORMS = ['xiaohongshu', 'zhihu', 'toutiao']

module.exports = {
  'pse-review': async function pseReview(args) {
    let autogenPse
    try {
      autogenPse = H.resolvePseDir('autogen')
    } catch (e) {
      return `error: pse-review — ${e.message}`
    }
    const provider = (args && args.provider) || H.getPseProvider()
    const runEnv = buildRunEnv(provider)
    const prep = await H.runPseTask({
      tool: 'pse-review',
      framework: 'autogen',
      task: 'portfolio-review',
      runFile: path.join('tasks', 'portfolio-review', 'prepare.py'),
      taskDir: autogenPse,
      args: [],
      env: runEnv,
      timeoutMs: PREPARE_TIMEOUT_MS,
    })
    if (!prep.ok) {
      return `error: pse-review prepare step failed — ${prep.error.replace(/^error:\s*/, '')}`
    }
    const run = await H.runPseTask({
      tool: 'pse-review',
      framework: 'autogen',
      task: 'portfolio-review',
      runFile: path.join('tasks', 'portfolio-review', 'run.py'),
      taskDir: autogenPse,
      args: [],
      env: runEnv,
      timeoutMs: RUN_TIMEOUT_MS,
      maxOutput: RUN_MAX_OUTPUT,
    })
    if (!run.ok) {
      return `error: pse-review run step failed — ${run.error.replace(/^error:\s*/, '')}`
    }
    const m = REVIEW_SAVED_RE.exec(run.stdout)
    if (m && m[1]) {
      try {
        const review = await fsp.readFile(m[1], { encoding: 'utf8' })
        const absOrig = path.isAbsolute(m[1]) ? m[1] : path.resolve(m[1])
        const note =
          `> PSE review 已保存：${absOrig}\n` +
          `> 后续追问：用户就本报告追问细节时，若上下文已无报告全文，` +
          `先用 read-file 读取上面的路径取回全文再回答，禁止凭记忆编造数字。\n\n`
        return H.truncate(note + review, H.MAX_OUTPUT)
      } catch {
        // fall through to stdout
      }
    }
    return H.truncate(run.stdout || '(no output)', H.MAX_OUTPUT)
  },

  'pse-review-latest': async function pseReviewLatest() {
    let autogenPse
    try {
      autogenPse = H.resolvePseDir('autogen')
    } catch (e) {
      return `error: pse-review-latest — ${e.message}`
    }
    // Scan <autogen-pse>/tasks/portfolio-review/output/<model>/weekly_review_*.md
    // and return the newest artifact (run.py writes reports per model dir).
    const outRoot = path.join(autogenPse, 'tasks', 'portfolio-review', 'output')
    let best = null
    try {
      for (const model of await fsp.readdir(outRoot)) {
        const dir = path.join(outRoot, model)
        const dirStat = await fsp.stat(dir).catch(() => null)
        if (!dirStat || !dirStat.isDirectory()) continue
        for (const f of await fsp.readdir(dir)) {
          if (!/^weekly_review_.*\.md$/.test(f)) continue
          const p = path.join(dir, f)
          const fst = await fsp.stat(p).catch(() => null)
          if (fst && (!best || fst.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: fst.mtimeMs }
        }
      }
    } catch {
      // fallthrough — best stays null
    }
    if (!best) {
      return (
        'error: 尚无任何 pse-review 产物（tasks/portfolio-review/output/ 下没有 weekly_review_*.md）。' +
        '请先运行 pse-review 生成周报。'
      )
    }
    const content = await fsp.readFile(best.path, { encoding: 'utf8' })
    return H.truncate(`> 最近周报：${best.path}\n\n${content}`, H.MAX_OUTPUT)
  },

  // ---- article-write: crewai-pse three-agent article pipeline ----
  // No `project` → live candidate list from tasks/project-articles/projects.json
  // (read on every call, never cached — article-discover appends at runtime).
  // With `project` → run run.py at the crewai-pse root; parse the
  // "中文已保存 → <path>" / "英文已保存 → <path>" markers and return the full
  // Chinese article (bounded). Long pipeline: 30 min timeout.
  'article-write': async function articleWrite(args) {
    args = args || {}
    const { project, publish = false, style, provider = H.getPseProvider() } = args
    // 旧实现只判断 `provider !== 'deepseek'`，任何非法值都静默当 free 跑，
    // 模型传了 "medium" 也毫无反馈。与 style 一样改为明确拒绝。
    const prov = String(provider).toLowerCase()
    if (!ARTICLE_PROVIDER_NAMES.includes(prov)) {
      return `error: article-write 不支持 provider="${provider}"；可选 ` +
        `${ARTICLE_PROVIDER_NAMES.join(' / ')}（省略则沿用宿主默认）。`
    }

    let CREWAI_PSE
    try {
      CREWAI_PSE = H.resolvePseDir('crewai')
    } catch (e) {
      return `error: ${e.message}`
    }

    let projectKeys = []
    try {
      const raw = fs.readFileSync(
        path.join(CREWAI_PSE, 'tasks', 'project-articles', 'projects.json'),
        'utf8',
      )
      projectKeys = Object.keys(JSON.parse(raw)).sort()
    } catch {
      projectKeys = []
    }

    if (!project) {
      if (projectKeys.length === 0) {
        return 'error: no projects configured in crewai-pse projects.json.'
      }
      return (
        'project 参数必填。可用项目见本工具的 project 枚举（crewai-pse projects.json 的 key）：\n' +
        projectKeys.map((k, i) => `${i + 1}. ${k}`).join('\n') +
        '\n\n请先让用户从中选一个，再带 project=<项目名> 调用本工具；不要反复不带 project 调用。'
      )
    }
    if (projectKeys.length > 0 && !projectKeys.includes(project)) {
      return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
    }

    const runArgs = [project]
    if (publish) runArgs.push('--publish')
    if (style) {
      const s = String(style).trim().toUpperCase()
      // 旧实现把不认识的值静默丢掉 → 调用方以为指定了风格，实际回落到
      // pick_style 的自动轮转（A–F）。现在明确报错。
      // 提示里不要出现「骨架流」等归因词：模型上次把相关性不足误读成
      // 「走了骨架流」，进而建议用户改用 style=B/D 无意义重试。
      if (!ARTICLE_STYLE_NAMES.includes(s)) {
        return `error: article-write 不支持 style="${style}"；可选 ${ARTICLE_STYLE_NAMES.join('/')}。` +
          ' 不要传中文风格名；省略该参数则由框架自动选择。'
      }
      runArgs.push(`--style=${s}`)
    }

    const res = await H.runPseTask({
      tool: 'article-write',
      framework: 'crewai',
      task: 'project-articles',
      runFile: path.join('tasks', 'project-articles', 'run.py'),
      taskDir: CREWAI_PSE,
      args: runArgs,
      env: buildArticleRunEnv(prov),
      timeoutMs: 1_800_000,
    })
    if (!res.ok) return res.error

    const { stdout, stderr } = res
    const outcome = H.articleRunOutcome(stdout, stderr)
    if (!outcome.ok) {
      // run.py 隔离坏稿时 exit code 依旧是 0。绝不能走到下面的 "generated"
      // 分支，否则模型会向用户谎报「文章已成功生成」（11-06 实测）。
      const why = outcome.quarantined
        ? '质量闸门未通过，稿件已隔离到 needs-review/，未翻译、未发布'
        : '流水线未产出中文成品（缺少「中文已保存」marker）'
      return H.truncate([
        `error: article-write 未生成可发布文章（项目 ${project}）：${why}。`,
        outcome.reason ? `> 隔离原因：${outcome.reason}` : '',
        '> 请勿用相同参数立刻重试，也不要只靠换 style 重试：' +
        '先看 needs-review/*.reason.txt 的隔离原因，确认是稿件内容问题还是闸门判定问题。' +
        ' 把本条错误与隔离原因如实转达用户，不要说「已成功生成」，' +
        '也不要自行给出「改用某风格即可解决」的结论：' +
        '隔离原因以 reason.txt 为准，换风格既不修复内容缺陷也不修复闸门判定。',
        '', '--- stdout tail ---', outcome.stdoutTail,
        outcome.stderrTail.trim() ? `\n--- stderr tail ---\n${outcome.stderrTail}` : '',
      ].filter(Boolean).join('\n'), H.MAX_OUTPUT)
    }

    const zhPath = outcome.zhPath
    const enPath = outcome.enPath
    const parts = [`> crewai-pse article generated for project: **${project}**`]
    if (zhPath) parts.push(`> Chinese: ${zhPath}`)
    if (enPath) parts.push(`> English: ${enPath}`)
    if (publish) parts.push('> Auto-published to WordPress.')

    // 落盘后清洗 frontmatter：上游免费模型会把 tool-call 控制 token 吐进
    // title（实测 lume-a2a 中英两篇都是 `<｜｜DSML｜｜ calls>`）。只改 title
    // 行，正文原样保留；清洗失败不阻断交付。
    const fixes = []
    for (const [p, fb] of [
      [zhPath, `${project} 技术实践解析`],
      [enPath, `${project}: A Technical Deep Dive`],
    ]) {
      if (!p) continue
      try {
        const raw = await fsp.readFile(p, 'utf8')
        const s = H.sanitizeArticleFrontmatter(raw, fb)
        if (s.fixes.length) {
          await fsp.writeFile(p, s.text, 'utf8')
          fixes.push(`${path.basename(p)}: ${s.fixes.join('; ')}`)
        }
      } catch { /* keep the original article; sanitizing is best-effort */ }
    }
    if (fixes.length) {
      parts.push(`> ⚠️ 已自动清洗 frontmatter（建议人工复核标题）：${fixes.join(' / ')}`)
    }

    if (zhPath) {
      try {
        const article = await fsp.readFile(zhPath, 'utf8')
        parts.push('', article)
      } catch {
        parts.push('', '(could not read article file; check the path above)')
      }
    } else {
      parts.push('', '--- stdout tail ---', stdout.slice(-3000))
      if (stderr && stderr.trim()) {
        parts.push('', '--- stderr tail ---', stderr.slice(-1000))
      }
    }
    return H.truncate(parts.join('\n'), H.MAX_OUTPUT)
  },

  // ---- resume-tailor: llamaindex-pse RAG + LLM resume pipeline ----
  // mode=customize (jd_text staged to a temp file) or recommend (--recommend).
  // Always --provider=<p>; noSync (deps preinstalled in the container venv).
  'resume-tailor': async function resumeTailor(args) {
    args = args || {}
    const { mode, jd_text, provider = H.getPseProvider() } = args

    if (mode === 'customize' && !(jd_text && jd_text.trim())) {
      return 'error: resume-tailor customize mode requires jd_text (Job Description content).'
    }

    const cmdArgs = [`--provider=${provider}`]
    if (mode === 'customize' && jd_text) {
      cmdArgs.push(`--jd=${await H.writeTempText('resume-jd-', 'jd.md', jd_text)}`)
    } else if (mode === 'recommend') {
      cmdArgs.push('--recommend')
    }

    const res = await H.runPseTask({
      tool: 'resume-tailor',
      framework: 'llamaindex',
      task: 'resume-tailor',
      args: cmdArgs,
      timeoutMs: 600_000,
      noSync: true,
    })
    if (!res.ok) return res.error

    const outFile = path.join(
      res.taskDir,
      mode === 'recommend'
        ? `recommended_resume_${provider}.md`
        : `tailored_resume_${provider}.md`,
    )
    let outputContent = ''
    try {
      outputContent = await fsp.readFile(outFile, 'utf8')
    } catch {
      // pipeline failed silently / artifact missing
    }

    const modeLabel = mode === 'recommend' ? '岗位推荐' : '简历定制'
    const result = [
      `> resume-tailor 完成（模式：${modeLabel}，模型：${provider}）`,
      `> 输出文件：${outFile}`,
      '',
    ]
    if (outputContent) {
      result.push('--- 生成内容预览（前 2000 字）---')
      result.push(outputContent.slice(0, 2000))
      if (outputContent.length > 2000) {
        result.push(`\n... (共 ${outputContent.length} 字，完整内容见输出文件)`)
      }
    } else {
      result.push('> 注意：未找到输出文件，可能是流水线未生成成品。')
      result.push(res.stdout.slice(-1000))
    }
    return result.join('\n')
  },

  // ---- interview-questions: langgraph-pse structured question set ----
  // mode subject / jd / resume; jd & resume text staged to temp files. Always
  // --llm --provider=<p>; count "### Qn" headings and report N/9.
  'interview-questions': async function interviewQuestions(args) {
    args = args || {}
    const { mode = 'subject', subject = 'python', jd_text, resume_text, provider = H.getPseProvider() } = args

    if (mode === 'jd' && !(jd_text && jd_text.trim())) {
      return 'error: interview-questions jd mode requires jd_text (Job Description content).'
    }
    if (mode === 'resume' && !(resume_text && resume_text.trim())) {
      return 'error: interview-questions resume mode requires resume_text.'
    }

    const cmdArgs = ['--llm', `--provider=${provider}`]
    if (mode === 'subject') {
      cmdArgs.push(`--subject=${subject}`)
    } else if (mode === 'jd' && jd_text) {
      cmdArgs.push(`--jd=${await H.writeTempText('interview-jd-', 'jd.md', jd_text)}`)
    } else if (mode === 'resume' && resume_text) {
      cmdArgs.push(`--resume=${await H.writeTempText('interview-resume-', 'resume.md', resume_text)}`)
    }

    const res = await H.runPseTask({
      tool: 'interview-questions',
      framework: 'langgraph',
      task: 'interview-questions',
      args: cmdArgs,
    })
    if (!res.ok) return res.error

    const { stdout, taskDir } = res
    let outFile = null
    if (mode === 'resume') {
      const m = /interview_questions_resume_(\w+)\.md/.exec(stdout)
      outFile = path.join(taskDir, `interview_questions_resume_${m ? m[1] : 'custom'}.md`)
    } else if (mode === 'jd') {
      const m = /interview_questions_jd_(\w+)\.md/.exec(stdout)
      outFile = path.join(taskDir, `interview_questions_jd_${m ? m[1] : 'custom'}.md`)
    } else {
      outFile = path.join(taskDir, `interview_questions_${subject}.md`)
    }

    let outputContent = ''
    try {
      outputContent = await fsp.readFile(outFile, 'utf8')
    } catch {
      outFile = null
    }

    const qCount = (outputContent.match(/^###\s*Q\d+/gm) || []).length
    const modeLabel =
      mode === 'subject' ? `按主题(${subject})` : mode === 'jd' ? '按JD' : '按简历'
    const result = [
      `> interview-questions 完成（模式：${modeLabel}，模型：${provider}）`,
      outFile ? `> 输出文件：${outFile}` : '> 注意：未找到输出文件',
      qCount > 0
        ? `> 题目数量：${qCount}/9${qCount < 9 ? ' ⚠️ 不完整，建议重试' : ''}`
        : '> ⚠️ 未检测到题目，生成可能失败',
      '',
    ]
    if (outputContent) {
      result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
      result.push(outputContent)
    } else {
      result.push('> 流水线输出：')
      result.push(stdout.slice(-1500))
    }
    return H.truncate(result.join('\n'), H.MAX_OUTPUT)
  },

  // ---- crm-task: one of three langgraph-pse personal-CRM pipelines ----
  'crm-task': async function crmTask(args) {
    args = args || {}
    const { task, provider = H.getPseProvider(), api_base_url, db_path } = args
    const cfg = CRM_TASKS[task]
    if (!cfg) {
      return `error: unknown crm-task "${task}". Available: ${Object.keys(CRM_TASKS).join(', ')}`
    }

    let tasksDir
    try {
      tasksDir = path.join(H.resolvePseDir('langgraph'), 'tasks')
    } catch (e) {
      return `error: crm-task — ${e.message}`
    }

    const cmdArgs = ['--llm', `--provider=${provider}`]
    if (task === 'crm-qa' && api_base_url) cmdArgs.push(`--api-base-url=${api_base_url}`)
    if ((task === 'follow-up-draft' || task === 'weekly-review') && db_path) {
      cmdArgs.push(`--db=${db_path}`)
    }

    const res = await H.runPseTask({
      tool: `crm-task ${task}`,
      framework: 'langgraph',
      task,
      args: cmdArgs,
    })
    if (!res.ok) return res.error

    const outFile = path.join(tasksDir, cfg.outputRel)
    let outputContent = ''
    try {
      outputContent = await fsp.readFile(outFile, 'utf8')
    } catch {
      // output file may not exist (CRM backend / db unreachable)
    }

    const result = [
      `> crm-task 完成（任务：${cfg.label}，模型：${provider}）`,
      `> 输出文件：${outFile}`,
      '',
    ]
    if (outputContent) {
      result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
      result.push(outputContent)
    } else {
      result.push('> 注意：未找到输出文件，可能是 CRM 后端/数据库不可用。')
      result.push(res.stdout.slice(-1500))
    }
    return H.truncate(result.join('\n'), H.MAX_OUTPUT)
  },

  // ---- hot-news: llamaindex-pse compliant social copy generation ----
  // topic required; news_dir anchored at the framework root, defaulting to the
  // fetch snapshot dir (only passed when it exists, else pure-topic degrade).
  // Output: newest hot_news_<platform>_<provider>*.md under articles/ or task root.
  'hot-news': async function hotNews(args) {
    args = args || {}
    const {
      topic,
      news_dir,
      platform = 'xiaohongshu',
      category = 'tech_ai',
      provider = H.getPseProvider(),
    } = args

    if (!(topic && topic.trim())) {
      return 'error: hot-news requires a non-empty topic.'
    }

    let hotNewsDir
    try {
      hotNewsDir = H.resolveTaskDir('llamaindex', 'hot-news')
    } catch (e) {
      return `error: hot-news — ${e.message}`
    }

    let newsDirFlag = ''
    if (news_dir && news_dir.trim()) {
      const abs = H.absolutizeTaskPath(news_dir.trim(), () => H.resolvePseDir('llamaindex'))
      newsDirFlag = `--news-dir=${abs}`
    } else {
      const def = path.join(hotNewsDir, 'news')
      try {
        await fsp.access(def)
        newsDirFlag = `--news-dir=${def}`
      } catch {
        newsDirFlag = ''
      }
    }

    const cmdArgs = [
      `--topic=${topic}`,
      `--platform=${platform}`,
      `--category=${category}`,
      `--provider=${provider}`,
    ]
    if (newsDirFlag) cmdArgs.push(newsDirFlag)

    const res = await H.runPseTask({
      tool: 'hot-news',
      framework: 'llamaindex',
      task: 'hot-news',
      args: cmdArgs,
      noSync: true,
      timeoutMs: 900_000,
    })
    if (!res.ok) return res.error

    const { stdout, taskDir } = res
    let outputContent = ''
    let outputPath = ''
    for (const dir of [path.join(taskDir, 'articles'), taskDir]) {
      try {
        const files = (await fsp.readdir(dir)).filter(
          (f) => f.startsWith(`hot_news_${platform}_${provider}`) && f.endsWith('.md'),
        )
        if (files.length) {
          const picked = files.sort().reverse()[0]
          outputPath = path.join(dir, picked)
          outputContent = await fsp.readFile(outputPath, 'utf8')
          break
        }
      } catch {
        // dir missing / unreadable → try the next candidate
      }
    }

    const result = [
      `> hot-news 完成（平台：${platform}，品类：${category}，模型：${provider}）`,
      newsDirFlag
        ? `> 新闻源：${newsDirFlag.replace('--news-dir=', '')}`
        : '> 注意：新闻快照目录不存在，纯主题降级生成（无事实对照）',
      outputPath ? `> 输出文件：${outputPath}` : '> 注意：未找到输出文件',
      '',
    ]
    if (outputContent) {
      result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
      result.push(outputContent)
    } else {
      result.push('> 流水线输出：')
      result.push(stdout.slice(-1500))
    }
    return H.truncate(result.join('\n'), H.MAX_OUTPUT)
  },

  // ---- hot-news-fetch: multi-source news snapshot (RAG grounding corpus) ----
  'hot-news-fetch': async function hotNewsFetch(args) {
    args = args || {}

    let hotNewsDir
    try {
      hotNewsDir = H.resolveTaskDir('llamaindex', 'hot-news')
    } catch (e) {
      return `error: hot-news-fetch — ${e.message}`
    }

    const sources = (args.sources != null ? String(args.sources) : '').trim()
    if (sources) {
      for (const s of sources.split(',')) {
        const cs = s.trim()
        if (cs && !HOT_NEWS_SOURCES.includes(cs)) {
          return `error: hot-news-fetch 未知源「${cs}」；可用: ${HOT_NEWS_SOURCES.join(', ')}`
        }
      }
    }

    const rawOut = args.out != null ? String(args.out).trim() : ''
    const out = rawOut
      ? H.absolutizeTaskPath(rawOut, () => H.resolvePseDir('llamaindex'))
      : path.join(hotNewsDir, 'news')

    const cmdArgs = [`--out=${out}`]
    if (sources) cmdArgs.push(`--sources=${sources}`)
    if (args.limit != null) cmdArgs.push(`--limit=${args.limit}`)
    if (args.max_age_days != null) cmdArgs.push(`--max-age-days=${args.max_age_days}`)
    if (args.clean) cmdArgs.push('--clean')
    if (args.use_proxy) cmdArgs.push('--use-proxy')

    const res = await H.runPseScript({
      tool: 'hot-news-fetch',
      script: path.join(hotNewsDir, 'fetch_news.py'),
      cwd: hotNewsDir,
      args: cmdArgs,
      noSync: true,
    })
    if (!res.ok) return res.error

    const body = res.stdout.replace(/\n{3,}/g, '\n\n').trim()
    return [
      `> hot-news-fetch 完成 → ${out}${sources ? `（源：${sources}）` : '（全部源）'}`,
      '',
      body.length > 3000 ? body.slice(-3000) : body,
      '',
      '> 下一步：用 hot-news-topics 列候选话题，再让 hot-news 按平台生成合规文案。',
    ].join('\n')
  },

  // ---- hot-news-topics: list ranked candidate topics from the news snapshot ----
  'hot-news-topics': async function hotNewsTopics(args) {
    args = args || {}

    let hotNewsDir
    try {
      hotNewsDir = H.resolveTaskDir('llamaindex', 'hot-news')
    } catch (e) {
      return `error: hot-news-topics — ${e.message}`
    }

    const rawDir = args.news_dir != null ? String(args.news_dir).trim() : ''
    const dir = rawDir
      ? H.absolutizeTaskPath(rawDir, () => H.resolvePseDir('llamaindex'))
      : path.join(hotNewsDir, 'news')

    try {
      await fsp.access(dir)
    } catch {
      return `error: hot-news-topics 未找到新闻快照目录 ${dir} —— 请先调用 hot-news-fetch 抓取素材。`
    }

    const res = await H.runPseScript({
      tool: 'hot-news-topics',
      script: path.join(hotNewsDir, 'run.py'),
      cwd: hotNewsDir,
      args: ['--list-topics', `--news-dir=${dir}`],
      noSync: true,
    })
    if (!res.ok) return res.error

    const body = res.stdout.trim()
    return [
      `> 📋 热点话题候选（来源：${dir}）`,
      '',
      body.length > 6000 ? body.slice(-6000) : body,
      '',
      '> 挑选一条标题告诉 hot-news（主题 + 目标平台 + 品类），即可生成合规文案；生成后可再 hot-news-check 校验。',
    ].join('\n')
  },

  // ---- hot-news-check: offline pre-publish validation (no network) ----
  'hot-news-check': async function hotNewsCheck(args) {
    args = args || {}
    const platform = args.platform || 'xiaohongshu'
    if (!HOT_NEWS_PLATFORMS.includes(platform)) {
      return `error: hot-news-check 未知平台「${platform}」；可用: ${HOT_NEWS_PLATFORMS.join(', ')}`
    }

    let hotNewsDir
    try {
      hotNewsDir = H.resolveTaskDir('llamaindex', 'hot-news')
    } catch (e) {
      return `error: hot-news-check — ${e.message}`
    }

    let article = args.article != null ? String(args.article).trim() : ''
    if (!article) article = (await H.latestHotNewsArticle(platform, hotNewsDir)) || ''

    const runArgs = ['check']
    const env = article ? { ...process.env, HOT_NEWS_ARTICLE: article } : undefined
    if (platform === 'xiaohongshu' && article) runArgs.push(`--article=${article}`)

    const res = await H.runPseScript({
      tool: 'hot-news-check',
      script: path.join(hotNewsDir, 'publish', `publish_${platform}.py`),
      cwd: hotNewsDir,
      args: runArgs,
      env,
      noSync: true,
    })
    if (!res.ok) return res.error

    const body = res.stdout.trim()
    return [
      `> ✅ hot-news-check 完成（平台：${platform}，离线校验，无需联网）`,
      article ? `> 校验文章：${article}` : '> 注意：未找到成稿，使用发布端 .env 的默认文章路径',
      '',
      body.length > 2500 ? body.slice(-2500) : body,
    ].join('\n')
  },

  // ---- hot-news-publish: Playwright fills the real editor, stops for humans ----
  // Never auto-publishes: it fills the editor (title/body/cover/topics, AI label)
  // and stops there for the user to review and click publish themselves.
  'hot-news-publish': async function hotNewsPublish(args) {
    args = args || {}
    const platform = args.platform || 'xiaohongshu'
    if (!HOT_NEWS_PLATFORMS.includes(platform)) {
      return `error: hot-news-publish 未知平台「${platform}」；可用: ${HOT_NEWS_PLATFORMS.join(', ')}`
    }

    let hotNewsDir
    try {
      hotNewsDir = H.resolveTaskDir('llamaindex', 'hot-news')
    } catch (e) {
      return `error: hot-news-publish — ${e.message}`
    }

    let article = args.article != null ? String(args.article).trim() : ''
    if (!article) article = (await H.latestHotNewsArticle(platform, hotNewsDir)) || ''

    const cmdArgs = ['publish']
    const env = article ? { ...process.env, HOT_NEWS_ARTICLE: article } : undefined
    if (platform === 'xiaohongshu' && article) cmdArgs.push(`--article=${article}`)
    if (args.dry_run) cmdArgs.push('--dry-run')
    if (args.save_as_draft && platform === 'xiaohongshu') cmdArgs.push('--save-as-draft')

    const res = await H.runPseScript({
      tool: 'hot-news-publish',
      script: path.join(hotNewsDir, 'publish', `publish_${platform}.py`),
      cwd: hotNewsDir,
      args: cmdArgs,
      env,
      timeoutMs: 900_000,
      // 注意：publish 是真实 Playwright 浏览器任务，刻意【不带】 noSync ——
      // 与参考实现一致：publish 需要 uv 同步到 playwright 等真实依赖，
      // 而 check/fetch/topics 的纯解析脚本才用 noSync 跳过重量依赖同步。
    })
    if (!res.ok) return res.error

    const body = res.stdout.trim()
    return [
      `> 🔗 hot-news-publish 完成（平台：${platform}，已填好内容停在编辑器，请人工核对后发布）`,
      article ? `> 文章：${article}` : '> 注意：未指定文章，发布端使用 .env 默认路径',
      '',
      body.length > 2500 ? body.slice(-2500) : body,
    ].join('\n')
  },
}
