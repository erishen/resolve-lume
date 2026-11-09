#!/usr/bin/env node
// 生成 sidecar 工具集的 .lume 代理层，把 42 个 builtin 工具接给 agent-httpd。
//
// 为什么要生成而不是手写：
//   resolve-lume 里真正跑 ReAct/PSE 循环的是 C 进程 agent-httpd，它只认 stdio MCP。
//   业务工具的执行体在 Node sidecar（宿主），所以中间必须有一层「stdio MCP → HTTP」。
//   这层的 schema 必须与 sidecar/builtin-tools.json 同源，否则会漂移出「面板有、
//   agent 没有」的假象（本轮排查的那个 FAIL 就是这么来的）。因此 schema 由脚本单向生成。
//
// 为什么走 .lume 而不是 Node stdio MCP server：
//   agent-httpd 的 C MCP 客户端把子进程 stderr 并进同一条管道（mcp.c:242），
//   且要求整个缓冲区恰好是一个平衡 JSON（mcp.c:354 json_complete）——Node SDK 普遍
//   console.error 打日志，握手必然超时（compose 43-49 因此只挂了 lume-core）。
//   lume-core 是 C 写的、已被现有 lume-tools 桥证明能握手，所以代理层写成 .lume 最省事。
//
// 三处硬限制（都在 C 侧，超了会静默出事，所以生成时断言）：
//   desc ≤ 160B      lume.h:429 ToolRec.desc[161] + mcp.c:842 TOOL_DESC_MAX
//   toolName ≤ 48B   mcp.c:841 char name[48]，jread_string 失败会 return —— 整张表后续全丢
//   单帧 ≤ 64KiB     bridge_mcp.c:275/54 char line[65536]，超了 snprintf 截断成非法 JSON
//
// 用法：
//   node deploy/gen-sidecar-tools.mjs                 # 生成默认只读集
//   node deploy/gen-sidecar-tools.mjs --all           # 生成全部 42 个（含写/发布类）
//   node deploy/gen-sidecar-tools.mjs --only=a,b      # 自定义子集
//   node deploy/gen-sidecar-tools.mjs --check         # 只校验不写文件

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCHEMA_FILE = path.join(ROOT, 'sidecar', 'builtin-tools.json')
const OUT_DEFAULT = path.join(ROOT, 'lume-tools', 'sidecar_ro.lume')

