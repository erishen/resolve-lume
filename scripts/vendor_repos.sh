#!/usr/bin/env bash
# vendor_repos.sh —— 把 agent-httpd / lume-core 的**源码**从 GitHub release 拉到同名
# vendored 目录, 替代原先的 git submodule。
#
# 为什么 vendored 同名目录而不是 submodule:
#   - submodule 需要 `git submodule update --init` + 对上游 commit 的精细对齐, 管理负担重;
#   - 现在两个仓都已发 release tag(v0.12.1 / v0.13.1, 含此前用的安全/契约修复),
#     直接从 archive 拉源码即可, 路径语义完全不变(见下)。
#
# 路径语义零改动:
#   - Dockerfile.backend 仍是 `COPY agent-httpd/` + `make -C agent-httpd all`、`COPY lume-core/` + `make -C lume-core all`;
#   - peer_node.lume 仍是 `import "lume-core/lib/peer.lume"` —— lume-core/ 目录名不变, 裸 import 解析照旧。
#   只是这两个目录的内容来源从「git submodule checkout」变成「release tarball 解压」, 且目录本身被 .gitignore 忽略。
#
# 目录不入库(.gitignore 的 agent-httpd/ lume-core/), 由 make vendor / make bootstrap 填充。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AH_REPO="${AH_REPO:-erishen/agent-httpd}"
AH_VER="${AH_VER:-v0.12.1}"
LC_REPO="${LC_REPO:-erishen/lume-core}"
LC_VER="${LC_VER:-v0.13.1}"

fetch() {
  local repo="$1" ver="$2" dest="$3" hint="$4"
  if [ -d "$dest/src" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "✓ $dest 已存在, 跳过(设 FORCE=1 强制刷新)"
    return 0
  fi
  echo "▶ 拉 ${repo} ${ver} → ${dest}"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/src.tar.gz" \
    "https://github.com/${repo}/archive/refs/tags/${ver}.tar.gz"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tmp/src.tar.gz" -C "$dest" --strip-components=1
  rm -rf "$tmp"
  # 校验关键文件存在: 否则 tarball 拓扑变了, 必须立刻报错而不是默默编出一个空壳。
  if [ ! -d "$dest/src" ]; then
    echo "✗ $dest/src 缺失 —— tarball 拓朴异常, 中止" >&2; exit 1
  fi
  if [ ! -f "$dest/Makefile" ]; then
    echo "✗ $dest/Makefile 缺失 —— 无法 make all, 中止" >&2; exit 1
  fi
  echo "  $hint"
}

fetch "$AH_REPO" "$AH_VER" "$ROOT/agent-httpd" "agent-httpd: C 后端源码 (MCP_TEXT_MAX=32768 修复随 v0.12.1 入库)"
# lume-core 必须带 lib/peer.lume —— peer_node.lume 的 import "lume-core/lib/peer.lume" 依赖它。
fetch "$LC_REPO" "$LC_VER" "$ROOT/lume-core" "lume-core: .lume 工具桥源码 (含 lib/peer.lume)"
if [ ! -f "$ROOT/lume-core/lib/peer.lume" ]; then
  echo "✗ lume-core/lib/peer.lume 缺失 —— peer_node.lume 的 import 会失败, 中止" >&2; exit 1
fi

echo "▶ vendored 源码就绪: agent-httpd@${AH_VER} / lume-core@${LC_VER}"
