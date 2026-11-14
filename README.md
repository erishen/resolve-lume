> English documentation. 中文文档：[README.zh.md](./README.zh.md)

# resolve-lume

Rebuild the core capabilities of [resolve-studio](../../harness/resolve-studio) on the **lume + lume-core + react** stack.

> Key background: lume's `agent-httpd` is itself a **C port of resolve-studio's backend** (its source comment literally says *"port of resolve-studio's McpService / session-store / runPseOrchestrator, C edition"*). So this project is not a from-scratch rewrite—it finishes that port into a **standalone, zero-Node-runtime-dependency** product: the backend is lume's single C binary, custom tools use lume-core `.lume` scripts, and the frontend uses React.

## Tech Stack & Responsibilities

| Component | Role | Notes |
|---|---|---|
| **lume** (`agent-httpd`) | Backend runtime | Single C binary with a built-in ReAct agent loop + PSE three-role orchestration + MCP client + SSE. ~1.7 MB, **no Node, no nginx dependency** |
| **lume-core** | Custom tool provider | Exposes `tool {}` blocks from `.lume` scripts as an MCP server in `--mcp` mode, pulled by agent-httpd |
| **react** (Vite) | Frontend | Static SPA served by the in-container Node service `frontend/server-entrypoint.mjs` (CSP, security headers, SSE timeout, and token injection all live here), proxying `/react` and `/api`; **no nginx inside the image**—`nginx.conf` is only a retired reference |
| **sidecar** (Node) | Gateway + functional backend + tool execution layer | A host macOS resident process (not a container), listening on `127.0.0.1:3000`, supervised by `launcher.js`(:3099); reuses the host's installed node/python3/uv/make toolchain and reads/writes the host's real project paths |

## Architecture

```
Browser ── :18085 ──► frontend container (node server-entrypoint.mjs)
                        │  /            → static SPA (dist)
                        │  /react/*     ──proxy──────► backend container :8080      (compose internal network)
                        │  /api/*       ──proxy──────► host.docker.internal:3000
                        │                                      │
                        │                                      ▼
                        │                          host sidecar process (Node, 127.0.0.1:3000)
                        │                           ├─ built-in tools (read/write/shell/make/stock-scan…)
                        │                           │    reads/writes host real project paths directly (no container mount)
                        │                           └─ proxies /chat /pse /tools → 127.0.0.1:8080
                        │                                  │
                        │                                  ▼
                        │                          backend container (agent-httpd)
                        │                           ├─ PSE orchestration (planner→specialist→evaluator)
                        │                           ├─ MCP client → lume-core --mcp (in-container subprocess)
                        │                           └─ LLM (OpenAI-compatible /chat/completions)
```

- The **two compose containers (backend + frontend)** are managed with `restart: unless-stopped` + healthcheck; the **sidecar is a host resident process** (listening on `127.0.0.1:3000`), supervised by `launcher.js`(:3099) (crash backoff restart, max 5 attempts; the launcher itself has no watchdog and must be restarted manually or via launchd for boot autostart). `make start` only brings up the two containers and waits for `/api`—**it does not include the sidecar**; you must also run `make sidecar-host-start`.
- The backend is `expose`d on the compose internal network and additionally published to the host loopback at `127.0.0.1:8080` for the sidecar to call back; the browser only touches `frontend:18085`, and the frontend proxies to the host sidecar via `host.docker.internal:3000`.
- The sidecar reads/writes the host's real project paths directly (no bind mount / volume semantics), and its runtime data lands in the host's `.data-sidecar/` (jobs/sessions/pidfile/logs), so rebuilding containers does not lose it.
- `PSE_SOULS_DIR` points to the role definitions (already bind-mounted into the backend container); `MCP_SEED_FILE` registers MCP servers.

## Directory Structure

