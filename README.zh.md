> 中文文档（本文件）。English version: [README.md](./README.md)

# resolve-lume

用 **lume + lume-core + react** 技术栈重建 [resolve-studio](../../harness/resolve-studio) 的核心能力。

> 关键背景：lume 的 `agent-httpd` 本身就是 **resolve-studio 后端的 C 移植版**（其源码注释明写
> *"port of resolve-studio's McpService / session-store / runPseOrchestrator, C edition"*）。
> 所以本项目不是「从零重写」，而是把那次移植收尾成一个**独立部署、零 Node 运行时依赖**的产品——
> 后端用 lume 的 C 单二进制，自定义工具用 lume-core 的 `.lume` 脚本，前端用 React。

## 技术栈与职责

| 组件 | 角色 | 备注 |
|---|---|---|
| **lume** (`agent-httpd`) | 后端运行时 | C 单二进制，内置 ReAct agent 循环 + PSE 三角色编排 + MCP client + SSE。约 1.7MB，**无 Node、无 nginx 依赖** |
| **lume-core** | 自定义工具提供方 | 以 `--mcp` 模式把 `.lume` 脚本里的 `tool {}` 暴露成 MCP server，被 agent-httpd 拉取 |
| **react** (Vite) | 前端 | 静态 SPA，由容器内 Node 服务 `frontend/server-entrypoint.mjs` 托管（CSP、安全头、SSE 超时、token 注入都在这里），反代 `/react`、`/api` 与「桌面」Tab 的 `/novnc`（含 WebSocket 隧道）；**镜像内没有 nginx**，`nginx.conf` 仅为退役参考 |
| **sidecar** (Node) | 网关 + 功能后端 + 工具执行层 | 宿主 macOS 常驻进程（非容器），监听 `127.0.0.1:3000`，由 `launcher.js`(:3099) 守护；直接复用宿主已装 node/python3/uv/make 工具链，读写宿主真实项目路径 |

## 架构

```
浏览器 ── :18085 ──► frontend 容器 (node server-entrypoint.mjs)
                        │  /            → 静态 SPA (dist)
                        │  /react/*     ──proxy──────► backend 容器 :8080      (compose 内网直连)
                        │  /api/*       ──proxy──────► host.docker.internal:3000
                        │                                      │
                        │                                      ▼
                        │                          宿主 sidecar 进程 (Node, 127.0.0.1:3000)
                        │                           ├─ 内置工具 (read/write/shell/make/stock-scan…)
                        │                           │    直接读写宿主真实项目路径（无容器挂载）
                        │                           └─ 代理 /chat /pse /tools → 127.0.0.1:8080
                        │                                  │
                        │                                  ▼
                        │                          backend 容器 (agent-httpd)
                        │                           ├─ PSE 编排 (planner→specialist→evaluator)
                        │                           ├─ MCP client → lume-core --mcp (容器内子进程)
                        │                           └─ LLM (OpenAI 兼容 /chat/completions)
```

- **两个 compose 容器（backend + frontend）** 由 `restart: unless-stopped` + healthcheck 管理；
  **sidecar 是宿主常驻进程**（监听 `127.0.0.1:3000`），由 `launcher.js`(:3099) 守护拉起
  （崩溃退避重拉、上限 5 次；launcher 自身无看门狗，需手动重启或配 launchd 开机自启）。
  `make start` 只起两个容器并等 `/api`——**不含 sidecar**，需另跑 `make sidecar-host-start`。
- backend 在 compose 内网 `expose`，另经 `127.0.0.1:8080` 发布到宿主 loopback 供 sidecar 回连；
  浏览器只接触 `frontend:18085`，frontend 经 `host.docker.internal:3000` 反代到宿主 sidecar。
- sidecar 直接读写宿主真实项目路径（无 bind mount / 数据卷语义），
  运行时数据落宿主 `.data-sidecar/`（jobs/sessions/pidfile/日志），重建容器不丢。
- `PSE_SOULS_DIR` 指向角色定义（已 bind mount 进 backend 容器）；`MCP_SEED_FILE` 注册 MCP server。

## 目录结构

