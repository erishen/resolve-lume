#!/bin/sh
# 幂等地修补 vendored 源码（agent-httpd/ 与 lume-core/ 不入库，make vendor/bootstrap
# 会用上游源码覆盖本地改动，所以需要这个脚本在每次 build 前把本地必要的补丁打回去）。
#
# 两处：
#   1) lume-core src/builtins_http.c 的 HTTP_MAX_TIMEOUT_MS 600000 → 1200000。
#   原因：.lume 桥（lume-tools/sidecar_ro.lume）用 http_post 调宿主 sidecar，
#   pse-review / article-write 这类多智能体任务实测 7-12 min，10 min 的封顶会让
#   「报告已经写盘、桥却先 abort」，agent 收到 502 看不到结果（2026-11-09 实录）。
#   上限只约束调用方允许传的最大值，实际仍由 opts.timeout 决定（桥自己用 870s，
#   小于 agent-httpd 的 MCP_CALL_TIMEOUT 900s，让桥先失败并回可读错误）。
#   2) agent-httpd src/agent/mcp.c：MCP tools/call 没有 metadata 通道，把 chat
#   请求的 sessionId 作为 "_lume_session" 塞进 arguments，sidecar 据此把审批
#   提示 / 进度帧路由到发起调用的那个会话（并发对话不再互相串台）。
#
# 两个补丁互相独立：任一处「已打」都不影响另一处继续检查。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- 1) lume-core: http_post 超时封顶 10 min → 20 min ------------------------
SRC="$ROOT/lume-core/src/builtins_http.c"
OLD='#define HTTP_MAX_TIMEOUT_MS  600000L'
NEW='#define HTTP_MAX_TIMEOUT_MS  1200000L'

if [ ! -f "$SRC" ]; then
  echo "[patch] 跳过：$SRC 不存在（先 make vendor）"
elif grep -q "$NEW" "$SRC"; then
  echo "[patch] lume-core http timeout 已是 20 min，无需修补"
elif ! grep -q "$OLD" "$SRC"; then
  echo "[patch] 警告：$SRC 里没有预期的 ${OLD}，上游可能已改过；请人工确认" >&2
else
  # 用 python 做字节级替换，避免 BSD sed -i 的可移植问题
  python3 - "$SRC" "$OLD" "$NEW" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
assert s.count(old) == 1, s.count(old)
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
  echo "[patch] lume-core http timeout 已放宽到 20 min（600s → 1200s）"
fi

# ---- 2) agent-httpd: 把 chat sessionId 带进 MCP 工具入参 --------------------
MC="$ROOT/agent-httpd/src/agent/mcp.c"
if [ -f "$MC" ]; then
  python3 "$ROOT/deploy/patch_agent_httpd_session.py" "$MC"
else
  echo "[patch] 跳过：$MC 不存在（先 make vendor）"
fi

# ---- 3) agent-httpd: ReAct 循环的 studio 式护栏 -----------------------------
# 模型只把工具调用写成正文（或只描述计划、或工具跑完哑火）时，C 循环原先直接
# 当最终答案收尾；这里补 4 KiB 的 round 文本留存 + 两次有界续推，并把「参数
# 写成正文 JSON」识别出来，再对未知工具名给出候选（small model 自纠）。
AH="$ROOT/agent-httpd"
if [ -d "$AH" ]; then
  python3 "$ROOT/deploy/patch_agent_httpd_guards.py" "$AH"
else
  echo "[patch] 跳过：$AH 不存在（先 make vendor）"
fi

# ---- 4) lume-core: 单个工具描述上限 160B → 1024B -----------------------------
# ToolRec.desc[161] 是「工具只能带一句话」的真正天花板（bridge_mcp.c 原样把该
# 字段当 MCP description 发出）。99 工具面下，juejin-draft/juejin-publish、
# shell/make 这类相近名字靠一句话分不开，模型只能猜。
# ---- 6) agent-httpd: 把「写成正文的工具调用」捞回来执行 ----------------------
# 小模型偶尔把 {"name":..,"arguments":..} 当正文发出来。只催它重发，它可能
# 一直重犯，最后把那截 JSON 当答案回给用户。这里直接解析并派发这一次调用。
if [ -d "$AH" ]; then
  python3 "$ROOT/deploy/patch_agent_httpd_salvage.py" "$AH"
else
  echo "[patch] 跳过：$AH 不存在（先 make vendor）"
fi

LC="$ROOT/lume-core"
if [ -d "$LC" ]; then
  python3 "$ROOT/deploy/patch_lume_core_tool_desc.py" "$LC"
else
  echo "[patch] 跳过：$LC 不存在（先 make vendor）"
fi

# ---- 5) agent-httpd: MCP 单工具 deny 名单（MCP_TOOL_DENY） --------------------
# MCP_ALLOW 只能整台服务器开关；git 那台注册 28 个工具，agent 只需要 9 个
# （status/diff/log/show/blame/branch/remote/add/commit）。其余注册进来只是
# 让模型多 19 个相近名字可猜，副作用型能力本来也走 shell + 人工审批。
if [ -d "$AH" ]; then
  python3 "$ROOT/deploy/patch_agent_httpd_mcp_tool_filter.py" "$AH"
else
  echo "[patch] 跳过：$AH 不存在（先 make vendor）"
fi

# ---- 7) agent-httpd: 超时报错带上实际预算 ------------------------------------
# 原先只报一句 "upstream timeout"，用户分不清「模型慢、该调大 LLM_TIMEOUT」和
# 「网关坏了」。改成 "upstream timeout (120s)"，秒数与 curl --max-time 同源。
if [ -f "$ROOT/agent-httpd/src/agent/agent.c" ]; then
  python3 "$ROOT/deploy/patch_agent_httpd_timeout_message.py" \
    "$ROOT/agent-httpd/src/agent/agent.c"
else
  echo "[patch] 跳过：agent-httpd/src/agent/agent.c 不存在（先 make vendor）"
fi