// 默认只暴露「读 / 分析」类：不写盘、不向外发布、不驱动共享浏览器、不跑任意命令。
// 其余需要单独确认——注意 agent-httpd 的 approval 字段只打日志、没有门
// （mcp.c:754），所以「挂上去」就等于「agent 可以自主执行」，这里刻意保守。
//
// 例外（2026-11-04）：article-write / skill-run 必须挂上。此前只挂了
// article-discover + article-validate，模型在用户说「给 X 写文章」时看不到
// 生成工具，只能 read-file/analyze-code-dir 去猜仓库路径，最后得出「网关没
// 挂载 article-write」的错误结论。article-write 默认 publish=false，且 schema
// 明确禁止在调用前读文件，暴露它反而消除了那几轮无效的文件探查。
//
// 例外（2026-11-06）：article-publish 挂上。UI 示例与用户习惯都是「让聊天
// agent 列待发布清单/发布」，但桥面没有它，模型只能说「工具不存在」再幻觉
// 补救（2026-11-06 20:53 实录：编造 project="wordpress" + 推荐不相干的
// post-comment skill）。安全性由 server.js /api/tools/call 的门禁兜底：
// 无 confirm = 清单/预览（只读）；confirm=true 真发布，必须命中
// hasExplicitPublishIntent（用户当前消息明确说 发布/上线/publish）。
//
// 例外（2026-11-09）：投资/分析线六个工具挂上。此前 portfolio-check / pse-review
// 都「已实现但 Agent 看不到」，用户要「深度投资组合分析」时模型只能回「工具未开放」，
// 只能由人手动在面板里跑。它们都是「读本地数据 + 调模型出报告」，不写公开内容、
// 不对外发布；pse-review 的付费档(deepseek)另由 server.js 的显式意图闸门兜底，
// 默认走免费 router/free 档。
const DEFAULT_ALLOW = [
  'echo', 'calculator', 'read-file', 'analyze-dir', 'analyze-code-dir',
  'doc-library-search', 'photo-duplicates', 'video-library-list', 'privacy-audit',
  'stock-scan', 'dev-stats', 'hot-news', 'hot-news-fetch', 'hot-news-topics',
  'hot-news-check',   'article-discover', 'article-validate', 'article-write',
  'article-publish',
  'skill-run', 'pick-post', 'resume-tailor', 'interview-questions', 'system-info',
  'capabilities',
  'portfolio-check', 'pse-review', 'pse-review-latest',
  'csv-analyze', 'product-analyze', 'crm-task',
  // 2026-11-09 第二批：剩余 12 个高危工具全部挂上（用户要求「都开放」，
  // 参照 resolve-studio：工具全可见，靠 needsApproval + 人工审批门兜底）。
  // lume 侧的审批门在 sidecar/approval.js：/api/tools/call 收到 gated 工具
  // 时把 approval-request 推进活跃 chat SSE，等用户点 Approve；60s 超时或
  // 无活跃会话一律按拒绝（fail closed）。面板 /api/tool/run 是人工主动操作，
  // 不过门。
  'write-file', 'shell', 'make', 'browser-open', 'browser-screenshot',
  'article-archive', 'hot-news-publish', 'build-juejin', 'juejin-draft',
  'juejin-publish', 'wechat-draft', 'sf-pw-publish',
]

const args = process.argv.slice(2)
const has = (f) => args.some((a) => a === f || a.startsWith(f + '='))
const valOf = (f) => (args.find((a) => a.startsWith(f + '=')) || '').split('=').slice(1).join('=')
const out = valOf('--out') || OUT_DEFAULT

const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')).tools
const picked = has('--all')
  ? schema.map((t) => t.name)
  : has('--only')
    ? valOf('--only').split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOW

const missing = picked.filter((n) => !schema.some((t) => t.name === n))
if (missing.length) {
  console.error('未知工具名（schema 里没有）:', missing.join(', '))
  process.exit(1)
}
const tools = picked.map((n) => schema.find((t) => t.name === n))
const held = schema.filter((t) => !picked.includes(t.name)).map((t) => t.name)

// JSON Schema 类型 → lume 的简写类型表（bridge_mcp.c:112-122 只认这几个词，
// 其它一律退化成 string；不支持 required / enum / 字段级 description）
const TYPE = {
  string: 'string', integer: 'int', number: 'number',
  boolean: 'bool', array: 'array', object: 'object',
}

// 按字节截断且不切断 UTF-8 序列（C 侧限制是字节，len() 也是字节）
function cutBytes(s, max) {
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > max) break
    out += ch
    bytes += b
  }
  return out
}