```
resolve-lume/
├── agent-httpd/             # vendored: GitHub release v0.12.1 (C backend)
├── lume-core/              # vendored: GitHub release v0.13.1 (.lume tools)
├── docker-compose.yml       # backend + frontend containers (sidecar is a host process, not via compose)
├── Dockerfile.backend       # multi-stage: build agent-httpd + lume-core → debian runtime
├── Makefile                 # setup / build / up / wait / start / down / logs
├── .env.example             # LLM gateway + PSE switches
├── deploy/
│   ├── backend-entrypoint.sh
│   └── mcp-servers.json     # MCP registry (lume-tools bridge)
├── souls/                   # PSE three-role SOUL.md (ported from resolve-studio semantics)
│   ├── planner/SOUL.md
│   ├── specialist/SOUL.md
│   └── evaluator/SOUL.md
├── lume-tools/
│   └── tools.lume           # custom .lume tools (exposed via lume-core --mcp)
├── www/                     # agent-httpd docroot placeholder
├── sidecar/                 # gateway + functional backend + tool execution layer (host resident process)
│   ├── server.js / agent.js / store.js / builtin-exec.js / builtin-tools.json
│   ├── Dockerfile           # for container mode; currently unused in host mode (compose removed sidecar service)
│   └── package.json
├── legacy/host-sidecar/     # retired host launcher/sidecar (archived only, not run)
└── frontend/                # Vite + React chat frontend
    ├── src/{api.ts,App.tsx,types.ts,main.tsx,styles.css}
    ├── vite.config.ts       # dev proxy (/api→sidecar:3000 injects token, /react→backend:8080 keeps Host)
    ├── server-entrypoint.mjs # the real static server + /api, /react proxy (CSP, Origin/Host checks, token injection, no SSE timeout)
    ├── nginx.conf           # ⚠️ retired reference NOT used by Dockerfile; don't debug against it
    └── Dockerfile
```

## Feature Mapping vs resolve-studio

| resolve-studio capability | resolve-lume status | Notes |
|---|---|---|
| PSE three-role orchestration (Planner/Specialist/Evaluator) | ✅ covered | agent-httpd `pse.c` directly ported; SOUL.md ported |
| ReAct tool loop + SSE streaming chat | ✅ covered | `/react/api/chat` + `/react/api/pse` |
| MCP client (git/memory/think, etc.) | ✅ mechanism covered | just add an entry in `mcp-servers.json`, includes lume-tools bridge |
| Custom tools (lume-core `.lume`) | ✅ demo-grade | `lume-tools/tools.lume` with 5 example tools |
| Session memory (JSON) | ✅ in backend | requires a server-minted sessionId from `/login` to enable |
| Frontend chat UI | ✅ basic | streaming render + PSE switch + tool list |
| **Background job persistence / resume** | ✅ covered | sidecar `/api/jobs` persists to SQLite (`node:sqlite`, WAL, O(1) incremental event inserts, transactional); cancel interrupts upstream, resume carries history |
| **shell / write_file built-in tools** | ✅ covered | sidecar runs 11 tools locally (read/write/shell/make/analyze-dir/privacy-audit/stock-scan…), schema and implementation share one source |
| Session management UI / MCP management UI | ⚠️ partial | sessions persisted + sidebar usable; MCP panel currently read-only |
| Workspace analysis / VNC desktop login / skills / usage | ⚠️ partial | skills/usage/workspace implemented (souls scan + `/api/usage` + `scanWorkspace`); tasks-match is keyword-only; VNC desktop login not enabled |
| Python PSE framework (autogen/crewai/…) | ⚠️ shared dependency | both sides launch via `uv run python run.py`; neither can replace it |

## Quick Start

