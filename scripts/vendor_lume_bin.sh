#!/usr/bin/env bash
# vendor_lume_bin.sh —— 把 framework 二进制落进 vendor/lume/bin/lume, 解耦兄弟 checkout
#
# 为什么只 vendor 二进制: resolve-lume 的共享库(lume-core)是 **git 子模块**
# (gitlink 跟踪、自包含、`git submodule update` 即可), 源码里用裸 import
#   import "lume-core/lib/peer.lume"
# 解析到子模块目录 —— 这条路已经版本化、不会漂。真正没版本化、会跟活 checkout
# 漂的只有那个 framework 二进制(原来 ../../lume/lume/bin/lume)。所以这里只
# vendor 二进制, 不 vendor lib。
#
# 来源优先级:
#   1) 本地兄弟 ../../lume/lume/bin/lume  (monorepo 开发: 软链, 改了即时生效)
#   2) GitHub release erishen/lume $LUME_VERSION  (单独 clone: 可复现)
#
# ⚠️ 必须是 **framework** 二进制(../lume/lume/bin/lume), 不是 agent-httpd 静态面:
# peer_node.lume 走 /peer/* 路由, agent-httpd 版不认。与 a2a 仓同款取舍。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LUME_BIN="$ROOT/vendor/lume/bin/lume"
STAMP="$ROOT/vendor/.vendor-stamp"
LUME_VERSION="${LUME_VERSION:-v0.12.2}"
LUME_REPO="${LUME_REPO:-erishen/lume}"
LOCAL_BIN="$ROOT/../../lume/lume/bin/lume"

mkdir -p "$(dirname "$LUME_BIN")"
if [ -f "$LOCAL_BIN" ]; then
  # 软链(不 cp: macOS 复制会破坏 codesign, 触发 amfi Killed:9)。
  ln -sf "$LOCAL_BIN" "$LUME_BIN"
  { echo "source=local-checkout(symlink → ${LOCAL_BIN#$ROOT/})"
    echo "bin=$("$LUME_BIN" --version 2>/dev/null | head -1)"
  } > "$STAMP"
else
  echo "▶ 从 release 拉 ${LUME_REPO} ${LUME_VERSION}"
  os="$(uname -s | tr 'A-Z' 'a-z')"
  case "$(uname -m)" in
    arm64|aarch64) carch=arm64 ;;
    x86_64|amd64)  carch=x64 ;;
    *) echo "✗ 不支持的架构: $(uname -m)" >&2; exit 1 ;;
  esac
  tmp="$ROOT/.vendor-dl.$$"; mkdir -p "$tmp"
  curl -fsSL --retry 3 -o "$tmp/lume-static.tar.gz" \
    "https://github.com/${LUME_REPO}/releases/download/${LUME_VERSION}/lume-${os}-${carch}-static.tar.gz"
  tar -xzf "$tmp/lume-static.tar.gz" -C "$tmp"
  lsrc="$(find "$tmp" -name 'lume' -type f | head -1)"
  [ -n "$lsrc" ] || { echo "✗ 解压后找不到 framework 二进制" >&2; rm -rf "$tmp"; exit 1; }
  cp "$lsrc" "$LUME_BIN"; chmod +x "$LUME_BIN"; rm -rf "$tmp"
  { echo "source=release"
    echo "bin=${LUME_VERSION}(${LUME_REPO})"
  } > "$STAMP"
fi
echo "▶ vendor/lume/bin/lume 已就绪($([ -f "$STAMP" ] && cat "$STAMP" | tr '\n' ' '))"
