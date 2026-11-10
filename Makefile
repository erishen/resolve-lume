# resolve-lume 便捷命令
# 首次使用：make setup  （拉取 agent-httpd / lume-core 的 vendored 源码 + lume framework 二进制）

# BUILDX_CONFIG 指向项目内缓存, 绕过 macOS/OrbStack 下 ~/.docker/buildx 的权限问题
# (docker compose build 会报 rename .../activity/... operation not permitted)。
# 用 ?= 默认值, shell 里若已 export BUILDX_CONFIG 则尊重之(CI 可覆盖)。
BUILDX_CONFIG ?= $(CURDIR)/.data/buildx
export BUILDX_CONFIG

# 五座 MCP 桥归 tsm-hub 管（2026-11-09 收归），这里的 mcp-bridges-* 只是转发。
TSM_HUB_DIR ?= ../../golang/tsm-hub

setup:
	@bash scripts/vendor_repos.sh
	@bash scripts/vendor_lume_bin.sh

# vendored 源码（agent-httpd/、lume-core/）不入库，每次 build 前把本地必要的补丁
# 打回去（幂等）。补丁清单与原因见 scripts/patch_vendored_sources.sh 的头部注释，
# 以那里为唯一事实源——别在这里重复列举，否则会像早前那句「目前只有…」一样过期。
# 注意：只有走 make build / make up 才打补丁；单独 `docker compose build` 不跑它。
build: setup
	@bash scripts/patch_vendored_sources.sh
	docker compose build

# 起两个容器（backend + frontend）。sidecar 是宿主常驻进程，不在此命令内——
# 需另跑 `make sidecar-host-start`（临时）或 `make sidecar-autostart-install`（常驻，推荐）。
# restart: unless-stopped 负责容器开机自启与崩溃重拉。
up: build
	docker compose up -d

# 等 /api 真正可用（容器 Up ≠ 可用：健康检查与反代链路都要通）。
wait:
	@curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3000/health >/dev/null 2>&1 \
		|| echo "(提示: 宿主 sidecar :3000 未响应，/api/* 会全部 502 —— 见 make sidecar-host-start)"
	@printf "waiting for http://127.0.0.1:18085 "
	@i=0; \
	until curl --noproxy '*' -fsS -m 2 http://127.0.0.1:18085/api/tools >/dev/null 2>&1; do \
		i=$$((i+1)); \
		if [ $$i -ge 90 ]; then \
			echo ""; echo "timed out after 90s"; \
			if ! curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3000/health >/dev/null 2>&1; then \
				echo "✗ 根因: 宿主 sidecar (:3000) 没在跑，frontend 反代 /api/* 才会 502"; \
				echo "  临时恢复: make sidecar-host-start"; \
				echo "  常驻根治: make sidecar-autostart-install"; \
			else \
				echo "· sidecar :3000 通但 /api/tools 不通，检查容器日志: make logs"; \
			fi; \
			docker compose ps; exit 1; \
		fi; \
		printf "."; sleep 1; \
	done; echo ""; echo "ready: http://127.0.0.1:18085"

# 一条命令起两个容器：build + up + 等就绪（不含宿主 sidecar，见 sidecar-host-start）。
start: up wait

down:
	docker compose down

logs:
	docker compose logs -f

# 仅重建前端（改了 frontend/ 后更快）
frontend-up:
	docker compose up -d --build frontend

# ================= MCP 桥（fs/fetch/git/memory/think） =================
# 五座 Streamable HTTP 桥单独一份 compose（容器名固定 mcp-*，与 tsm-hub 共用网络），
# 全都 restart: unless-stopped，宿主 Docker 重启后自动回来。改了 git 镜像用 --build。
# 五座 MCP 桥（fs / memory / think / fetch / git）统一在 tsm-hub 的 docker-compose.yml 里。
# 2026-11-09 起 lume 仓不再定义 MCP 容器，避免两仓 docker compose up 撞容器名：
#   cd work/golang/tsm-hub && docker compose up -d mcp-fs mcp-memory mcp-think mcp-fetch mcp-git
# 这里的 make 目标只做转发，防止有人照着旧文档去跑已经不存在的文件。
mcp-bridges-up:
	cd $(TSM_HUB_DIR) && docker compose up -d mcp-fs mcp-memory mcp-think mcp-fetch mcp-git