```
resolve-lume/
├── agent-httpd/             # vendored：GitHub release v0.12.1（C 后端）
├── lume-core/              # vendored：GitHub release v0.13.1（.lume 工具桥）
├── docker-compose.yml       # backend + frontend 两容器（sidecar 是宿主进程，不经 compose）
├── Dockerfile.backend       # 多阶段：构建 agent-httpd + lume-core → debian 运行时
├── Makefile                 # setup / build / up / wait / start / down / logs
├── .env.example             # LLM 网关 + PSE 开关
├── deploy/
│   ├── backend-entrypoint.sh
│   └── mcp-servers.json     # MCP 注册表（lume-tools 桥）
├── souls/                   # PSE 三角色 SOUL.md（port 自 resolve-studio 语义）
│   ├── planner/SOUL.md
│   ├── specialist/SOUL.md
│   └── evaluator/SOUL.md
├── lume-tools/
│   └── tools.lume           # 自定义 .lume 工具（经 lume-core --mcp 暴露）
├── www/                     # agent-httpd docroot 占位
├── sidecar/                 # 网关 + 功能后端 + 工具执行层（宿主常驻进程）
│   ├── server.js / agent.js / store.js / builtin-exec.js / builtin-tools.json
│   ├── Dockerfile           # 容器模式用；当前宿主模式不使用（compose 已移除 sidecar 服务）
│   └── package.json
├── legacy/host-sidecar/     # 已退役的宿主 launcher/sidecar（仅存档，不参与运行）
└── frontend/                # Vite + React 聊天前端
    ├── src/{api.ts,App.tsx,types.ts,main.tsx,styles.css}
    ├── vite.config.ts       # dev 反代（/api→sidecar:3000 注入 token、/react→backend:8080 保留 Host）
    ├── server-entrypoint.mjs # 真正生效的静态服务 + /api、/react、/novnc 反代（CSP、Origin/Host 校验、token 注入、SSE 无超时）
    ├── nginx.conf           # ⚠️ 未被 Dockerfile 使用的退役参考，别按它排障
    └── Dockerfile
```

## 与 resolve-studio 的功能映射

| resolve-studio 能力 | resolve-lume 现状 | 说明 |
|---|---|---|
| PSE 三角色编排 (Planner/Specialist/Evaluator) | ✅ 已覆盖 | agent-httpd `pse.c` 直移植；SOUL.md 已移植 |
| ReAct 工具循环 + SSE 流式聊天 | ✅ 已覆盖 | `/react/api/chat` + `/react/api/pse` |
| MCP client（接 git/memory/think 等） | ✅ 机制已覆盖 | 在 `mcp-servers.json` 加条目即可，含 lume-tools 桥 |
| 自定义工具（lume-core `.lume`） | ✅ 演示级 | `lume-tools/tools.lume` 5 个示例工具 |
| 会话记忆 (JSON) | ✅ 后端有 | 需先经 `/login` 拿到 server-minted sessionId 才启用 |
| 前端聊天 UI | ✅ 基础版 | 流式渲染 + PSE 开关 + 工具列表 |
| **后台 job 持久化 / 续跑** | ✅ 已覆盖 | sidecar `/api/jobs` 落 SQLite（`node:sqlite`, WAL, 增量事件插入 O(1)，有事务）；取消会中断上游、续跑带历史 |
| **shell / write_file 内置工具** | ✅ 已覆盖 | sidecar 本地执行 11 个工具（read/write/shell/make/analyze-dir/privacy-audit/stock-scan…），schema 与实现同源 |
| 会话管理 UI / MCP 管理 UI | ✅ 已覆盖 | 会话已持久化 + 侧栏可用；MCP 面板展示 6 个 server 的真实状态与工具数（状态以后端已注册工具为准） |
| 工作区分析 / VNC 桌面 / skills / usage | ⚠️ 部分 | skills/usage/workspace 已实现（souls 扫描 + `/api/usage` + `scanWorkspace`）；tasks-match 仅关键词匹配；「桌面」Tab 的画面已接 browser-desk（`/novnc` 反代），自动化登录仍为占位 |
| Python PSE 框架 (autogen/crewai/…) | ⚠️ 共享依赖 | 两端都 `uv run python run.py` 调起，谁都替代不了 |

## 快速开始

```bash
cd work/harness/resolve-lume

# 1. 拉取 vendored 依赖（agent-httpd v0.12.1 / lume-core v0.13.1，来自 GitHub release）
make setup
#    或：bash scripts/vendor_repos.sh && bash scripts/vendor_lume_bin.sh

# 2. 配置 LLM 网关（不填 key 也能跑：自动回落离线 demo 引擎）
cp .env.example .env
#    编辑 .env 填入 LLM_API_KEY（可选）
#    ⚠️ 必填：把 SIDECAR_TOKEN 填成随机值（模板里是空值，留空则 frontend /
#       backend / sidecar / launcher 全部 fail-closed 拒绝启动）：
openssl rand -hex 32      # 复制输出，填到 .env 的 SIDECAR_TOKEN= 后面

# 3. 起两个容器（backend + frontend，构建后等 /api 就绪）
make start
#    等价于 make up（compose build + up -d）+ make wait（轮询 /api/tools 直到通）
#    注意：make start 不含 sidecar —— sidecar 是宿主常驻进程，见下一步。

# 4. 拉起宿主 sidecar（推荐交给 launchd 常驻：登录自启 + 崩溃重拉）
make sidecar-autostart-install
#    临时/调试模式（进程随当前终端会话存活，会话被回收即停）：make sidecar-host-start
#    状态速查：make sidecar-autostart-status / make sidecar-host-status
#
# 其他常用：
#   make wait                 # 只等容器就绪（容器 Up ≠ 可用）
#   make logs                 # 跟踪两个容器日志（sidecar 日志在 .data-sidecar/）
#   make frontend-up          # 只重建前端容器
#   make sidecar-host-stop    # 停宿主 sidecar + launcher（仅手工模式有效）
#   make sidecar-autostart-restart    # launchd 模式下改了 sidecar/ 源码后重启
#   make sidecar-autostart-uninstall  # 移除 launchd 托管并停掉 sidecar
#   make down                 # 停两个容器（不影响宿主 sidecar）
#   make check                # 静态校验：工具桥约束 + 四处名单一致性 + 网关/SSE/进度/导出回归 + shell 变量兼容
#   make frontend-build-check  # 前端 tsc --noEmit + vite build（需 frontend/node_modules）

# 5. 打开 http://127.0.0.1:18085
#    浏览器 → frontend → sidecar → backend
```

