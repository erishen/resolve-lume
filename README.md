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
| **react** (Vite) | 前端 | 静态 SPA，由容器内 Node 服务 `frontend/server-entrypoint.mjs` 托管（CSP、安全头、SSE 超时、token 注入都在这里），反代 `/react` 与 `/api`；**镜像内没有 nginx**，`nginx.conf` 仅为退役参考 |
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
├── .gitmodules              # agent-httpd / lume-core 两个子模块
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
    ├── server-entrypoint.mjs # 真正生效的静态服务 + /api、/react 反代（CSP、Origin/Host 校验、token 注入、SSE 无超时）
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
| 会话管理 UI / MCP 管理 UI | ⚠️ 部分 | 会话已持久化 + 侧栏可用；MCP 面板目前只读展示 |
| 工作区分析 / VNC 桌面登录 / skills / usage | ⚠️ 部分 | skills/usage/workspace 已实现（souls 扫描 + `/api/usage` + `scanWorkspace`）；tasks-match 仅关键词匹配；VNC 桌面登录未启用 |
| Python PSE 框架 (autogen/crewai/…) | ⚠️ 共享依赖 | 两端都 `uv run python run.py` 调起，谁都替代不了 |

## 快速开始

```bash
cd work/harness/resolve-lume

# 1. 初始化子模块（agent-httpd / lume-core）
make setup
#    或：git submodule update --init --recursive

# 2. 配置 LLM 网关（不填 key 也能跑：自动回落离线 demo 引擎）
cp .env.example .env
#    编辑 .env 填入 LLM_API_KEY（可选）

# 3. 起两个容器（backend + frontend，构建后等 /api 就绪）
make start
#    等价于 make up（compose build + up -d）+ make wait（轮询 /api/tools 直到通）
#    注意：make start 不含 sidecar —— sidecar 是宿主常驻进程，见下一步。

# 4. 拉起宿主 sidecar（launcher :3099 守护 + sidecar :3000）
make sidecar-host-start
#    状态速查：make sidecar-host-status
#
# 其他常用：
#   make wait                 # 只等容器就绪（容器 Up ≠ 可用）
#   make logs                 # 跟踪两个容器日志（sidecar 日志在 .data-sidecar/）
#   make frontend-up          # 只重建前端容器
#   make sidecar-host-stop    # 停宿主 sidecar + launcher
#   make down                 # 停两个容器（不影响宿主 sidecar）

# 5. 打开 http://127.0.0.1:18085
#    浏览器 → frontend → sidecar → backend
```

本地开发前端（热更新，绕过 docker）：

```bash
cd frontend
npm install --registry https://registry.npmmirror.com
npm run dev   # :5173，已配 /react 反代到 backend:8080
```