```bash
cd work/harness/resolve-lume

# 1. Pull vendored deps (agent-httpd v0.12.1 / lume-core v0.13.1 from GitHub release)
make setup
#    or: bash scripts/vendor_repos.sh && bash scripts/vendor_lume_bin.sh

# 2. Configure the LLM gateway (runs without a key too: auto-falls back to an offline demo engine)
cp .env.example .env
#    edit .env and fill in LLM_API_KEY (optional)
#    ⚠️ REQUIRED: set SIDECAR_TOKEN to a random value (the template has it empty;
#       if left empty, frontend / backend / sidecar / launcher all fail-closed and refuse to start):
openssl rand -hex 32      # copy the output and put it after SIDECAR_TOKEN= in .env

# 3. Bring up the two containers (backend + frontend, wait for /api after build)
make start
#    equivalent to make up (compose build + up -d) + make wait (poll /api/tools until reachable)
#    note: make start does NOT include the sidecar — the sidecar is a host resident process, see next step.

# 4. Start the host sidecar (recommended: hand it to launchd — autostart on login + respawn)
make sidecar-autostart-install
#    temporary/debug mode (dies with the launching shell session): make sidecar-host-start
#    status quick-check: make sidecar-autostart-status / make sidecar-host-status
#
# Other common commands:
#   make wait                 # only wait for containers ready (container Up ≠ usable)
#   make logs                 # tail both container logs (sidecar logs in .data-sidecar/)
#   make frontend-up          # only rebuild the frontend container
#   make sidecar-host-stop    # stop host sidecar + launcher (manual mode only)
#   make sidecar-autostart-restart    # restart after changing sidecar/ sources
#   make sidecar-autostart-uninstall  # remove launchd residency and stop sidecar
#   make down                 # stop the two containers (does not affect host sidecar)
#   make check                # static checks: tool-bridge constraints + four-list consistency + gateway/SSE/export regressions + shell var compat
#   make frontend-build-check  # frontend tsc --noEmit + vite build (requires frontend/node_modules)

# 5. Open http://127.0.0.1:18085
#    browser → frontend → sidecar → backend
```

Local frontend development (hot reload, bypassing docker):

```bash
cd frontend
npm install --registry https://registry.npmmirror.com
npm run dev   # :5173
```

`vite.config.ts`'s proxy is the **only effective proxy config in dev mode** (production is handled by the in-container `server-entrypoint.mjs`):

| Path | Default target | Notes |
|---|---|---|
| `/api/*` | `127.0.0.1:3000` host sidecar | Vite injects `X-Sidecar-Token` on the Node side (read from repo-root `.env`, **never enters the browser bundle**); a client-supplied header of the same name is stripped then force-overwritten |
| `/react/*` | `127.0.0.1:8080` backend | `changeOrigin:false` keeps the original `Host`, otherwise the backend's same-origin check returns 403 |

Both chains set `timeout/proxyTimeout = 0`, so minute-long SSE tasks are not cut off.
**Prerequisite**: the host launcher + sidecar must already be running (`make sidecar-host-start`); the frontend / backend containers are not strictly required. To change targets, set `VITE_API_TARGET` / `VITE_BACKEND_TARGET` in the repo-root `.env` or shell (e.g. point `/api` to an already-running `http://127.0.0.1:18085`).
An old config pointed at the non-existent `:8787` (web-server plugin), so all dev requests would 502.
When probing localhost addresses, remember to use `curl --noproxy '*'`, otherwise your local proxy intercepts them.