本地开发前端（热更新，绕过 docker）：

```bash
cd frontend
npm install --registry https://registry.npmmirror.com
npm run dev   # :5173
```

`vite.config.ts` 的反代是 **dev 模式唯一生效的代理配置**（生产由容器内
`server-entrypoint.mjs` 负责）：

| 路径 | 默认目标 | 说明 |
|---|---|---|
| `/api/*` | `127.0.0.1:3000` 宿主 sidecar | Vite 在 Node 侧注入 `X-Sidecar-Token`（从仓库根 `.env` 读，**不进浏览器 bundle**）；客户端伪造的同名头会先被删除再强制覆盖 |
| `/react/*` | `127.0.0.1:8080` backend | `changeOrigin:false` 保留原始 `Host`，否则后端同源校验 403 |
| `/novnc/*` | `127.0.0.1:16082` browser-desk | 「桌面」Tab 的 noVNC 反代，`path` 重写为 browser-desk 根路径（`/novnc/websockify` → `/websockify`），并隧道 WebSocket |

### 「桌面」Tab 的接线（`/novnc`）

「桌面」Tab 本身不实现任何桌面：它把 noVNC 页面塞进 iframe，画面来自独立容器
`browser-desk`（Xvfb + x11vnc + websockify，6080 发布到宿主 `127.0.0.1:16082`）。

- **生产**：`frontend/server-entrypoint.mjs` 把 `/novnc/*` 反代到 `DESKTOP_URL`
  （默认 `http://host.docker.internal:16082`，可用 `.env` 覆盖），路径由
  `frontend/novnc-route.mjs` 重写（单测 `novnc-route.test.mjs`，已入门禁）。
  `server.on('upgrade')` 单独隧道 WebSocket —— 只代理 HTTP 会得到一页永远连不上的画面。
- **安全头**：SPA 默认 `X-Frame-Options: DENY` 会让同源 iframe 也拒绝渲染，
  因此 `/novnc/*` 的响应改用 `SAMEORIGIN` + `frame-ancestors 'self'`。
- **不在本仓镜像里**：`Dockerfile.backend` 没有也没有必要有 Xvfb/websockify；
  backend 只管 `agent-httpd`。桌面挂了先看 `docker ps | grep browser-desk`，
  再 `curl -s http://127.0.0.1:16082/vnc.html | head -1` 确认 noVNC 本身还活着。
- **「打开并登录」已接真实桌面**：`GET /api/desktop-login?url=…` 把校验过的 http/https
  网址用 CDP（`CDP_URL`，默认 `http://127.0.0.1:10023`）推进 desk 的新标签页并置前，
  页面里点完滑块/2FA 即可；`/api/desktop-login/sites` 透出 browser-desk 登录中心
  （`DESK_LOGIN_HUB_URL`，默认 `http://127.0.0.1:18088`）的站点清单。
  非 http(s)（`javascript:`/`file:`/`data:`）一律拒绝 —— 这台浏览器持有真实登录态。
- **desk 是共享浏览器**：微信草稿、Xianyu、思否共用同一批标签页，所以桌面 tab 会先显示
  上一个任务留下的页面。思否相关流程用 `SF_LOGIN_ENABLED=1` + `SF_LOGIN_URL`
  （默认 `https://segmentfault.com/user/login`，同时是输入框默认值）一键打开思否登录页。

两条链路都设了 `timeout/proxyTimeout = 0`，分钟级 SSE 长任务不会被掐断。
**前提**：宿主 launcher + sidecar 已在跑（`make sidecar-host-start`）；frontend / backend
容器不是必需的。需要改目标时，在仓库根 `.env` 或 shell 里设 `VITE_API_TARGET` /
`VITE_BACKEND_TARGET`（例如把 `/api` 指到已起的 `http://127.0.0.1:18085`）。
旧配置曾指向不存在的 `:8787`（web-server plugin），所有 dev 请求都会 502。
探测本机地址记得带 `curl --noproxy '*'`，否则会被本机代理接走。

