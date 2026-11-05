#!/usr/bin/env bash
# 在【宿主 macOS】上启动 resolve-lume 的 sidecar（Node 网关 + 工具执行层）。
#
# 调用链（宿主 sidecar 模式）：
#   浏览器 ──► frontend 容器 :18085 (nginx)
#            ──proxy_pass──► host.docker.internal:3000 ──► 本进程（宿主 node server.js）
#            ──► 127.0.0.1:8080 ──► backend 容器（agent-httpd，已发布到宿主 loopback）
#
# 与已退役旧设计 legacy/host-sidecar/start-sidecar.sh 的区别：
#   1. env 不再全量透传：只显式 export 下方白名单变量，宿主 shell 的其它脏值
#      （旧 PATH/代理/工具链）一律不带进 sidecar 进程。
#   2. 崩溃重拉由 launcher.js 负责（本脚本只管前台 exec；拉起与重启归 launcher）。
#   3. LLM_API_URL 在此显式覆盖为宿主 llm-router；.env 里的 host.docker.internal
#      值只给容器 sidecar 用，宿主 sidecar 必须直连 127.0.0.1。
#
# 用法：
#   正常路径：make sidecar-host-start（经 launcher 拉起本脚本，勿直接前台跑）
#   调试路径：./sidecar/start-host.sh   # 前台运行（Ctrl-C 停止，绕过 launcher）

set -euo pipefail

# ---------- 路径解析（不依赖当前工作目录） ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ROOT = resolve-lume 仓库根
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# REPO_ROOT = 私有工作区根（ROOT/../../.. 三级上溯）。
# 注意：不是 ROOT/../..（那是 work/ 目录）。FS_ROOTS 里的 work/frameworks/personal/
# <tools-dir> 都是私有工作区的直接子目录，必须三级上溯才能拼对。
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"

# ---------- 显式 env 白名单（绝不继承宿主全局脏值，以下变量全部本脚本自定） ----------

# PORT 带脏值保护：非数字 / 空 / 0 一律回落 3000（node 会把 0 当随机端口，
# 表现为 nginx 反代全部 502 而日志看不出错误）。
PORT="${PORT:-3000}"
case "$PORT" in '' | *[!0-9]* | 0) PORT=3000 ;; esac
export PORT

# 必须保持 loopback：本进程可执行宿主 shell 且无鉴权，不能对局域网开放。
# 容器经 host.docker.internal（宿主网关）访问，不需要 0.0.0.0。
HOST="127.0.0.1"
export HOST

# backend 容器已发布到宿主 127.0.0.1:8080（另一分片在 compose 加 ports）。
AGENT_HTTPD_URL="http://127.0.0.1:8080"
export AGENT_HTTPD_URL

# PSE 角色定义目录
PSE_SOULS_DIR="$ROOT/souls"
export PSE_SOULS_DIR

# 文件工具允许读写的根（宿主真实绝对路径）：
#   resolve-lume 自身的 souls / lume-tools，以及工作区四个兄弟目录。
# 兄弟目录名随私有工作区布局而定，用 FS_ROOTS_EXTRA 覆盖即可（默认取工作区
# 根下的投资工具目录）；这里不写死具体目录名 —— 公开仓里不必暴露私有工作区
# 的目录结构，而运行时行为不变。
FS_ROOTS="$ROOT/souls,$ROOT/lume-tools,$REPO_ROOT/work,$REPO_ROOT/frameworks,$REPO_ROOT/personal"
if [ -n "${FS_ROOTS_EXTRA:-}" ]; then
  FS_ROOTS="$FS_ROOTS,$FS_ROOTS_EXTRA"
else
  for d in "$REPO_ROOT"/*/; do
    [ -d "$d/apps" ] && FS_ROOTS="$FS_ROOTS,${d%/}"
  done
fi
export FS_ROOTS

# 工作区根（内置工具 cwd / 相对路径解析基准）
WORKSPACE_DIR="$REPO_ROOT/work"
export WORKSPACE_DIR

# 运行时数据（sessions/jobs/db/...）落独立目录，不污染源码
DATA_DIR="$ROOT/.data-sidecar"
mkdir -p "$DATA_DIR"
export DATA_DIR

# MCP 注册表 seed（前端面板显示 lume-tools 桥）
MCP_SEED_FILE="$ROOT/deploy/mcp-servers.json"
export MCP_SEED_FILE

# 宿主 stock-analyzer 服务（未运行时 stock-scan 工具报错提示，不影响其它工具）
STOCK_SCAN_URL="http://127.0.0.1:18001/api/scan"
export STOCK_SCAN_URL

# 显式覆盖 LLM 端点：宿主 sidecar 的 PSE/聊天工具要直连宿主 llm-router。
# .env 里写的是 host.docker.internal:19070（只给容器用）。
# envloader 的注入语义是「已存在的 env 不覆盖」，所以这里 export 的优先级最高，
# server.js 侧的 envloader 只会补 LLM_API_KEY / LLM_MODEL / SIDECAR_TOKEN 等。
LLM_API_URL="http://127.0.0.1:19070/v1/chat/completions"
export LLM_API_URL

# SIDECAR_TOKEN 不在此设：由 server.js 侧 envloader 从 .env 读取，
# 与 frontend 容器内 nginx 反代携带的 X-Sidecar-Token 同源（同一份 .env）。

# 显式锁定 Node 运行时：用户本地环境约定 sidecar 跑 nvm Node 24（v24.12.0，
# 经 .zshrc 的 nvm use 24 激活）。nohup / cron / launchd 等非交互 shell 不读
# .zshrc，普通 PATH 里的 node 可能是其它版本——优先用 nvm 绝对路径，不存在时
# 再回落 PATH 的 node（NODE_BIN 环境变量可显式覆盖）。
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.12.0/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

# 显式把 uv 位置并入 PATH：非交互 shell 不读 .zshrc，而 .zshrc 里配的两处 uv
# （~/.local/bin 与 ~/Software/uv-aarch64-apple-darwin）都可能不在默认 PATH 里。
# uv 是 PSE 工具（uv run / uv sync）的执行前提，缺了 spawnCapture 会报 ENOENT spawn uv。
for uv_dir in "$HOME/.local/bin" "$HOME/Software/uv-aarch64-apple-darwin"; do
  case ":$PATH:" in
    *":$uv_dir:"*) ;;
    *) [ -d "$uv_dir" ] && export PATH="$uv_dir:$PATH" ;;
  esac
done

# 记录 pid：exec 之后本 bash 进程即 node，故 $$ 就是 server.js 的 pid。
echo "$$" > "$DATA_DIR/sidecar.pid"

# ---------- 启动信息（只打印变量名与路径，敏感值一律不 echo） ----------
echo "[sidecar-host] repo root (resolve-lume) : $ROOT"
echo "[sidecar-host] workspace root           : $REPO_ROOT"
echo "[sidecar-host] bind                     : $HOST:$PORT"
echo "[sidecar-host] agent-httpd url          : $AGENT_HTTPD_URL"
echo "[sidecar-host] llm api url              : $LLM_API_URL"
echo "[sidecar-host] fs-roots count            : $(awk -F, '{print NF}' <<<"$FS_ROOTS") entries"
echo "[sidecar-host] data dir / pidfile       : $DATA_DIR/sidecar.pid"
echo "[sidecar-host] node bin                 : $NODE_BIN"
echo "[sidecar-host] (frontend 容器经 host.docker.internal:$PORT 访问本进程)"
echo "[sidecar-host] exec sidecar/server.js ..."

exec "$NODE_BIN" "$ROOT/sidecar/server.js"