// C 侧 ToolRec.desc[161] 只允许 ~150B。article-write 的原始描述有 1.7KB，
// 直接按字节截断会把「不要先读文件 / 不要猜路径」这条最关键的行为约束切掉
// ——正是它决定模型会不会绕去 read-file，然后误判「网关没挂载这个工具」。
// 因此给超长描述的工具一份「行为优先」的精简版：核心指令在前，枚举在后，
// 即使被 cutBytes 截尾也不会丢主指令。
// 行为优先精简版：每个「对 agent 开放」的工具都必须有一条。
// 2026-11-04 全量审计发现：23 个工具里 21 个原描述 >148B，被 cutBytes 截到
// 只剩开头半句 —— article-validate 的「仅校验不发布」、article-discover 的
// 「无需再 read-file 找 projects.json」、resume-tailor/hot-news 的
// 「Do NOT read any files before calling」、dev-stats 的「禁止编造数字」
// 全部丢失。这正是「模型绕去读文件→误判能力不存在」的同源根因，不能只给
// article-write 打补丁。下面每条都把关键约束放在最前，且 ≤148B。
const DESC_OVERRIDE = {
  // 2026-11-09 高危工具（人工审批门兜底）：描述里先写「需要批准」和「不要
  // 假装成功」，避免 148B 截断把约束吃掉。
  'write-file':
    'Write text to a file (allowed roots only). req: path, content. Needs human approval; report the real path, never claim it wrote on failure.',
  'shell':
    'Run ONE shell command (15s, 8KiB output cap). Human approval required on every call; quote the real output, never fake success or retry blindly.',
  'make':
    'Run make in a project dir. req: dir; optional target. Human approval required; report exit status verbatim, do not assume the target passed.',
  'browser-open':
    'Open a URL in the shared browser and screenshot it. Human approval required; describe what actually rendered, not what you expect.',
  'browser-screenshot':
    'Screenshot the current shared browser page. Human approval required; never guess page content from the URL alone.',
  'article-archive':
    'Archive/reorganise finished article projects (local file moves). Human approval required; report exactly what moved.',
  'build-juejin':
    'Build a Juejin draft payload from an article (local, no upload). Human approval required; report the artifact path.',
  'juejin-draft':
    'Save a Juejin DRAFT via platform API (external side effect). Human approval required; never call twice, never publish.',
  'juejin-publish':
    'PUBLISH an article to Juejin (external, irreversible). Human approval required; only after an explicit user publish request.',
  'wechat-draft':
    'Create a WeChat MP draft (external side effect). Human approval required; creates a draft only, does not push to followers.',
  'sf-pw-publish':
    'Publish to SegmentFault via Playwright (external, irreversible). Human approval required; explicit user request only.',
  'hot-news-publish':
    'Publish a hot-news draft to its platform (EXTERNAL). Human approval required; only after an explicit user publish request.',
  'capabilities':
    'Ask FIRST for publish/make/shell/PSE-review or "is X available": lists ALL tools and which are exposed to you. NEVER claim a capability is missing.',
  'article-write':
    'Write article? Call DIRECTLY with project=KEY; NEVER read files or guess paths first. Omit project to list candidates. ONE article per call.',
  'skill-run':
    'Load a SOUL.md skill by name (planner/specialist/evaluator). article-write is a TOOL not a skill: call that tool with project=KEY.',
  'echo': 'Echo text back. req: text. Use only to confirm the tool bridge is alive.',
  'calculator': 'Evaluate basic arithmetic. req: expression. No variables or functions.',
  'read-file':
    'Read a text file. rel-base=work/ req: path. Repo short name works (lume-a2a/README.md). Page with offset/limit. Never use to guess article paths.',
  'analyze-dir':
    'Recursively scan a directory, bounded report. rel-base=work/ req: dir. Repo short names resolve. Read-only; use for unfamiliar folders.',
  'analyze-code-dir':
    'Symbol skeleton + LSP diagnostics, falls back to analyze-dir. rel-base=work/ req: dir. Read-only. Never call to guess article project paths.',
  'doc-library-search':
    'Full-text search in local Markdown library. req: q. Needs markdown-library :3300; if down, report it plainly, do not retry blindly.',
  'photo-duplicates':
    'Find duplicate photos + library stats (read-only). Needs photo-library :3100; if down, report it plainly instead of retrying.',
  'video-library-list':
    'List indexed videos (codec/resolution/duration). Needs video-library :3200; if down, report it plainly instead of retrying.',
  'privacy-audit':
    '9 read-only privacy/secret checks on a git repo. target=repo short name or rel path under work/. Never modifies files.',
  'stock-scan':
    'Scan A-share technical signals (read-only, takes minutes). Call ONCE; never retry just because it is slow.',
  'dev-stats':
    'Dev stats: reads/CI/clone CSV. target in [report|juejin|segmentfault|ci|actions]. Never use shell/read-file here; quote only tool output.',
  'hot-news':
    'Generate compliant social copy for a hot topic (1-5 min). req: topic. Call DIRECTLY, never read files first. Paid provider needs approval.',
  'hot-news-fetch':
    'Fetch hot-news snapshots into news/ (pipeline step 1). sources is a COMMA-SEPARATED STRING like "weibo,infoq", NOT an array.',
  'hot-news-topics':
    'List writable hot topics from existing news/ snapshots (read-only). Run hot-news-fetch first if empty.',
  'hot-news-check':
    'Offline-check a hot-news draft before publishing. platform in [xiaohongshu|zhihu|toutiao]. Never publishes.',
  'article-discover':
    'Scan workspace repos for NEW article projects. add=false = dry-run (default writes projects.json). Returns its path: NEVER read-file to find it.',
  'article-validate':
    'VALIDATE only, never publishes. project MUST be from enum (NEVER invent names like wordpress); omit project to list queue.',
  'article-publish':
    'Publish ONE article to WordPress. Omit project = LIST queue (read-only). confirm=true REALLY publishes: only on explicit user publish request.',
  'pick-post':
    'Pick one published WordPress post at random (read-only). Requires ERISHEN_BASE in .env.',
  'resume-tailor':
    'Tailor a resume to a JD or recommend positions (1-5 min). req: mode in [customize|recommend]. Call DIRECTLY, never read files first.',
  'interview-questions':
    'Generate 9 technical interview questions (1-5 min). req: mode. Call DIRECTLY, never read files first.',
  'system-info':
    'Runtime diagnostics: memory/CPU/uptime/platform. Optional section filter.',
  // 2026-11-09 投资/分析线新挂的工具：约束放最前，避免被 148B 截断后模型看不到
  // 「先体检」「只会跑一次」「付费档要用户同意」这类关键约束。
  'portfolio-check':
    'Refresh portfolio snapshot FIRST (1-3 min, read-only). On anomalies: report verbatim, do NOT continue to pse-review, never invent numbers.',
  'pse-review':
    'Full PSE review (Planner/Specialist/Evaluator, 2-6 min). Call ONCE. Default FREE; provider=deepseek is PAID, needs explicit user OK.',
  'pse-review-latest':
    'Read the LAST saved PSE review (Markdown + path). Use for follow-up numbers when report text is gone; never invent figures.',
  'csv-analyze':
    'Analyze ONE CSV into an HTML report (profile/trends/anomalies). req: file. Read-only; always report the output path.',
  'product-analyze':
    'Product/competitor analysis via 3-agent pipeline (report under sandbox/). req: product. Call DIRECTLY, never read files first.',
  'crm-task':
    'One personal-CRM pipeline: task in [crm-qa|follow-up-draft|weekly-review]. Needs CRM DB/API. Default FREE; deepseek PAID needs explicit OK.',
}

