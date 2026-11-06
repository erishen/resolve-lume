#!/usr/bin/env bash
# 把宿主 sidecar 的 launcher 交给 macOS launchd 托管。
#
# 为什么需要它：
#   `make sidecar-host-start` 用 nohup 起 launcher，进程仍属于拉起它的 shell/执行
#   会话。会话被回收时 launcher 与它的 sidecar 子进程会一起被 SIGKILL（日志里
#   没有崩溃记录，只剩 pidfile 残留），而 backend/frontend 由 Docker 托管照常存活
#   —— 于是 frontend 反代 /api/* 全部变成
#   502 "Proxy error: connect ECONNREFUSED <host-gateway>:3000"，
#   UI 报 "failed to load runtime info: failed to load models: 502"。
#   launchd 托管的进程不属于任何 shell：RunAtLoad 登录自启 + KeepAlive 崩溃重拉，
#   且 LAUNCHER_AUTOSTART=1 让 launcher 一起来就拉起 sidecar（launcher.js 里
#   本来就为这个模式预留了开关）。
#
# 用法（也可经 make）：
#   bash scripts/install-launchd.sh install     # 生成 plist + 注册 + 等 :3000 就绪
#   bash scripts/install-launchd.sh plist-only  # 只生成 plist，不注册（受限会话/换机后）
#   bash scripts/install-launchd.sh status      # 服务状态 + 三个 /health 速查
#   bash scripts/install-launchd.sh restart     # 重启（改了 sidecar/ 源码后用）
#   bash scripts/install-launchd.sh uninstall   # 注销 + 删除 plist + 停 sidecar
#
# 生成的 plist 含本机绝对路径，只写到 ~/Library/LaunchAgents/，绝不入库。
# 安装前会先停掉可能残留的 nohup launcher，避免两边抢 3099 造成 EADDRINUSE
# 与 KeepAlive 无限重拉。
#
# ⚠️ 变量引用一律写 ${VAR}，不要写 $VAR：macOS 自带 /bin/bash 3.2 在 UTF-8
#    locale 下，若 $VAR 后面紧跟中文/全角标点，会把多字节字符的首字节也吃进
#    变量名（"pid=$old（连带" → `old\xEF: unbound variable`），在 set -u 下
#    直接中断脚本。bash 5 / LC_ALL=C 都不复现，极易漏测。make check 里的
#    scripts/check-shell-vars.cjs 会静态拦截这种写法。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.erishen.resolve-lume.launcher"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DATA_DIR="${ROOT}/.data-sidecar"
OUT_LOG="${DATA_DIR}/launcher.log"
ERR_LOG="${DATA_DIR}/launchd.err.log"
LAUNCHER="${ROOT}/sidecar/launcher.js"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ 仅支持 macOS（launchd）" >&2
  exit 1
fi

# 与 sidecar/start-host.sh 保持同一个 Node：优先 nvm v24，缺失回落 PATH 里的 node。
NODE_BIN="${NODE_BIN:-${HOME}/.nvm/versions/node/v24.12.0/bin/node}"
[ -x "${NODE_BIN}" ] || NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  echo "✗ 找不到可执行的 node，请设 NODE_BIN=/绝对路径/to/node" >&2
  exit 1
fi

# launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin。sidecar 的工具层要 spawn
# node/uv/python3/make，缺 PATH 会静默 ENOENT（页面能开、工具全废）。
# 与 start-host.sh 的 env 白名单策略一致：只写死已知工具链目录，绝不把当前
# shell 的 PATH 带进 plist（既避免脏值，也避免把本机私有路径写进配置）。
HOST_PATH="${HOME}/.nvm/versions/node/v24.12.0/bin:${HOME}/.local/bin:${HOME}/Software/uv-aarch64-apple-darwin:${HOME}/.bun/bin:${HOME}/Library/pnpm:${HOME}/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_escape() {
  printf '%s' "${1}" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

write_plist() {
  mkdir -p "${HOME}/Library/LaunchAgents" "${DATA_DIR}"
  cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "${LABEL}")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "${NODE_BIN}")</string>
    <string>$(xml_escape "${LAUNCHER}")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${ROOT}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAUNCHER_AUTOSTART</key>
    <string>1</string>
    <key>PATH</key>
    <string>$(xml_escape "${HOST_PATH}")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${OUT_LOG}")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${ERR_LOG}")</string>
</dict>
</plist>
EOF
  plutil -lint "${PLIST}" >/dev/null
  echo "✓ plist: ${PLIST}"
}

