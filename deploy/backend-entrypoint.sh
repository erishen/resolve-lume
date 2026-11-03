#!/bin/sh
# resolve-lume 后端入口。语义对齐 agent-httpd 官方 docker-entrypoint：
#   PORT -> -p   WORKERS -> -w   access log -> -L
# PSE 角色目录由 PSE_SOULS_DIR 环境变量指定（compose 里设为 /app/souls）。
set -e
mkdir -p /var/log/agent-httpd /run/agent-httpd
echo "[backend] exec agent-httpd -p ${PORT:-8080} -w ${WORKERS:-8} -L /var/log/agent-httpd/access.log"
exec /usr/local/bin/agent-httpd -p "${PORT:-8080}" -w "${WORKERS:-8}" -L /var/log/agent-httpd/access.log