function buildDesc(t) {
  if (DESC_OVERRIDE[t.name]) return cutBytes(DESC_OVERRIDE[t.name], 148)
  const props = (t.parameters && t.parameters.properties) || {}
  const req = (t.parameters && t.parameters.required) || []
  const one = String(t.description || '').replace(/\s+/g, ' ').trim()
  const LIMIT = 148 // C 侧 ToolRec.desc[161] / TOOL_DESC_MAX，留 13B 余量（截断省略号与转义）

  // 顺序很重要：必需提示（基准路径、必填参数）先占位，再把原文描述截到剩余空间。
  // 之前反着写，导致 36 个「描述本来就超 150B」的工具在截断时把提示一起丢了。
  const parts = []
  if (Object.keys(props).some((k) => /^(dir|path|target)$/i.test(k))) {
    // agent 侧同时存在内置 read_file（容器 web root 沙箱）与已摘除的 rl_*（容器 /app），
    // 模型分不清用哪个、也猜不到相对路径的基准：实测它先传 "work/harness"，被拼成
    // work/work/harness 白花一轮。基准写进描述才治得了。
    parts.push('rel-base=work/')
  }
  if (req.length) parts.push('req: ' + req.join(','))
  // 没有手写精简版的长描述（--all / 未来新增工具）：把含强约束的句子自动
  // 提到最前，避免 cutBytes 把「不要 / NEVER / 仅」这类行为指令切掉。
  if (Buffer.byteLength(one, 'utf8') > 140) {
    const constraints = one
      .split(/(?<=[.!?。；])\s+/)
      .filter((s) => /NEVER|Do NOT|不要|禁止|切勿|仅用于|⚠️|CRITICAL|must not|必须/i.test(s))
      .slice(0, 2)
      .join(' ')
    if (constraints) parts.push(cutBytes(constraints, 60))
  }
  const enums = []
  for (const [k, v] of Object.entries(props)) {
    if (Array.isArray(v && v.enum)) enums.push(k + ' in [' + v.enum.slice(0, 5).join('|') + ']')
  }

  let head = parts.join(' ')
  if (enums.length) {
    const eh = enums.join('; ')
    // 只有还能给描述留下 40B 以上时才带枚举，否则保基准与必填优先
    if (LIMIT - Buffer.byteLength(head ? head + ' | ' + eh + ' | ' : eh + ' | ', 'utf8') > 40) {
      head = head ? head + ' | ' + eh : eh
    }
  }
  const prefix = head ? head + ' | ' : ''
  const budget = LIMIT - Buffer.byteLength(prefix, 'utf8') - 1
  let d = prefix + (Buffer.byteLength(one, 'utf8') > budget ? cutBytes(one, Math.max(0, budget - 1)) + '…' : one)
  if (Buffer.byteLength(d, 'utf8') > LIMIT) d = cutBytes(d, LIMIT)
  return d
}

