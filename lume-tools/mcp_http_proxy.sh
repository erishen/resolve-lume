#!/bin/sh
# MCP stdio ↔ Streamable HTTP 代理（给 agent-httpd 用）。
#
# 背景：agent-httpd 的 MCP 客户端只支持 stdio（src/agent/mcp.c:125 直接
# `skip server: only stdio transport today`），而 backend 镜像按设计不含
# node/npx，所以 npx 型 MCP server（fs/git/fetch/memory/think）既拉不起来、
# 也没法用 HTTP 直连。这个脚本把「stdio 侧的一行一个 JSON-RPC」翻译成
# 「对 supergateway/mcp-bridge 的一次 POST」，把 SSE 响应再翻回 stdout，
# 从而让 C 后端通过 stdio 用上 tsm-hub 里的 HTTP MCP 桥。
#
# 用法：mcp_http_proxy.sh <upstream-url>
#   例：sh /app/lume-tools/mcp_http_proxy.sh http://mcp-fs:8000/mcp
#
# 依赖：curl（backend 镜像自带：healthcheck 就用它）。
# 有状态：initialize 响应头里的 mcp-session-id 会被记住，后续请求带上。
set -u

URL="${1:-}"
if [ -z "$URL" ]; then
  printf '%s\n' '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"mcp_http_proxy: missing upstream url"}}'
  exit 1
fi

WORK="$(mktemp -d 2>/dev/null)" || exit 1
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
SID_FILE="$WORK/sidfile"
PAYLOAD="$WORK/payload.json"
HDR="$WORK/hdr.txt"
BODY="$WORK/body.txt"
: > "$SID_FILE"

# 诊断日志（可选）：MCP_HTTP_PROXY_LOG=/tmp/xxx.log。排查握手失败时开，
# 正常运行时留空即完全静默。
DBG_LOG="${MCP_HTTP_PROXY_LOG:-}"
dbg() {
  [ -z "$DBG_LOG" ] && return 0
  printf '[%s pid=%s %s] %s\n' "$(date '+%H:%M:%S')" "$$" "$URL" "$*" >> "$DBG_LOG" 2>/dev/null || true
}
dbg "start"

# 把当前一行发给上游，响应头落 $HDR、响应体落 $BODY。
do_post() {
  sid="$(cat "$SID_FILE" 2>/dev/null || true)"
  if [ -n "$sid" ]; then
    curl -sS --max-time 300 -D "$HDR" -o "$BODY" -X POST "$URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "mcp-session-id: $sid" \
      --data-binary "@$PAYLOAD"
  else
    curl -sS --max-time 300 -D "$HDR" -o "$BODY" -X POST "$URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      --data-binary "@$PAYLOAD"
  fi
}

while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  dbg "recv ${#line} bytes"
  printf '%s' "$line" > "$PAYLOAD"
  : > "$HDR"
  : > "$BODY"

  if ! do_post; then
    dbg "curl failed"
    # 失败也要回一条带 id 的 JSON-RPC error，否则前端/agent 会一直等。
    id="$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)"
    [ -z "$id" ] && id=null
    printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"mcp_http_proxy: upstream request failed"}}\n' "$id"
    continue
  fi

  # 记下会话 id（只在 initialize 响应里出现，之后每次原样带回）。
  sid="$(sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii][Dd]:[[:space:]]*//p' "$HDR" | tr -d '\r' | head -n 1)"
  if [ -n "$sid" ]; then
    printf '%s' "$sid" > "$SID_FILE"
  fi

  # 上游两种响应形态：纯 JSON（application/json）或 SSE（text/event-stream）。
  first="$(head -c 1 "$BODY" 2>/dev/null || true)"
  dbg "resp first=[$first] hdr=$(wc -c < "$HDR" 2>/dev/null) body=$(wc -c < "$BODY" 2>/dev/null)"
  if [ "$first" = "{" ]; then
    cat "$BODY"
    printf '\n'
  else
    # SSE：每条 `data: {...}` 都是一个 JSON-RPC 消息，逐条转成 stdout 的行。
    sed -n 's/^data:[[:space:]]*//p' "$BODY" | tr -d '\r' | while IFS= read -r d; do
      [ -n "$d" ] && printf '%s\n' "$d"
    done
  fi
done