mcp-bridges-down:
	cd $(TSM_HUB_DIR) && docker compose stop mcp-fs mcp-memory mcp-think mcp-fetch mcp-git

mcp-bridges-logs:
	cd $(TSM_HUB_DIR) && docker compose logs -f --tail=50 mcp-fs mcp-memory mcp-think mcp-fetch mcp-git

# ================= 宿主 sidecar 模式 =================
# sidecar 是宿主 macOS 常驻进程（127.0.0.1:3000），只有 backend/frontend 在容器里。
# compose 里已没有 sidecar 服务，也就不存在「回切容器模式」；改 sidecar/ 后重启：
#   make sidecar-host-stop && make sidecar-host-start
# :3099 控制面的 /start /stop 需要 .env 里的 SIDECAR_TOKEN（本 Makefile 自动带 header，
# 手工 curl 须自己加 X-Sidecar-Token）。轮换 token 只需重启 frontend/backend/sidecar：
# launcher 每次请求热读 .env，无需重启。
# 生命周期限制：nohup 起的 launcher 属于拉起它的 shell/执行会话；会话被回收时
# launcher 与 sidecar 会被连带 SIGKILL（日志无崩溃记录），容器照常存活但 /api/*
# 全 502。常驻请用 `make sidecar-autostart-install` 交给 launchd，见下方小节。

# 拉起 launcher（:3099 控制面），就绪后 POST /start 拉起 sidecar（:3000）
sidecar-host-start:
	@mkdir -p .data-sidecar
	@if [ -f .data-sidecar/launcher.pid ] && kill -0 "$$(cat .data-sidecar/launcher.pid)" 2>/dev/null; then \
		echo "launcher already running (pid=$$(cat .data-sidecar/launcher.pid))"; \
	else \
		nohup node sidecar/launcher.js >> .data-sidecar/launcher.log 2>&1 & \
		echo "launcher started (pid=$$!)"; \
	fi
	@printf "waiting for launcher http://127.0.0.1:3099 "
	@i=0; \
	until curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3099/health >/dev/null 2>&1; do \
		i=$$((i+1)); \
		if [ $$i -ge 15 ]; then echo ""; echo "timed out — see .data-sidecar/launcher.log"; exit 1; fi; \
		printf "."; sleep 1; \
	done; echo " ok"
	@TOK=$$(awk -F= '/^SIDECAR_TOKEN=/{print substr($$0,index($$0,"=")+1)}' .env); \
	if [ -z "$$TOK" ]; then echo "✗ .env 缺少 SIDECAR_TOKEN（控制面已 fail-closed）" >&2; exit 1; fi; \
	curl --noproxy '*' -fsS -m 2 -X POST -H "X-Sidecar-Token: $$TOK" http://127.0.0.1:3099/start >/dev/null \
		&& echo "sidecar requested -> http://127.0.0.1:3000"
	@echo "frontend 入口: http://127.0.0.1:18085（若 502，确认容器 sidecar 已停、backend 容器在跑）"

# 停 launcher（其内部 SIGTERM 处理会连带停掉 sidecar 子进程）并清 pidfile
sidecar-host-stop:
	@# launchd 托管的 launcher 不写 launcher.pid，旧逻辑会打印「未启动？」然后静默空跑，
	@# 导致改了 sidecar/ 后 make stop && make start 其实什么都没重启。先识别 launchd。
	@if [ ! -f .data-sidecar/launcher.pid ] && launchctl list 2>/dev/null | grep -q com.erishen.resolve-lume.launcher; then \
		echo "launcher 由 launchd 托管（com.erishen.resolve-lume.launcher），本目标不适用。"; \
		echo "重启 sidecar 请用: make sidecar-host-restart"; \
		echo "彻底卸载自启请用: make sidecar-autostart-uninstall"; \
		exit 1; \
	fi
	@if [ ! -f .data-sidecar/launcher.pid ]; then echo "launcher.pid 不存在（未启动？）"; \
	else \
		LPID=$$(cat .data-sidecar/launcher.pid); \
		if kill -0 "$$LPID" 2>/dev/null; then \
			kill "$$LPID"; \
			printf "waiting for launcher pid=$$LPID "; \
			i=0; \
			while kill -0 "$$LPID" 2>/dev/null; do \
				i=$$((i+1)); \
				if [ $$i -ge 20 ]; then echo ""; echo "launcher 未退出，可手动 kill -9 $$LPID"; exit 1; fi; \
				printf "."; sleep 1; \
			done; echo " stopped"; \
		else echo "launcher pid=$$LPID 已死，仅清理 pidfile"; fi; \
	fi
	@rm -f .data-sidecar/launcher.pid .data-sidecar/sidecar.pid