function lumeStr(s) {
  // 描述里带引号（例如 calculator 的 e.g. "(2 + 3) * 4"），必须转义成 .lume 字面量
  return JSON.stringify(s).replace(/</g, '\\u003c')
}

const problems = []
for (const t of tools) {
  const nb = Buffer.byteLength(t.name, 'utf8')
  const db = Buffer.byteLength(buildDesc(t), 'utf8')
  const pk = Object.keys((t.parameters && t.parameters.properties) || {})
  if (nb > 40) problems.push(`name 超 40B: ${t.name} (${nb})`)
  if (db > 150) problems.push(`desc 超 150B: ${t.name} (${db})`)
  for (const [k, v] of Object.entries((t.parameters && t.parameters.properties) || {})) {
    const ty = TYPE[(v && v.type) || 'string']
    if (!ty) problems.push(`无法映射的类型 ${t.name}.${k}: ${v && v.type}`)
    if (Buffer.byteLength(k, 'utf8') > 40) problems.push(`参数名过长: ${t.name}.${k}`)
  }
  if (pk.length > 12) problems.push(`参数过多（tools/list 帧压力）: ${t.name} (${pk.length})`)
}
// 生产用的默认集必须「每个工具都有行为优先精简版」。缺一条就说明新增工具
// 时忘了写，C 侧 148B 截断会静默吞掉关键约束 —— 这正是上一轮事故的形态。
if (!has('--all') && !has('--only')) {
  for (const t of tools) {
    if (!DESC_OVERRIDE[t.name] || Buffer.byteLength(DESC_OVERRIDE[t.name], 'utf8') > 148) {
      problems.push(`缺少 ≤148B 的行为优先精简描述: ${t.name}`)
    }
  }
}
if (has('--check')) {
  console.log(`picked=${tools.length} held_back=${held.length}`)
  console.log(problems.length ? '校验失败:\n  ' + problems.join('\n  ') : '校验通过（name/desc/type/参数数都在 C 侧硬限内）')
  console.log('未暴露（待确认）:', held.join(', '))
  process.exit(problems.length ? 1 : 0)
}
if (problems.length) {
  console.error('生成中止，硬约束校验失败:\n  ' + problems.join('\n  '))
  process.exit(1)
}

