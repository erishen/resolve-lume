#!/bin/sh
# 幂等地修补 vendored 源码（agent-httpd/ 与 lume-core/ 不入库，make vendor/bootstrap
# 会用上游源码覆盖本地改动，所以需要这个脚本在每次 build 前把本地必要的补丁打回去）。
#
# 当前只有一处：
#   lume-core src/builtins_http.c 的 HTTP_MAX_TIMEOUT_MS 600000 → 1200000。
#   原因：.lume 桥（lume-tools/sidecar_ro.lume）用 http_post 调宿主 sidecar，
#   pse-review / article-write 这类多智能体任务实测 7-12 min，10 min 的封顶会让
#   「报告已经写盘、桥却先 abort」，agent 收到 502 看不到结果（2026-11-09 实录）。
#   上限只约束调用方允许传的最大值，实际仍由 opts.timeout 决定（桥自己用 870s，
#   小于 agent-httpd 的 MCP_CALL_TIMEOUT 900s，让桥先失败并回可读错误）。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/lume-core/src/builtins_http.c"
OLD='#define HTTP_MAX_TIMEOUT_MS  600000L'
NEW='#define HTTP_MAX_TIMEOUT_MS  1200000L'

if [ ! -f "$SRC" ]; then
  echo "[patch] 跳过：$SRC 不存在（先 make vendor）"
  exit 0
fi

if grep -q "$NEW" "$SRC"; then
  echo "[patch] lume-core http timeout 已是 20 min，无需修补"
  exit 0
fi

if ! grep -q "$OLD" "$SRC"; then
  echo "[patch] 警告：$SRC 里没有预期的 $OLD，上游可能已改过；请人工确认" >&2
  exit 0
fi

# 用 python 做字节级替换，避免 BSD sed -i 的可移植问题
python3 - "$SRC" "$OLD" "$NEW" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
assert s.count(old) == 1, s.count(old)
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
echo "[patch] lume-core http timeout 已放宽到 20 min（600s → 1200s）"
