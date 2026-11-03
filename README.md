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
| **react** (Vite) | 前端 | 静态 SPA，由 `nginx:alpine-slim` 托管，反代 `/react` 到 backend |

## 架构

```
浏览器 ── :18080 ──► nginx:alpine-slim (frontend 容器)
                        │  /            → 静态 SPA (dist)
                        │  /react/*     ──proxy_pass──► agent-httpd :8080 (backend 容器)
                        │                                  │
                        │                                  ├─ PSE 编排 (planner→specialist→evaluator)
                        │                                  ├─ MCP client
                        │                                  │     └─► lume-core --mcp (同容器内子进程)
                        │                                  │            └─► tools.lume 里的自定义工具
                        │                                  └─ LLM (OpenAI 兼容 /chat/completions)
```

- backend **只对内网暴露**（compose 内部网络），浏览器只接触 frontend。
- `PSE_SOULS_DIR=/app/souls` 指向三个角色定义；`/data/mcp-servers.json` 注册 MCP server。

## 目录结构

```
resolve-lume/
├── .gitmodules              # agent-httpd / lume-core 两个子模块
├── docker-compose.yml       # backend + frontend 两服务
├── Dockerfile.backend       # 多阶段：构建 agent-httpd + lume-core → node:24 运行时
├── Makefile                 # setup / build / up / down / logs
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
└── frontend/                # Vite + React 聊天前端
    ├── src/{api.ts,App.tsx,types.ts,main.tsx,styles.css}
    ├── nginx.conf           # SPA + /react 反代 (SSE buffering off)
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
| **后台 job 持久化 / 续跑 (node:sqlite)** | ❌ 待办 | lume 无 jobs DB，长任务可靠性需自建 |
| **shell / write_file 内置工具** | ❌ 待办 | lume 仅 7 个内置工具，需补或经 MCP 接入 |
| 会话管理 UI / MCP 管理 UI | ❌ 待办 | 前端仅 localStorage 侧栏雏形 |
| 工作区分析 / VNC 桌面登录 / skills / usage | ❌ 待办 | 属 resolve-studio 外围，需增量补齐 |
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

# 3. 构建并启动
make up
#    等价于：docker compose build && docker compose up -d

# 4. 打开 http://127.0.0.1:18080
```

本地开发前端（热更新，绕过 docker）：

```bash
cd frontend
npm install --registry https://registry.npmmirror.com
npm run dev   # :5173，已配 /react 反代到 backend:8080
```

## 配置说明

- **`.env`**：`LLM_API_URL/LLM_API_KEY/LLM_MODEL` 走 OpenAI 兼容；`PSE_ENABLED=true` 让 `/react/api/chat` 也走 PSE。
- **`souls/<role>/SOUL.md`**：改角色分工无需重建镜像（已 bind mount）。
- **`lume-tools/tools.lume`**：用 `tool "name","desc",{params},(p)=>{...}` 定义工具；改完重启 backend 容器即可被 agent-httpd 重新 harvest。
- **`deploy/mcp-servers.json`**：加 `"id"/"command"/"args"` 条目即可接入新 MCP server（如 git/memory/think）。

## 契约差异（前端对接要点）

agent-httpd 的 API 与 resolve-studio 的 `/api/*` **不同**：

- 聊天：`POST /react/api/chat`（或 `/react/api/pse`），body `{message, history?}`，**无 `sessionId` 也能跑**（仅关记忆）。
- SSE：`data: {"t":"delta"|"note"|"error"|"done","d":"..."}`——**只有 `data:` 行，类型在 JSON 的 `t` 字段**（resolve-studio 用 `event:` 行）。
- 工具：`GET /react/api/tools` 返回 `{tools:[{name,server,desc}]}`；调用名是 `<serverId>__<toolName>`。
- nginx 反代 `/react` **必须** `proxy_set_header Host $host`，否则后端同源校验返回 403。

## 已知限制 / 路线图

1. **长任务可靠性**：缺 job 持久化与续跑，长任务（如文章撰写）中断即丢失——需补一层 SQLite/文件队列。
2. **工具面**：lume 内置工具少，resolve-studio 的 ~37 个业务工具需逐步用 `.lume` 或 MCP server 重表达。
3. **前端外围**：会话/MCP/工作区/VNC 面板待补齐（建议做成独立视图，复用 `/react/api/*`）。
4. **Python 大脑**：autogen/crewai/langgraph/llamaindex 仍是外部 `uv run` 依赖，迁移不变。

> 本仓库遵循「打开即用、可改可跑」：核心链路（聊天 + PSE + MCP + 工具）已可运行，
> 外围功能按上面路线图增量补齐，而非一次性堆空壳。