# 重启宿主 sidecar：改了 sidecar/*.js 后用这个。
# launchd 托管时 pidfile 不存在，stop/start 那对目标会空跑，这里统一走 kickstart。
sidecar-host-restart:
	@if launchctl list 2>/dev/null | grep -q com.erishen.resolve-lume.launcher; then \
		echo "launchd 托管中 → kickstart 重启 launcher"; \
		launchctl kickstart -k gui/$$(id -u)/com.erishen.resolve-lume.launcher; \
	else \
		$(MAKE) sidecar-host-stop && $(MAKE) sidecar-host-start; \
	fi
	@printf "waiting for sidecar http://127.0.0.1:3000 "
	@i=0; \
	until curl --noproxy '*' -fsS -m 2 http://127.0.0.1:3000/api/tools/token >/dev/null 2>&1 \
	   || curl --noproxy '*' -fsS -m 2 http://127.0.0.1:3000/health >/dev/null 2>&1; do \
		i=$$((i+1)); if [ $$i -ge 30 ]; then echo ""; echo "sidecar 未就绪，看 .data-sidecar/sidecar.log"; exit 1; fi; \
		printf "."; sleep 2; \
	done; echo " ok"

# 状态速查：launcher 存活 + sidecar 存活 + 两端 /health + 3000 是否被容器 sidecar 抢占
sidecar-host-status:
	@echo "--- launcher (:3099) ---"
	@if [ -f .data-sidecar/launcher.pid ]; then \
		LPID=$$(cat .data-sidecar/launcher.pid); \
		if kill -0 "$$LPID" 2>/dev/null; then echo "running pid=$$LPID"; \
		else echo "pidfile 残留 pid=$$LPID（进程已死）"; fi; \
	else echo "not started"; fi
	@curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3099/health >/dev/null 2>&1 \
		&& echo "launcher /health: ok" || echo "launcher /health: no response"
	@echo "--- sidecar (:3000) ---"
	@if [ -f .data-sidecar/sidecar.pid ]; then \
		SPID=$$(cat .data-sidecar/sidecar.pid); \
		if kill -0 "$$SPID" 2>/dev/null; then echo "running pid=$$SPID"; \
		else echo "pidfile 残留 pid=$$SPID（进程已死）"; fi; \
	else echo "no pidfile"; fi
	@curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3000/health >/dev/null 2>&1 \
		&& echo "sidecar /health: ok" || echo "sidecar /health: no response"
	@echo "--- 端口 3000 占用 ---"
	@if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then \
		lsof -nP -iTCP:3000 -sTCP:LISTEN; \
		if docker compose ps sidecar 2>/dev/null | grep -q "Up"; then \
			echo "!! 容器 sidecar 仍在运行，与宿主 sidecar 抢 3000"; \
			echo "   切换: docker compose rm -sf sidecar && make sidecar-host-start"; \
		fi; \
	else echo "3000 空闲"; fi

# ================= launchd 常驻（推荐） =================
# 把 launcher 交给 macOS launchd：RunAtLoad 登录自启 + KeepAlive 崩溃重拉，
# 且 LAUNCHER_AUTOSTART=1 让 launcher 一起来就拉起 sidecar，不再有「会话被回收
# → 3000 空 → /api/* 502」这类静默故障。脚本按本机路径生成 plist 并只写到
# ~/Library/LaunchAgents/（不入库），注册失败会自动降级到 nohup 模式。
sidecar-autostart-install:
	@bash scripts/install-launchd.sh install