> **Design note**: the sidecar runs on the host (not in a container), directly reusing the host toolchain and reading/writing the host's real project paths, without bind mount / `host.docker.internal` crossing. An earlier version containerized it (`sidecar/Dockerfile` archived), at the cost of reinstalling the toolchain in the image and the fact that a container reaching the host loopback does not hold on native Linux; now it's back to a host resident process while backend/frontend stay containerized. See [Host Sidecar Mode](#host-sidecar-mode-sidecar-runs-on-the-macos-host-not-in-a-container) below.

## Configuration

- **`.env`**: `LLM_API_URL/LLM_API_KEY/LLM_MODEL` are OpenAI-compatible; `PSE_ENABLED` no longer takes effect—PSE is controlled by the frontend "🧩 PSE" switch (the sidecar forwards `/api/chat` to `/react/api/pse` or `/react/api/chat` accordingly), and the container's `PSE_ENABLED` is fixed to `false`, otherwise the normal chat route would also be forced through PSE and the switch would be useless.
- **`.dockerignore`**: both the repo root and `frontend/` exclude `.env` / `.env.*`, preventing local secrets from being baked into the image by `COPY . .` (in dev mode `.env` is read only by Vite's Node side and never enters the browser bundle; see `ARCHITECTURE.zh.md` sections 7 and 8).
- **`souls/<role>/SOUL.md`**: changing role division requires no image rebuild (already bind-mounted).
- **`lume-tools/tools.lume`**: define tools with `tool "name","desc",{params},(p)=>{...}`; after editing, restart the backend container and agent-httpd will re-harvest them.
- **`deploy/mcp-servers.json`**: add an `"id"/"command"/"args"` entry to plug in a new MCP server (e.g. git/memory/think).

## Contract Differences (Frontend Integration Notes)

agent-httpd's API is **different** from resolve-studio's `/api/*`:

- Chat: `POST /react/api/chat` (or `/react/api/pse`), body `{message, history?}`, runs **even without `sessionId`** (only memory is off).
- SSE: `data: {"t":"delta"|"note"|"error"|"done","d":"..."}`—**only `data:` lines, the type is in the JSON `t` field** (resolve-studio uses `event:` lines).
- Tools: `GET /react/api/tools` returns `{tools:[{name,server,desc}]}`; the call name is `<serverId>__<toolName>`.
- The frontend's Node proxy for `/react` **must preserve the original `Host` header** (do not rewrite it to the upstream address), otherwise the backend's same-origin check returns 403.
- **SSE client strategy**: `/api/chat` and `/api/tool/run` are POST and non-idempotent—on disconnect they **do not auto-resend** (resending would rerun the whole Agent and burn tokens redundantly); when the stream ends without a `done`/`error`, it explicitly reports "connection interrupted, result may be incomplete" while keeping what was already received. The Stop button's `AbortSignal` applies to both the chat and tool-retry streams and actively calls `reader.cancel()` to release the connection.
- **A terminal frame IS EOF (never wait for HTTP EOF)**: on `done`/`error`, `readFrames` immediately calls `reader.cancel()` so `streamChat` settles. `useChat` clears `busy` only in `send`'s `finally`, so tying composer re-enable to HTTP EOF let a proxy keep-alive socket (or a sidecar restart leaving a dangling response) wedge the UI at "Agent is thinking…" with the answer already rendered — reproduced with a response that emits `done` but never closes. `STREAM_IDLE_TIMEOUT_MS` (5 min) is the silent-stream backstop; the `matchTask` pre-flight has a 5s timeout and shares the same `AbortSignal` so Stop works before the stream starts.
- **Live progress for long-running tools**: a conversational tool call (`agent-httpd → /api/tools/call`) is one blocking JSON POST; C emits no SSE frame while it waits, so a 15-minute `article-write` looked frozen. `sidecar/progress.js` now bridges this: `agent.proxySSE` registers the live chat `res`, `executeBuiltinTool` passes an emitter down to `spawnCapture` via `AsyncLocalStorage` (business tools need no signature change), and child stdout/stderr becomes `event: reasoning` frames after line reassembly, ANSI/credential scrubbing, 700ms throttling and a 160-line quota. The frontend already renders `reasoning` in the Thinking panel, so the protocol is unchanged; `/api/tool/run` writes progress directly to its own SSE response. **Progress is injected only when exactly one chat stream is active** — with concurrent chats it is dropped rather than leaked across conversations (exact runId correlation would require changing C and the `.lume` bridge). Progress frames also re-arm the 5-minute idle watchdog, and buffered progress is flushed before any `done`/`error` frame. Validation: `sidecar/progress.test.js` (13 cases) in `make check`.
- **Guard rails against tool wandering (active even with no task selected)**: the bridge exposes 24 tools across six unrelated domains, and the usual mode is `taskMode=auto` (no task soul, no tool allow-list). On 2026-11-06 an `article-write` failure made the model switch to the whole `hot-news` pipeline and re-run it four times with byte-identical args, exhausting all 8 rounds without any final text. `sidecar/chatBody.js` now injects a tool discipline into every chat run (one tool family per request, report failures honestly, never repeat identical args, pass list numbers through verbatim, always finish with a user-facing summary); `sidecar/toolGuard.js` refuses an identical call that failed within 120s and returns the previous error; `runPseTask` validates `--provider` against `free`/`deepseek` so a framework name such as `llamaindex-pse` no longer fails silently. C's stray-repeat guard only fires on rounds that also streamed content, so pure tool rounds need this sidecar layer. When `done` still arrives with no text, `agent.js` reports the tool trajectory (collapsing repeats to `hot-news x4`), the round budget and the last error instead of a bare "please retry". Validation: `chatBody.test.js` (6), `toolGuard.test.js` (7), `translateFrame.test.js` (7) in `make check`.
- **Publishing requires explicit user authorization**: `article-write(publish=true)` is allowed only when the *current chat message* explicitly says publish / 上线 / `publish` (the active stream carries `userMessage` in `progress.js`); replying with just a list number is refused by `/api/tools/call`. `publish.py` has a confirmation gate that cancels and exits 1 in a non-interactive shell — previously that turned an **already-written article** into a failed run, and the model then turned a stderr `DeprecationWarning` into "a small async event-loop issue". `translate.py` no longer exits for a failed optional publish, and `business-pse.js` recognises "articles on disk but non-zero exit" to report "generated / not published" honestly instead of unconditionally claiming `Auto-published`.
- **Progress noise and relevance evidence**: Python 3.13's `asyncio.get_event_loop()` is replaced by `get_running_loop()` and the progress publisher filters interpreter-level warnings, so harmless warnings are no longer framed as phase failures. The crewai-pse relevance gate now deduplicates the full path and suffix forms of the same source file into one piece of evidence, and requires **at least one real symbol or at least two distinct source files** — a generic essay can no longer pass by repeating the project name and citing one file twice.
- **The job stream is GET + append-only logs with a `seq`**, so it can auto-reconnect: `streamJob` uses exponential backoff (500ms → capped at 8s), receives a `snapshot` on each reconnect, and `useJobs` dedupes by `seq`; "connection interrupted, reconnecting" shows in the panel status, and reconnecting stops once the terminal snapshot arrives. Validation: `frontend/src/api.test.mjs` in `make check` (mock fetch stream, 15 cases).

## Known Limitations / Roadmap

1. **Long-task reliability** (resolved): job records now persist to SQLite (WAL + transactions + O(1) incremental event inserts), so a process crash loses no records and writes no truncation. Remaining advice: for very long tasks, still prefer job mode (event persistence + cancelable resume) over synchronous chat.
2. **Tool surface**: lume has few built-in tools; resolve-studio's ~37 business tools need to be gradually re-expressed as `.lume` or MCP servers.
3. **Frontend periphery**: workspace/usage/skills are implemented (simplified); tasks-match is keyword-only and needs enhancement; VNC desktop login is not enabled (suggested as a separate view reusing `/api/*`).
4. **Python brain**: autogen/crewai/langgraph/llamaindex remain external `uv run` dependencies; the migration is unchanged.

> This repo follows "open-and-use, editable-and-runnable": the core chain (chat + PSE + MCP + tools) already runs, and peripheral features are filled in incrementally per the roadmap above rather than piled up as empty shells at once.

## Host Sidecar Mode (sidecar runs on the macOS host, not in a container)

The sidecar is currently a resident process on the host macOS (listening on `127.0.0.1:3000`), while backend / frontend **stay containerized**; the frontend container's Node service reaches it via `host.docker.internal:3000`.
> Historically the sidecar ran as the third compose service (`sidecar/Dockerfile` still archived) but has been removed from `docker-compose.yml`—the "container sidecar" column in the table below is for reference only; you'd have to re-add the sidecar service definition to compose yourself to use it.

### Mode Selection

| | Container sidecar (retired) | Host sidecar (current) |
|---|---|---|
| sidecar location | compose container | host node process |
| Toolchain | node24/python3/uv/make inside container | directly reuses host-installed toolchain |
| Lifecycle | `restart: unless-stopped`, boots on start | manual nohup dies with its launching session; launchd mode = login autostart + KeepAlive |
| Startup | must re-add sidecar service in compose | `make sidecar-autostart-install` (recommended) / `make sidecar-host-start` (temporary) |
| compose status | **service removed** | supervised by launcher, not managed by compose |

### Start/Stop Commands

```bash
# Prerequisite: backend + frontend containers stay running (agent-httpd published to 127.0.0.1:8080)
docker compose up -d backend frontend
# Note: compose no longer has a sidecar service, no need to `docker compose rm -sf sidecar`;
#      if you previously re-added a container sidecar, stop it first (both listening on 3000 would conflict).

# [Recommended] launchd residency: generate plist -> register -> wait for :3000
make sidecar-autostart-install
#   In a restricted session `launchctl bootstrap` may return EIO; the script falls
#   back to nohup and tells you to re-run the same command in a local Terminal.

# [Temporary] manual mode: nohup launcher (:3099) + sidecar (:3000)
make sidecar-host-start

# Status quick-check
make sidecar-autostart-status   # launchd job + 3099/3000/18085 probes
make sidecar-host-status        # pidfiles + /health + whether 3000 is hijacked

# Stop: manual mode uses make sidecar-host-stop; under launchd KeepAlive brings
# the launcher straight back, so use uninstall / restart instead.

# compose has no sidecar service, so you cannot and need not "switch back to container mode".
# Restart after changing sidecar/:
make sidecar-autostart-restart              # launchd mode
# make sidecar-host-stop && make sidecar-host-start   # manual mode
```

### Components & Control Plane

- `sidecar/start-host.sh`: host execution entry. Explicitly exports an env allowlist (PORT=3000 / HOST=127.0.0.1 / AGENT_HTTPD_URL=127.0.0.1:8080 / LLM_API_URL=127.0.0.1:19070, etc.), writes the pidfile, then `exec node sidecar/server.js`.
- `sidecar/launcher.js`: supervisor (pure Node built-in modules), listening on `127.0.0.1:3099`, providing `GET /health`, `GET /status`, `POST /start`, `POST /stop`. The frontend does not yet proxy `/launcher`; the control plane is mainly driven by the make targets above. **`POST /start`, `POST /stop` require `X-Sidecar-Token` (same value as `.env`) and `Host`/`Origin` must be loopback; `GET /health`, `GET /status` are read-only and stay open.** `make sidecar-host-start` already sends the header automatically; manual curl example:
  ```bash
  TOK=$(awk -F= '/^SIDECAR_TOKEN=/{print substr($0,index($0,"=")+1)}' .env)
  curl --noproxy '*' -fsS -X POST -H "X-Sidecar-Token: $TOK" http://127.0.0.1:3099/stop
  curl --noproxy '*' -fsS -X POST -H "X-Sidecar-Token: $TOK" http://127.0.0.1:3099/start
  ```
  The launcher re-reads the token from `.env` on every control request, so rotating the token **does not require restarting the launcher**.

### Crash Restart & Limits

- The sidecar is a **direct child** of the launcher (not detached): when the sidecar crashes and it wasn't a user-initiated stop, the launcher auto-restarts it after a 2-second backoff.
- **Retry cap: at most 5 consecutive crashes**, after which the launcher gives up and writes the reason to `.data-sidecar/launcher.log`, waiting for manual sidecar.log investigation then `POST /start` with token (or `make sidecar-host-stop && make sidecar-host-start`). If the sidecar runs stably for more than 30 consecutive seconds, the retry budget resets (occasional crashes after a healthy run don't count).
- **Manual (nohup) processes die with the shell/agent session that launched them**: launcher and sidecar get SIGKILLed with no crash log, while the Docker-managed containers keep running. Every frontend `/api/*` call then returns `502 Proxy error: connect ECONNREFUSED <host-gateway>:3000` and the UI shows `failed to load runtime info: failed to load models: 502`. This has nothing to do with the LLM gateway or model config — check `make sidecar-host-status` first. **The fix is the launchd residency below.**
- **In manual mode the launcher itself has no watchdog**; under launchd, `KeepAlive` covers it.

### launchd Residency (recommended, one command)

`make sidecar-autostart-install` runs `scripts/install-launchd.sh`, which generates
`~/Library/LaunchAgents/com.erishen.resolve-lume.launcher.plist` with this machine's
absolute paths and registers it in `gui/$(id -u)`:

| Key | Effect |
|---|---|
| `LAUNCHER_AUTOSTART=1` | launcher spawns the sidecar immediately (switch reserved in `launcher.js` for this mode) |
| `RunAtLoad` + `KeepAlive` | login autostart + respawn on launcher crash — the watchdog manual mode lacks |
| explicit `PATH` | launchd's default PATH is only `/usr/bin:/bin`; without this, shell/uv/node tools fail with silent `ENOENT` |

The generated plist contains local absolute paths, is written only to
`~/Library/LaunchAgents/`, and is **never committed**. Before registering, the script
stops any leftover nohup launcher so the two don't fight over 3099.

> **Restricted sessions**: some agent / non-Aqua-bootstrap contexts get
> `Bootstrap failed: 5: Input/output error` from `launchctl bootstrap` (even for a
> minimal plist) — the plist is fine. The script prints a fallback notice and recovers
> via nohup; the plist is already in place and loads on next login. Re-run
> `make sidecar-autostart-install` in a local Terminal to register immediately.
> `plist-only` generates the plist without registering.

While managed, don't use `make sidecar-host-stop` (KeepAlive brings the launcher back).
Use `make sidecar-autostart-restart` after editing `sidecar/`, and
`make sidecar-autostart-uninstall` to remove residency.

### env Strategy (key difference from old design)

- **Explicit allowlist export**: `start-host.sh` only sets the env required to run, and never inherits the host shell's global dirty values (the old design passed `process.env` / parent shell env wholesale; the host's proxy, PATH, and toolchain version strings leaking into the sidecar were the main pitfall).
- **LLM_API_URL explicitly overridden** to `http://127.0.0.1:19070/v1/chat/completions` (host llm-router). The `host.docker.internal:19070` written in `.env` is only for containers; server.js's envloader semantics are "don't overwrite an existing env", so this export has the highest priority, and envloader only supplements `LLM_API_KEY` / `LLM_MODEL` / `SIDECAR_TOKEN`, etc.
- `SIDECAR_TOKEN` is not set here: it's read from `.env` by the envloader, sharing the same value as the `X-Sidecar-Token` injected into the frontend container and the backend tool bridge's `SIDECAR_TOOLS_AUTH` (all three must match).
- **`SIDECAR_TOKEN` is required and must be random**: the source / compose / `.env.example` no longer provide a default; if missing, frontend, sidecar, and compose all fail-closed and refuse to start. Generate with `openssl rand -hex 32`; after changing the value you must restart the frontend container, backend container, and host sidecar together (the launcher hot-reads `.env`, no restart needed).
- Security boundary: `/api/tools/call` (Agent bridge) does server-side hard validation against the allowlist in `lume-tools/sidecar_ro.lume`; `/api/file`, `/api/raw`, and file-type tools reject `.env` / private keys / credentials even if they are inside FS_ROOTS. The frontend panel can still manually run all implemented tools (intentionally kept for local operators).
- **make parameter injection guard**: `runMakeIn` applies a value allowlist to all `KEY=value` parameters (only plain CLI flags / slugs / paths / numbers), because GNU make expands `$(ARGS)` into the `/bin/sh` recipe; `;`, `$( )`, backticks, pipes, redirects, quotes, and newlines are all rejected. Covers all call sites like `dev-stats`'s `ARGS`, `article-*`'s `P=`, etc., so new business tools won't slip through.
- **Toolchain consistency**: when the schema (`builtin-tools.json`), allowlist (`DEFAULT_ALLOW`), generated bridge (`sidecar_ro.lume`), and real implementation (`BUILTIN_NAMES`) drift, the sidecar **refuses to start**, avoiding the previous "model thought the gateway didn't mount article-write". Validation: `make check` (includes `consistency.js` and `consistency.test.js`); for local generation debugging you can temporarily set `ALLOW_TOOL_DRIFT=1`.
- `/api/approval` currently has no gated tool to unlock: the endpoint validates `decision` / `callId`, logs an audit entry, and explicitly returns `applied:false`, no longer pretending that the user clicking "approve" actually changed execution.
- **Export sanitization**: session Markdown / single-copy / JSON / job diagnostic logs all go through `exportText()` in `export.ts`—absolute paths strip the system prefix and account name leaving only the last 3 segments (short paths also drop the username), credential shapes like `sk-` / `ghp_` / `Bearer` are masked, and a single text segment is truncated to 3000 chars. Previously only `jobToLog` had local truncation, and JSON export was a bare `JSON.stringify(chat.messages)` that would leak complete tool results and host paths. Validation: `frontend/src/export.test.mjs` in `make check` (11 cases).
- Compared with the old design (`legacy/host-sidecar/`): fixed the two known defects of "wholesale env passthrough" and "detached child process with no supervision, crashing silently".

## Related Articles
- [Resolve-Lume: Least-Privilege Agent Runtime](https://erishen.cn/resolve_lume-en/)