const lines = []
lines.push('// ⚠️ 自动生成，不要手改。生成器: deploy/gen-sidecar-tools.mjs')
lines.push('// 数据源: sidecar/builtin-tools.json（schema 与实现同源，所以这里只做映射）')
lines.push('//')
lines.push('// 作用: 把宿主 sidecar 的业务工具以 stdio MCP 暴露给 agent-httpd，让跑循环的 C')
lines.push('// 进程真的能调用它们。此前 sidecar 的 42 个工具只进前端面板 /api/tools 和手动')
lines.push('// /api/tool/run，agent 只能看到内置 7 + lume-tools 5 + router 代理 4，导致需要')
lines.push('// 真实数据面的任务必然空转（PSE FAIL 的根因）。')
lines.push('//')
lines.push('// 依赖两个环境变量（compose backend 注入）:')
lines.push('//   SIDECAR_TOOLS_URL  例 http://host.docker.internal:3000/api/tools/call')
lines.push('//   SIDECAR_TOOLS_AUTH 与 sidecar 的 SIDECAR_TOKEN 同值。刻意不叫 *_TOKEN：')
lines.push('//     lume 的 env() 对含 TOKEN/SECRET/API_KEY/PASSWORD 的名字返回 null')
lines.push('//     （builtins_fs.c:85-101 env_is_sensitive），改名才取得到。')
lines.push('')
lines.push('// 所有 tool 共用这一条出站调用。工具名在各自 handler 里写死，LLM 无法把')
lines.push('// name 传成别的工具，因此不会把请求绕回 agent-httpd 形成回环。')
lines.push('func sidecar_tool(tool_name, args_json) {')
lines.push('  let base = env("SIDECAR_TOOLS_URL");')
lines.push('  if (len(base) == 0) { return "error: SIDECAR_TOOLS_URL not set (compose backend env)"; }')
lines.push('  let hdr = {"Content-Type": "application/json", "X-Sidecar-Token": env("SIDECAR_TOOLS_AUTH")};')
lines.push('  let body = "{\\"name\\":\\"" + tool_name + "\\",\\"arguments\\":" + args_json + "}";')
lines.push('  // allow_private: sidecar 绑宿主回环 127.0.0.1（server.js HOST 默认值），')
lines.push('  //                容器侧经 SIDECAR_TOOLS_URL(host.docker.internal) 到达——该主机名')
lines.push('  //                解析为私有网段地址，lume 的 SSRF 闸门默认拒私有地址')
lines.push('  //                （builtins_http.c:25-26,901）——不加这一句调用必失败。')
lines.push('  // 870s：pse-review / article-write 这类多智能体任务实测 7-12 min，原来的 600s')
lines.push('  // 会让报告已经写盘、桥却先 abort（2026-11-09 实录 sidecar__pse-review 502）。')
lines.push('  // 870 < agent-httpd MCP_CALL_TIMEOUT(900s)，让桥先失败并回可读错误。')
lines.push('  let r = http_post(base, {"headers": hdr, "body": body, "timeout": 870, "max_bytes": 2097152, "allow_private": true});')
lines.push('  if (r["ok"] != true) { return "error: sidecar call failed: " + str(r["err"]) + " status=" + str(r["status"]); }')
lines.push('  // json() 解析失败会中止脚本；包 try() 才能把「上游返回非 JSON」变成可读的')
lines.push('  // 工具错误。try 的成功值在 ok 键、失败信息在 err 键（builtins.c native_try）。')
lines.push('  let box = try(() => { return json(str(r["body"])); });')
lines.push('  let perr = get(box, "err", null);')
lines.push('  if (perr != null) { return "error: sidecar returned non-JSON: " + substr(str(r["body"]), 0, 300) + " (" + str(perr) + ")"; }')
lines.push('  let j = get(box, "ok", null);')
lines.push('  if (j == null) { return "error: sidecar result is null"; }')
lines.push('  let errv = str(get(j, "error", ""));')
lines.push('  if (len(errv) > 0) { return "tool error [" + tool_name + "]: " + errv; }')
lines.push('  let outv = str(get(j, "result", ""));')
lines.push('  // 兜住 MCP 单帧 64KiB（bridge_mcp.c:54）：超了 snprintf 会截出非法 JSON，')
lines.push('  // 把整条 tool 结果变成协议错误。取 20000 是因为要留转义余量——极端情况下')
lines.push('  // 每个引号/反斜杠都会翻倍（20000*2 + 包装 < 65536），16000/40000 都不够稳。')
lines.push('  if (len(outv) > 20000) { outv = substr(outv, 0, 20000) + "\\n[output cut at MCP frame limit; the part above is complete, no retry needed]"; }')
lines.push('  // 双保险：业务函数历史上把可读失败写成 `error: ...`。sidecar 已在统一')
lines.push('  // 出口规范化，这里再兜住非 builtin 工具，避免 agent-httpd 把它当协议')
lines.push('  // 错误(502)并吞掉正文 —— 模型会因此看不到「服务未启动/未知平台」而重试。')
lines.push('  if (substr(outv, 0, 6) == "error:") { outv = "tool error [" + tool_name + "]: " + substr(outv, 6); }')
lines.push('  return outv;')
lines.push('}')
lines.push('')