sidecar-autostart-uninstall:
	@bash scripts/install-launchd.sh uninstall

sidecar-autostart-restart:
	@bash scripts/install-launchd.sh restart

sidecar-autostart-status:
	@bash scripts/install-launchd.sh status

# ================= sidecar 工具代理层（.lume）的生成 =================
# 为什么要生成而不是手写：schema 必须与 sidecar/builtin-tools.json 同源，手写会漂出
# 「前端面板有、agent 调不到」的假象（11-04 那次 PSE FAIL 的根因就是工具面断层）。
# 生成器还会先校验 C 侧三处硬限（desc≤160B、toolName≤48B、MCP 单帧≤64KiB），
# 超限会静默出事：mcp.c:841 的 name 解析失败会直接 return，把整张工具表丢掉。

# 改了 builtin-tools.json 或 --only 名单后，重新生成给 agent 用的代理层
tools-lume:
	node deploy/gen-sidecar-tools.mjs
	@node sidecar/consistency.js --check

# 只校验不写文件（先看名单和长度是否越界，再看四处工具名单是否漂移）
tools-lume-check:
	node deploy/gen-sidecar-tools.mjs --check
	@node sidecar/consistency.js --check

# projects.json 增删项目后重写 article-* 的 project enum（校验会在 make check 里报漂移）
sync-enums:
	node sidecar/projectEnums.js

# ---- A2A peer 面(静态节点: resolve.* 只读摘要能力, 不带 agent 面) ----
# 详见 peer_node.lume。Lume server 用仓内 vendor/lume/bin/lume(make vendor/bootstrap
# 由 scripts/vendor_lume_bin.sh 填充: 本地软链 ../../lume/lume/bin/lume, 单独 clone
# 时从 GitHub pinned release 拉)。agent-httpd/ 与 lume-core/ 也从 git 子模块改为
# vendored 同名目录(由 scripts/vendor_repos.sh 从 GitHub release 拉源码, 见 vendor 目标)。
# 与 work/lume/lume-lan 的 LUME_REPO_BIN 同型 —— ~/.local/bin/lume 是 agent-httpd
# 版, 只出静态面, 不认 /peer/* 路由。PEER_* 从 .env 取; 日志落 .runtime/。
LUME_SERVER ?= vendor/lume/bin/lume
PEER_PORT_RUN ?= $(shell grep -E '^PEER_PORT=' .env 2>/dev/null | cut -d= -f2 | head -1)
ifeq ($(strip $(PEER_PORT_RUN)),)
PEER_PORT_RUN := 18113
endif

# ── vendor: 拉 peer 面自带的全部外部依赖(framework 二进制 + agent-httpd/lume-core 源码) ──
# 已在场就用, 缺失才拉。vendor/lume/bin/、agent-httpd/、lume-core/ 均不入库(见 .gitignore)。
vendor:
	@bash scripts/vendor_repos.sh
	@bash scripts/patch_vendored_sources.sh
	@bash scripts/vendor_lume_bin.sh

# 强制刷新(上游发了新版、或想钉到另一个 pinned release 时用):
#   make bootstrap                                  # 用默认版本刷新
#   make bootstrap LUME_VERSION=v0.12.2 AH_VER=v0.12.2  # 钉到指定 release
bootstrap:
	@FORCE=1 bash scripts/vendor_repos.sh
	@bash scripts/patch_vendored_sources.sh
	@FORCE=1 bash scripts/vendor_lume_bin.sh

peer-check: vendor
	@if [ ! -x "$(LUME_SERVER)" ]; then \
	  echo "✗ 找不到 $(LUME_SERVER) —— 先跑: make bootstrap" >&2; exit 1; fi
	@$(LUME_SERVER) --check peer_node.lume