# 停掉旧的 nohup launcher（若有）。launcher 的 SIGTERM handler 会连带停 sidecar，
# 这是唯一干净的停法；直接 kill sidecar 会被 launcher 的崩溃重拉逻辑拉回来。
stop_legacy_launcher() {
  local pidfile="${DATA_DIR}/launcher.pid"
  [ -f "${pidfile}" ] || return 0
  local old
  old="$(cat "${pidfile}" 2>/dev/null || true)"
  if [ -n "${old}" ] && kill -0 "${old}" 2>/dev/null; then
    echo "· 停掉残留 launcher pid=${old}（连带 sidecar）"
    kill "${old}" 2>/dev/null || true
    local i=0
    while kill -0 "${old}" 2>/dev/null && [ "${i}" -lt 20 ]; do
      i=$((i + 1)); sleep 0.2
    done
  fi
}

wait_ready() {
  local i=0
  printf "waiting for sidecar http://127.0.0.1:3000 "
  until curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3000/health >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 30 ]; then
      echo ""
      echo "✗ 30s 内未就绪。排查：" >&2
      echo "    tail -40 ${OUT_LOG}" >&2
      echo "    tail -40 ${ERR_LOG}" >&2
      echo "    tail -40 ${DATA_DIR}/sidecar.log" >&2
      echo "    bash scripts/install-launchd.sh status" >&2
      exit 1
    fi
    printf "."; sleep 1
  done
  echo " ok"
}

case "${1:-install}" in
  install)
    write_plist
    launchctl bootout "${SERVICE}" 2>/dev/null || true
    stop_legacy_launcher
    # 某些执行上下文（非 Aqua bootstrap 会话 / 受限的 Agent shell）调 launchctl
    # 会返回 "Bootstrap failed: 5: Input/output error"。这不是 plist 有误：
    # plist 已 lint 通过并放进 ~/Library/LaunchAgents，下次登录照样自动加载。
    # 此时降级到 nohup 模式先把服务救回来，并提示用户在本机 Terminal 重跑。
    if launchctl bootstrap "${DOMAIN}" "${PLIST}" 2>/dev/null; then
      launchctl enable "${SERVICE}" 2>/dev/null || true
      wait_ready
      echo "✓ launchd 已托管：${SERVICE}（登录自启 + KeepAlive + AUTOSTART）"
      echo "  重启用: make sidecar-autostart-restart；移除: make sidecar-autostart-uninstall"
      echo "  ⚠️ 托管期间不要用 make sidecar-host-stop（会被 KeepAlive 立刻拉回）"
    else
      echo "⚠️ 当前会话无法向 launchd 注册（bootstrap EIO）。plist 已就位，下次登录自动生效。"
      echo "  在本机 Terminal 里重跑 make sidecar-autostart-install 即可立即注册；"
      echo "  现在先回退到 nohup 模式恢复服务（进程随当前终端会话存活）。"
      make -C "${ROOT}" sidecar-host-start
      wait_ready
      echo "✓ 服务已恢复（nohup 模式）"
      echo "  ⚠️ 下次登录前先跑 make sidecar-host-stop 停掉这个 nohup launcher："
      echo "     plist 已就位，登录时 launchd 也会拉一个，两边会抢 3099。"
    fi
    ;;
  plist-only)
    write_plist
    echo "✓ plist 已生成但未注册：下次登录 launchd 会自动加载"
    echo "  想立即生效，在本机 Terminal 跑: launchctl bootstrap ${DOMAIN} ${PLIST}"
    echo "  或重跑: make sidecar-autostart-install"
    ;;
  uninstall)
    launchctl bootout "${SERVICE}" 2>/dev/null || true
    rm -f "${PLIST}"
    echo "✓ 已注销 ${LABEL} 并删除 plist；sidecar 已随 launcher 的 SIGTERM 停止"
    echo "  需要手工模式时再跑: make sidecar-host-start"
    ;;
  restart)
    if ! launchctl kickstart -k "${SERVICE}" 2>/dev/null; then
      echo "✗ launchd job 未注册，先跑: make sidecar-autostart-install" >&2
      exit 1
    fi
    wait_ready
    echo "✓ 已重启 ${LABEL}（sidecar 同步重拉）"
    ;;
  status)
    echo "--- launchd job ---"
    launchctl list | grep -F "${LABEL}" || echo "未注册（跑 make sidecar-autostart-install；plist 也许已就位待下次登录）"
    echo "--- launcher :3099 ---"
    curl --noproxy '*' -fsS -m 1 http://127.0.0.1:3099/status || true
    echo ""
    echo "--- sidecar :3000 ---"
    curl --noproxy '*' -fsS -m 1 -o /dev/null -w "health HTTP %{http_code}\n" http://127.0.0.1:3000/health || true
    echo "--- frontend :18085 /api/tools ---"
    curl --noproxy '*' -fsS -m 2 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:18085/api/tools || true
    ;;
  *)
    echo "用法: ${0} {install|plist-only|uninstall|restart|status}" >&2
    exit 2
    ;;
esac