// 参数别名：模型对 skill-run 常传 `skill` 而不是 schema 里的 `name`。C 侧
// bridge_mcp.c 只保留声明过的参数，不在这里补别名，请求里的 skill 会在过桥
// 时被丢掉（实测页面请求就是 skill-run({"skill":"article-write"})）。
const EXTRA_PARAMS = { 'skill-run': { skill: 'string' } }

// 有些参数模型极容易传错 JSON 类型（hot-news-fetch.sources 常被传成数组，
// 而 schema/实现是逗号分隔字符串）。lume-core 的 mcp_validate_args 在调用
// handler 之前就按声明类型拒绝，回 `error: invalid argument type`，再被
// agent-httpd 判成 502 —— 模型看不到原因只能反复重试。这些键不写进桥的
// params 声明（unknown keys 会原样透传给 handler），由 sidecar 的
// normalizeArgs 统一归一化，错误就变成一次成功的调用。
const LOOSE_PARAMS = { 'hot-news-fetch': ['sources'] }

for (const t of tools) {
  const loose = new Set(LOOSE_PARAMS[t.name] || [])
  const rawProps = {
    ...((t.parameters && t.parameters.properties) || {}),
    ...(EXTRA_PARAMS[t.name] || {}),
  }
  const props = Object.fromEntries(Object.entries(rawProps).filter(([k]) => !loose.has(k)))
  const entries = Object.entries(props).map(([k, v]) => `${lumeStr(k)}: ${lumeStr(TYPE[(v && v.type) || 'string'])}`)
  lines.push(`tool ${lumeStr(t.name)}, ${lumeStr(buildDesc(t))}, {${entries.join(', ')}}, (p) => {`)
  lines.push(`  return sidecar_tool(${JSON.stringify(t.name)}, stringify(p));`)
  lines.push('};')
  lines.push('')
}

lines.push('// 未暴露的工具（needsApproval 标记不可信，见生成器注释；要加就改 --only 重生成）:')
for (const n of held) lines.push(`//   ${n}`)
lines.push('')

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, lines.join('\n'))
const bytes = Buffer.byteLength(lines.join('\n'), 'utf8')
console.log(`已生成 ${path.relative(ROOT, out)}: ${tools.length} 个工具, 未暴露 ${held.length} 个, 文件 ${bytes}B`)