# 后台起本节点 peer 端点。起完需在 lume-a2a 的 fleet 里加
# resolve-lume=127.0.0.1:$(PEER_PORT_RUN)。
peer-serve: peer-check
	@mkdir -p .runtime
	@if pgrep -f "peer_node.lume" >/dev/null 2>&1 && lsof -tiTCP:$(PEER_PORT_RUN) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "  resolve-lume peer 已在 :$(PEER_PORT_RUN) 运行"; \
	 else \
	  set -a; . ./.env; set +a; \
	  PEER_BIND=$${PEER_BIND:-127.0.0.1} PEER_PORT=$(PEER_PORT_RUN) $(LUME_SERVER) peer_node.lume > .runtime/peer_node.log 2>&1 & \
	  echo "  已启动 resolve-lume peer :$(PEER_PORT_RUN) → .runtime/peer_node.log"; \
	  sleep 1; tail -3 .runtime/peer_node.log; fi

# 网关答案组装回归测试：纯 Node，无外部依赖，不触碰运行中的服务。
# 断言「工具调用前的中间话 / PSE 计划与评审」不会拼进最终答案。
test-gateway:
	@node sidecar/translateFrame.test.js
	@node sidecar/articleFrontmatter.test.js
	@node sidecar/toolContract.test.js
	@node sidecar/security.test.js
	@node sidecar/consistency.test.js
	@node sidecar/progress.test.js
	@node sidecar/toolGuard.test.js
	@node sidecar/chatBody.test.js
	@node sidecar/sessionTitle.test.js
	@node sidecar/articleArchiveNumbering.test.js
	@node sidecar/approval.test.js

# 前端回归：Node >= 22.6 原生剥 TS 类型，零依赖、不碰运行中的服务。
#  - export: 会话 Markdown / 单条复制 / JSON / job 日志都不带出主目录与密钥
#  - api:    SSE 断流有明确报错、POST 不自动重发、Stop 能中止工具流、job 流重连
frontend-test:
	@node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON frontend/src/export.test.mjs
	@node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON frontend/src/api.test.mjs
	@node frontend/novnc-route.test.mjs

# 前端类型 + 生产构建（需要 frontend/node_modules，先 npm install）。
frontend-build-check:
	@cd frontend && npm run typecheck && npm run build

# macOS /bin/bash 3.2 在 UTF-8 下会把 $VAR 后面的中文首字节吃进变量名，
# 例如 "pid=$old（连带" 会在 set -u 下报 old\xEF: unbound variable 直接退出。
# 变量一律写 ${VAR}；这条静态规则防止中文提示语把脚本写崩（bash 5 / LC_ALL=C 不复现）。
shell-vars-check:
	@node scripts/check-shell-vars.cjs

# sidecar 不在任何编译/类型检查路径里：语法坏一行，只在拉起时才炸。
# 2026-11-09 实录：一次坏编辑把 console.log 与 if 拼成同一行，launcher 连拉
# 6 次都报 SyntaxError: Unexpected token 'if'，sidecar 一直起不来。
# node --check 只解析不执行、秒级完成，专门挡「整行拼接」这类事故。
sidecar-syntax-check:
	@for f in sidecar/*.js; do node --check "$$f" || { echo "✗ 语法错误：$$f"; exit 1; }; done
	@echo "✓ sidecar/*.js 全部通过 node --check"

# 一条命令跑完所有不依赖运行中服务的静态校验（改工具面 / 安全策略后跑这个）
check: tools-lume-check test-gateway frontend-test shell-vars-check sidecar-syntax-check
	@echo "✓ 工具桥生成约束 + 四处名单一致性 + 网关/SSE/进度/工具护栏/导出回归 + sidecar 语法 + shell 变量兼容检查全部通过"

.PHONY: setup build up wait start down logs frontend-up mcp-bridges-up mcp-bridges-down mcp-bridges-logs sidecar-host-start sidecar-host-stop sidecar-host-restart sidecar-host-status sidecar-autostart-install sidecar-autostart-uninstall sidecar-autostart-restart sidecar-autostart-status tools-lume tools-lume-check vendor bootstrap peer-check peer-serve test-gateway frontend-test frontend-build-check shell-vars-check sidecar-syntax-check sync-enums check