> **设计说明**：sidecar 跑在宿主（非容器），直接复用宿主工具链、读写宿主真实项目路径，
> 无需 bind mount / `host.docker.internal` 跨界。早期版本曾把它容器化（`sidecar/Dockerfile`
> 存档），代价是工具链要在镜像里重装、且容器访问宿主 loopback 在原生 Linux 上不成立；
> 现在回归宿主常驻，backend/frontend 仍保持容器。详见下方 [「宿主 sidecar 模式」](#宿主-sidecar-模式sidecar-跑在-macos-宿主而非容器)。

## 配置说明

- **`.env`**：`LLM_API_URL/LLM_API_KEY/LLM_MODEL` 走 OpenAI 兼容；`PSE_ENABLED` 已不再生效——
  PSE 由前端「🧩 PSE」开关控制（sidecar 据此把 `/api/chat` 转发到 `/react/api/pse` 或 `/react/api/chat`），
  容器的 `PSE_ENABLED` 固定为 `false`，否则普通 chat 路由也会被强制跑 PSE、开关失效。
- **`souls/<role>/SOUL.md`**：改角色分工无需重建镜像（已 bind mount）。
- **`lume-tools/tools.lume`**：用 `tool "name","desc",{params},(p)=>{...}` 定义工具；改完重启 backend 容器即可被 agent-httpd 重新 harvest。
- **`deploy/mcp-servers.json`**：加 `"id"/"command"/"args"` 条目即可接入新 MCP server（如 git/memory/think）。

## 契约差异（前端对接要点）

agent-httpd 的 API 与 resolve-studio 的 `/api/*` **不同**：

- 聊天：`POST /react/api/chat`（或 `/react/api/pse`），body `{message, history?}`，**无 `sessionId` 也能跑**（仅关记忆）。
- SSE：`data: {"t":"delta"|"note"|"error"|"done","d":"..."}`——**只有 `data:` 行，类型在 JSON 的 `t` 字段**（resolve-studio 用 `event:` 行）。
- 工具：`GET /react/api/tools` 返回 `{tools:[{name,server,desc}]}`；调用名是 `<serverId>__<toolName>`。
- frontend 的 Node 反代 `/react` **必须保留原始 `Host` 头**（不要改写成上游地址），否则后端同源校验返回 403。

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
| 生命周期 | `restart: unless-stopped`，开机自启 | launcher 是 nohup 进程，重启电脑后需手动起 |
| 启动 | 需自行在 compose 加回 sidecar service | `make sidecar-host-start` |
| compose 现状 | **已移除该服务** | 由 launcher 守护，不经 compose 管理 |

### 启停命令

```bash
# 前提：backend + frontend 容器保持运行（agent-httpd 已发布到 127.0.0.1:8080）
docker compose up -d backend frontend
# 注：compose 现已无 sidecar 服务，无需再 `docker compose rm -sf sidecar`；
#     若你曾手动加回过容器 sidecar，先停它再继续（两边都监听 3000 会冲突）。

# 启动 launcher（:3099 控制面）+ sidecar（:3000）
make sidecar-host-start

# 状态速查（launcher/sidecar 存活、两端 /health、3000 是否被容器抢占）
make sidecar-host-status

# 停止（launcher 的 SIGTERM 处理会连带停掉 sidecar 子进程并清 pidfile）
make sidecar-host-stop

# 回切容器模式（需先在 docker-compose.yml 重新加回 sidecar service 定义）
make sidecar-host-stop && docker compose up -d sidecar
```

### 组件与控制面

- `sidecar/start-host.sh`：宿主执行入口。显式 export 一份 env 白名单
  （PORT=3000 / HOST=127.0.0.1 / AGENT_HTTPD_URL=127.0.0.1:8080 /
  LLM_API_URL=127.0.0.1:19070 等），写 pidfile 后 `exec node sidecar/server.js`。
- `sidecar/launcher.js`：守护进程（纯 Node 内置模块），监听 `127.0.0.1:3099`，
  提供 `GET /health`、`GET /status`、`POST /start`、`POST /stop`。
  目前前端未接 `/launcher` 反代，控制面主要由上面的 make 目标调用。

### 崩溃重拉与限制

- sidecar 是 launcher 的**直接子进程**（非 detached）：sidecar 崩溃且非用户主动
  停止时，launcher 2 秒退避后自动重拉。
- **重试上限：连续崩溃最多 5 次**，之后 launcher 放弃重拉并在
  `.data-sidecar/launcher.log` 写明原因，等待人工排查 sidecar.log 后再
  `POST /start`（或 `make sidecar-host-stop && make sidecar-host-start`）。
  sidecar 若连续稳定运行超过 30 秒，重试预算清零（健康跑过后的偶发崩溃不计数）。
- **launcher 自身没有看门狗**：launcher 崩了 = 需要手动 `make sidecar-host-stop`
  清残留 pidfile 后重新 `make sidecar-host-start`。开机自启（含 launcher）需要
  自己配 launchd，见下。

### launchd 开机自启（可选；先给 make 命令，需要常驻时再配）

将以下 plist 放到 `~/Library/LaunchAgents/com.erishen.resolve-lume.launcher.plist`，
`launchctl load` 即可。配置时把 `ProgramArguments` 指向本机 node 与本仓库绝对路径：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.erishen.resolve-lume.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/&lt;you&gt;/Workspace/CNB/<workspace>/work/harness/resolve-lume/sidecar/launcher.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/&lt;you&gt;/Workspace/CNB/<workspace>/work/harness/resolve-lume</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAUNCHER_AUTOSTART</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/&lt;you&gt;/Workspace/CNB/<workspace>/work/harness/resolve-lume/.data-sidecar/launcher.log</string>
</dict>
</plist>
```

> 配了 launchd 后不要再用 `make sidecar-host-start` 的 nohup 分支，避免双开抢 3099。

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
  `openssl rand -hex 32`；改值后须同时重启 frontend 容器、backend 容器与宿主 sidecar。
- 安全边界：`/api/tools/call`（Agent 桥）按 `lume-tools/sidecar_ro.lume` 的开放名单做
  服务端硬校验；`/api/file`、`/api/raw` 与文件类工具拒绝 `.env` / 私钥 / 凭据，即便它们
  位于 FS_ROOTS 之内。前端面板仍可手动运行全部已实现工具（本地操作者有意保留）。
- 与旧设计（`legacy/host-sidecar/`）相比：修复了「全量 env 透传」与
  「detached 子进程无人看管、崩了无声死掉」两个已知缺陷。