> **设计说明**：sidecar 跑在宿主（非容器），直接复用宿主工具链、读写宿主真实项目路径，
> 无需 bind mount / `host.docker.internal` 跨界。早期版本曾把它容器化（`sidecar/Dockerfile`
> 存档），代价是工具链要在镜像里重装、且容器访问宿主 loopback 在原生 Linux 上不成立；
> 现在回归宿主常驻，backend/frontend 仍保持容器。详见下方 [「宿主 sidecar 模式」](#宿主-sidecar-模式sidecar-跑在-macos-宿主而非容器)。

## 配置说明

- **`.env`**：`LLM_API_URL/LLM_API_KEY/LLM_MODEL` 走 OpenAI 兼容；`PSE_ENABLED` 已不再生效——
  PSE 由前端「🧩 PSE」开关控制（sidecar 据此把 `/api/chat` 转发到 `/react/api/pse` 或 `/react/api/chat`），
  容器的 `PSE_ENABLED` 固定为 `false`，否则普通 chat 路由也会被强制跑 PSE、开关失效。
- **`LLM_TIMEOUT`**（单轮预算，默认 60s，`1..600`）：容器里 `docker-compose.yml` 透传 `${LLM_TIMEOUT:-60}`，本机
  设 120。用满时这一轮会被替换成 `upstream timeout (<Ns>)`（秒数即实际预算）；带大工具输出的轮次最容易顶满，
  要放宽就改 `.env` 后 `docker compose up -d backend`。
- **`.dockerignore`**：仓库根与 `frontend/` 均已排除 `.env` / `.env.*`，防止本地密钥被 `COPY . .` 烤入镜像
  （dev 模式 `.env` 仅由 Vite 的 Node 侧读取、绝不进浏览器 bundle；详见 `ARCHITECTURE.zh.md` 第 7、8 节）。
- **`souls/<role>/SOUL.md`**：改角色分工无需重建镜像（已 bind mount）。
- **`lume-tools/tools.lume`**：用 `tool "name","desc",{params},(p)=>{...}` 定义工具；改完重启 backend 容器即可被 agent-httpd 重新 harvest。
- **`deploy/mcp-servers.json`**：加 `"id"/"command"/"args"` 条目即可接入新 MCP server（如 git/memory/think）。

## 契约差异（前端对接要点）

agent-httpd 的 API 与 resolve-studio 的 `/api/*` **不同**：

- 聊天：`POST /react/api/chat`（或 `/react/api/pse`），body `{message, history?}`，**无 `sessionId` 也能跑**（仅关记忆）。
- SSE：`data: {"t":"delta"|"note"|"error"|"done","d":"..."}`——**只有 `data:` 行，类型在 JSON 的 `t` 字段**（resolve-studio 用 `event:` 行）。
- 工具：`GET /react/api/tools` 返回 `{tools:[{name,server,desc}]}`；调用名是 `<serverId>__<toolName>`。
- frontend 的 Node 反代 `/react` **必须保留原始 `Host` 头**（不要改写成上游地址），否则后端同源校验返回 403。
- **SSE 客户端策略**：`/api/chat`、`/api/tool/run` 是 POST 且非幂等 —— 断线**不自动重发**
  （重发会重跑整个 Agent、重复烧 token）；流结束却没收到 `done`/`error` 时显式报
  「连接中断，结果可能不完整」，已收到的内容保留。Stop 按钮的 `AbortSignal` 对聊天与
  工具重试流都生效，并会主动 `reader.cancel()` 释放连接。
- **终止帧即 EOF（别等 HTTP EOF）**：`done`/`error` 到达时 `readFrames` 立刻
  `reader.cancel()` 并让 `streamChat` resolve。`useChat` 只在 `send` 的 `finally` 里
  `setBusy(false)`，若把解禁绑在 HTTP EOF 上，反代 keep-alive / sidecar 重启留下的悬空
  连接会让「回答已经渲染完，输入框仍显示 Agent is thinking…」永久卡住（实测复现）。
  另设 `STREAM_IDLE_TIMEOUT_MS`（5 分钟）静默流兜底；`matchTask` 预检带 5s 超时并
  复用同一个 `AbortSignal`，避免卡在开跑之前。
- **长跑工具的实时进度**：对话式工具调用（`agent-httpd → /api/tools/call`）是一次阻塞
  JSON，C 侧等结果的十几分钟里不发任何 SSE 帧，`article-write` 因此像卡死。现在
  `sidecar/progress.js` 建了一条进度总线：`agent.proxySSE` 注册当前聊天的 SSE `res`，
  `executeBuiltinTool` 用 `AsyncLocalStorage` 把发射器透传到 `spawnCapture`（业务工具
  无需改签名），子进程 stdout/stderr 经「按行拼接 → 剥 ANSI / 掩码凭据 → 700ms 节流 →
  160 行配额」变成 `event: reasoning` 帧注入同一条流；前端 Thinking 区原本就消费
  `reasoning`，协议零改动。`/api/tool/run` 则直接写自己的 SSE 响应。
  **并发多个聊天时只在「恰好一个活跃流」时注入**，多流宁可不显示也不串台——精确的
  runId 关联要改 C 与 `.lume` 工具桥，属后续改造。进度帧同时会重置前端 5 分钟静默流
  看门狗，长跑不会被误杀。终帧 `done`/`error` 前会先 flush 完剩余进度。
  校验：`make check` 里的 `sidecar/progress.test.js`（13 例）。
- **工具跑偏护栏（不选任务也生效）**：工具桥一次暴露 24 个跨 6 个业务域的工具，
  而用户常态是 `taskMode=auto`（无任务 soul、无工具白名单）。11-06 实测：一次
  「7 = 写文章」在 `article-write` 失败后，模型改跑 `hot-news` 全套并用**完全相同参数**
  连跑 4 次耗尽 8 轮，最后连正文都没有。现在 `sidecar/chatBody.js` 给每次聊天常驻
  注入工具纪律（单工具族 / 失败如实转达 / 禁止同参数重试 / 编号原样直传 / 必须给总结）；
  `sidecar/toolGuard.js` 在 `/api/tools/call` 层拒绝「120s 内完全相同的失败调用」并
  附上上次错误；`runPseTask` 统一校验 `--provider` 只认 `free`/`deepseek`，框架名
  （如 `llamaindex-pse`）不再被静默拼进 Python 参数。C 侧 `agent.c` 的
  stray-repeat guard 只在「该轮同时输出了正文」时生效，纯工具轮拦不住，所以这层放
  sidecar。若最终仍无正文，`agent.js` 的 `done` 会输出工具轨迹（连续重复折叠成
  `hot-news ×4`）+ 轮数 + 最后错误，不再只甩一句「请重试」。
  校验：`chatBody.test.js`(6) / `toolGuard.test.js`(7) / `translateFrame.test.js`(7)。
- **最后一轮留给结论**：`AGENT_MAX_ROUNDS`（默认 8，`1..30`，请求体 `rounds` 可逐次覆盖）
  跑到最后一轮时不再下发工具 schema，并在已执行过工具时插入一条「预算已用完，直接给
  结论」的 in-band 提示；这一轮模型若仍吐 tool_call 会被丢弃（`final round: tool_call
  ignored`）。此前预算耗尽就直接结束循环，模型一路调工具就会得到空正文（11-10 实录：
  discover → validate ×3 → shell ×6 → build-juejin，最后「本轮没有产生回答」）。
  C 侧改动在 `deploy/patch_agent_httpd_final_round.py`，由 `scripts/patch_vendored_sources.sh`
  第 8 步在 `make build` 前重打；校验用请求体 `rounds:1` + 一次工具调用：改前工具执行完
  正文 delta 为 0，改后同一请求产出正文。
- **project enum 不再手写**：`article-*` 的 `project.enum` 由 `sidecar/projectEnums.js`
  从 `projects.json` + 仍有正文的存盘文章派生——`article-write` 严格等于当前队列，
  `validate/publish/archive` 额外保留 `legacy`、`resolve-lume` 这类已归档但文件仍在的
  项目。`article-discover` 新增项目后忘了同步 enum 的漂移（11-09 `lume-qt` 那次），
  现在 `toolContract.test` 会直接失败并提示跑 `make sync-enums`（只重写 enum，其他字段
  一个字节不动）。
- **发布必须用户显式授权**：`article-write(publish=true)` 只在「当前聊天消息」里明确
  写出发布 / 上线 / publish 时才放行（活跃流在 `progress.js` 里携带 userMessage）；
  用户只回清单编号时 `/api/tools/call` 直接拒绝。`publish.py` 的确认门在非交互环境
  会取消并 `exit 1`，旧实现让**已落盘**的文章被判成整次生成失败，模型再拿 stderr 里的
  `DeprecationWarning` 编出「异步事件循环的小问题」；现在 `translate.py` 不再因可选
  发布失败退出，`business-pse.js` 也能识别「已落盘但退出码非 0」，如实报告
  「已生成 / 未发布」，且不再无条件声称 `Auto-published`。
- **进度噪声与相关性证据**：Python 3.13 的 `asyncio.get_event_loop()` 已改成
  `get_running_loop()`，publisher 过滤解释器级 warning，避免无害告警被当成阶段故障。
  crewai-pse 的相关性闸门把同一文件的完整路径 / 后缀写法归一为一个证据，并要求
  「≥1 个真实符号 或 ≥2 个不同源码文件」，杜绝项目名刷屏 + 反复引用单个文件凑分放行。
- **job 流是 GET + 带 seq 的追加日志**，因此可以自动重连：`streamJob` 指数退避
  （500ms→8s 封顶），每次重连先收 `snapshot`，`useJobs` 按 `seq` 去重；
  「连接中断，正在重连」会显示在面板状态里，终态快照到达即停止重连。
  校验：`make check` 里的 `frontend/src/api.test.mjs`（mock fetch 流，15 个用例）。

## 已知限制 / 路线图

1. **长任务可靠性**（已解决）：job 记录已落 SQLite（WAL + 事务 + 增量事件插入 O(1)），进程崩溃不丢记录、不写截断。剩余建议：超长任务仍建议用 job 模式（事件持久化 + 可取消续跑），而非同步 chat。
2. **工具面**：lume 内置工具少，resolve-studio 的 ~37 个业务工具需逐步用 `.lume` 或 MCP server 重表达。
3. **前端外围**：workspace/usage/skills 已实现（简化版）；tasks-match 仅关键词匹配，待增强；VNC 桌面登录未启用（建议做成独立视图，复用 `/api/*`）。
4. **Python 大脑**：autogen/crewai/langgraph/llamaindex 仍是外部 `uv run` 依赖，迁移不变。

> 本仓库遵循「打开即用、可改可跑」：核心链路（聊天 + PSE + MCP + 工具）已可运行，
> 外围功能按上面路线图增量补齐，而非一次性堆空壳。

## 宿主 sidecar 模式（sidecar 跑在 macOS 宿主，而非容器）

当前 sidecar 是宿主 macOS 上的常驻进程（监听 `127.0.0.1:3000`），backend / frontend
**仍保持容器**，frontend 容器的 Node 服务经 `host.docker.internal:3000` 访问它。
> 历史上 sidecar 曾作为 compose 第三服务运行（`sidecar/Dockerfile` 仍存档），现已从
> `docker-compose.yml` 移除——下表"容器 sidecar"列仅供对照，需自行在 compose 重新加回
> sidecar service 定义才能使用。

### 模式选择

| | 容器 sidecar（已退役） | 宿主 sidecar（当前） |
|---|---|---|
| sidecar 位置 | compose 容器 | 宿主 node 进程 |
| 工具链 | 容器内 node24/python3/uv/make | 直接复用宿主已装工具链 |
| 生命周期 | `restart: unless-stopped`，开机自启 | 手工模式 nohup 随启动会话回收；launchd 模式登录自启 + KeepAlive |
| 启动 | 需自行在 compose 加回 sidecar service | `make sidecar-autostart-install`（推荐）/ `make sidecar-host-start`（临时） |
| compose 现状 | **已移除该服务** | 由 launcher 守护，不经 compose 管理 |

### 启停命令

```bash
# 前提：backend + frontend 容器保持运行（agent-httpd 已发布到 127.0.0.1:8080）
docker compose up -d backend frontend
# 注：compose 现已无 sidecar 服务，无需再 `docker compose rm -sf sidecar`；
#     若你曾手动加回过容器 sidecar，先停它再继续（两边都监听 3000 会冲突）。

# 【推荐】交给 launchd 常驻：生成 plist → 注册 → 等 :3000 就绪
make sidecar-autostart-install
#   注册接口在受限会话里可能返回 EIO；脚本会降级到 nohup 并提示，
#   在本机 Terminal 里重跑同一条命令即可完成注册（plist 下次登录也会自动加载）。

# 【临时】手工模式：nohup 起 launcher（:3099）+ sidecar（:3000）
make sidecar-host-start

# 状态速查
make sidecar-autostart-status   # launchd job + 3099/3000/18085 四处探测
make sidecar-host-status        # pidfile + /health + 3000 是否被容器抢占

# 停止：手工模式用 make sidecar-host-stop（SIGTERM 连带停 sidecar 并清 pidfile）；
# launchd 模式下它会被 KeepAlive 立刻拉回，请改用 uninstall / restart。

# compose 里已没有 sidecar 服务，无需也不能「回切容器模式」。
# 改了 sidecar/ 源码后的重启姿势：
make sidecar-autostart-restart              # launchd 模式
# make sidecar-host-stop && make sidecar-host-start   # 手工模式
```

### 组件与控制面

- `sidecar/start-host.sh`：宿主执行入口。显式 export 一份 env 白名单
  （PORT=3000 / HOST=127.0.0.1 / AGENT_HTTPD_URL=127.0.0.1:8080 /
  LLM_API_URL=127.0.0.1:19070 等），写 pidfile 后 `exec node sidecar/server.js`。
- `sidecar/launcher.js`：守护进程（纯 Node 内置模块），监听 `127.0.0.1:3099`，
  提供 `GET /health`、`GET /status`、`POST /start`、`POST /stop`。
  目前前端未接 `/launcher` 反代，控制面主要由上面的 make 目标调用。
  **`POST /start`、`POST /stop` 需要 `X-Sidecar-Token`（取 `.env` 同值）、且 `Host`/`Origin`
  必须是 loopback；`GET /health`、`GET /status` 只读、保持开放。** `make sidecar-host-start`
  已自动带 header，手工 curl 示例：
  ```bash
  TOK=$(awk -F= '/^SIDECAR_TOKEN=/{print substr($0,index($0,"=")+1)}' .env)
  curl --noproxy '*' -fsS -X POST -H "X-Sidecar-Token: $TOK" http://127.0.0.1:3099/stop
  curl --noproxy '*' -fsS -X POST -H "X-Sidecar-Token: $TOK" http://127.0.0.1:3099/start
  ```
  launcher 每次控制请求都重读 `.env` 里的 token，所以轮换令牌**无需重启 launcher**。

### 崩溃重拉与限制

- sidecar 是 launcher 的**直接子进程**（非 detached）：sidecar 崩溃且非用户主动
  停止时，launcher 2 秒退避后自动重拉。
- **重试上限：连续崩溃最多 5 次**，之后 launcher 放弃重拉并在
  `.data-sidecar/launcher.log` 写明原因，等待人工排查 sidecar.log 后再
  带 token `POST /start`（或 `make sidecar-host-stop && make sidecar-host-start`）。
  sidecar 若连续稳定运行超过 30 秒，重试预算清零（健康跑过后的偶发崩溃不计数）。
- **手工模式（nohup）的进程会随启动它的会话一起被回收**：launcher 与 sidecar 被
  直接 SIGKILL，日志里没有崩溃记录、只剩 pidfile 残留；而 Docker 托管的两个容器
  照常存活。此时 frontend 反代 `/api/*` 全部变成
  `502 Proxy error: connect ECONNREFUSED <host-gateway>:3000`，UI 报
  `failed to load runtime info: failed to load models: 502`。这类 502 与 LLM 网关、
  模型配置都无关，先跑 `make sidecar-host-status` 看 3000 有没有在听。
  **根治是下节的 launchd 托管。**
- **手工模式下 launcher 自身没有看门狗**：launcher 崩了 = 需要手动
  `make sidecar-host-stop` 清残留 pidfile 后重新 `make sidecar-host-start`；
  配了 launchd 后由 `KeepAlive` 兜住。

### launchd 常驻（推荐，一条命令装好）

`make sidecar-autostart-install` 调用 `scripts/install-launchd.sh`，按本机路径生成
`~/Library/LaunchAgents/com.erishen.resolve-lume.launcher.plist` 并注册到 `gui/$(id -u)`：

| 配置 | 作用 |
|---|---|
| `LAUNCHER_AUTOSTART=1` | launcher 一起来就拉起 sidecar（`launcher.js` 为该模式预留的开关） |
| `RunAtLoad` + `KeepAlive` | 登录自启 + launcher 崩溃自动重拉，补上 nohup 模式没有的看门狗 |
| 显式 `PATH` | launchd 默认 PATH 只有 `/usr/bin:/bin`，不补会让 shell/uv/node 工具静默 `ENOENT` |
| `StandardOut/ErrorPath` | `.data-sidecar/launcher.log` / `launchd.err.log` |

生成的 plist 含本机绝对路径，只写 `~/Library/LaunchAgents/`，**不入库**。注册前脚本
会先停掉残留的 nohup launcher，避免两边抢 3099 触发 `EADDRINUSE` 与 KeepAlive
无限重拉。

> **受限执行会话**：某些 Agent / 非 Aqua bootstrap 上下文调 `launchctl bootstrap`
> 会返回 `Bootstrap failed: 5: Input/output error`（连最小 plist 也一样），这不是
> plist 有误。脚本会打印降级提示并回退到 nohup 模式先把服务救回来；plist 已就位，
> 下次登录会自动加载。在本机 Terminal 里重跑
> `make sidecar-autostart-install` 即可立即注册。

托管期间不要用 `make sidecar-host-stop`（KeepAlive 会立刻把 launcher 拉回来）；
改了 `sidecar/` 源码用 `make sidecar-autostart-restart`，彻底移除用
`make sidecar-autostart-uninstall`。

### env 策略（与旧设计的关键区别）

- **白名单显式 export**：`start-host.sh` 只设置运行必需的 env，绝不继承宿主 shell
  的全局脏值（旧设计全量透传 `process.env` / 父 shell 环境，宿主的代理、PATH、
  工具链版本串进 sidecar 是主要坑）。
- **LLM_API_URL 显式覆盖**为 `http://127.0.0.1:19070/v1/chat/completions`
  （宿主 llm-router）。`.env` 里写的 `host.docker.internal:19070` 只给容器用；
  server.js 侧 envloader 的语义是「已存在的 env 不覆盖」，所以这里 export 优先级最高，
  envloader 只补 `LLM_API_KEY` / `LLM_MODEL` / `SIDECAR_TOKEN` 等。
- `SIDECAR_TOKEN` 不在此设：由 envloader 从 `.env` 读，与 frontend 容器注入的
  `X-Sidecar-Token`、backend 工具桥的 `SIDECAR_TOOLS_AUTH` 同源（三者必须同值）。
- **`SIDECAR_TOKEN` 必填且必须是随机值**：源码 / compose / `.env.example` 均不再提供
  默认值，缺失时 frontend、sidecar、compose 一律 fail-closed 拒绝启动。生成用
  `openssl rand -hex 32`；改值后须同时重启 frontend 容器、backend 容器与宿主 sidecar
  （launcher 热读 `.env`，不用重启）。
- 安全边界：`/api/tools/call`（Agent 桥）按 `lume-tools/sidecar_ro.lume` 的开放名单做
  服务端硬校验；`/api/file`、`/api/raw` 与文件类工具拒绝 `.env` / 私钥 / 凭据，即便它们
  位于 FS_ROOTS 之内。前端面板仍可手动运行全部已实现工具（本地操作者有意保留）。
- **make 参数防注入**：`runMakeIn` 对所有 `KEY=value` 参数做值白名单（仅普通 CLI flag /
  slug / 路径 / 数字），因为 GNU make 会把 `$(ARGS)` 展开进 `/bin/sh` recipe；`;`、
  `$( )`、反引号、管道、重定向、引号、换行一律拒绝。覆盖 `dev-stats` 的 `ARGS`、
  `article-*` 的 `P=` 等全部调用点，新增业务工具也不会漏。
- **工具链一致性**：schema（`builtin-tools.json`）、开放名单（`DEFAULT_ALLOW`）、生成桥
  （`sidecar_ro.lume`）、真实实现（`BUILTIN_NAMES`）四者漂移时 sidecar **拒绝启动**，
  避免再次出现「模型以为网关没挂载 article-write」。校验：`make check`（含
  `consistency.js` 与 `consistency.test.js`）；本地生成调试可临时 `ALLOW_TOOL_DRIFT=1`。
- `/api/approval` 当前没有 gated tool 可解锁：端点会校验 `decision` / `callId`、记审计日志，
  并显式返回 `applied:false`，不再假装用户点「批准」真的改变了执行。
- **只读 shell 免审批**：审批粒度是「一次会改状态的工具调用」，不是「一个任务」，所以单步
  任务里只要落到 `shell`/`make`/发布类就弹窗。现在 `isReadOnlyShell` 放行一类明确只读的
  命令：`ls`/`cat`/`head`/`tail`/`wc`/`grep`/`rg`/`find`/`pwd`/`stat`/`file`/`du`/`which`/`diff`
  以及 `git status|diff|log|show|rev-parse|ls-files|blame|describe|shortlog`，前提是命令里
  没有 `; | & > < $ 反引号` 与换行。写危险项仍拦：`find -delete`/`-exec` 等写标记、
  `.env`（`.env.example` 除外）/`.ssh`/`id_rsa`/`.pem` 等凭据路径、以及一切不在白名单的
  程序（`mkdir`/`rm`/`sort -o`/`sudo`）。`make` 工具同理：只有 `check`/`test-gateway`/
  `frontend-test`/`shell-vars-check`/`sidecar-syntax-check`/`tools-lume-check`/`logs` 等
  验证目标免审（且不许带 `extraArgs`），`build`/`up`/`down`/`sync-enums`/重启类仍拦；
  通过 shell 写的 `make -C dir check` 也按同一份目标清单放行，`-j4`/`-f`/`VAR=…` 一律拦。
  校验：`make check` 里的 `sidecar/approval.test.js`
  （13 例，含 15 条该跑与 15 条该拦的命令清单、以及 make 目标正反两列）。
- **用户明确意图预授权**：当用户自己的消息既写了动作又点了对象（例如「把 resolve-lume
  的**归档**吧」），`article-archive` 这一次调用不再弹窗——人已经在模型提出之前授权了同一件事。
  只对**可撤销的本地动作**生效：发布类（WordPress / 掘金 / 微信 / SF）永远要点击；项目用
  **位置编号**（`"7"`）时仍然弹窗，因为编号每次都在变。审计日志打
  `[approval-gate] tool=article-archive auto-approved by explicit user intent`。
  桥接调用带的 session 与活跃流对不上时，仅当**只有一条**活跃对话流才回退用它的用户消息，
  避免借用另一条会话的同意。
- **导出脱敏**：会话 Markdown / 单条复制 / JSON / job 诊断日志统一走 `export.ts` 的
  `exportText()` —— 绝对路径剥掉系统前缀与账户名后只留末 3 段（短路径也不带用户名）、
  `sk-` / `ghp_` / `Bearer` 等凭据形态掩码、单段文本截断 3000 字。之前只有 `jobToLog`
  有本地截断，JSON 导出是裸 `JSON.stringify(chat.messages)`，会把完整工具结果与宿主路径
  带出去。校验：`make check` 里的 `frontend/src/export.test.mjs`（11 个用例）。
- 与旧设计（`legacy/host-sidecar/`）相比：修复了「全量 env 透传」与
  「detached 子进程无人看管、崩了无声死掉」两个已知缺陷。

## 相关文章
- [Resolve-Lume：基于最小权限原则的 Agent Runtime 分层架构](https://erishen.cn/resolve_lume/)
