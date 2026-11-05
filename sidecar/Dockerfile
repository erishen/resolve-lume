# syntax=docker/dockerfile:1
# resolve-lume sidecar — zero-dependency Node HTTP gateway + feature backend.
# Runs entirely on Node built-ins (no npm install) so the build never needs network.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./package.json
COPY store.js ./store.js
COPY agent.js ./agent.js
COPY server.js ./server.js
COPY builtin-exec.js ./builtin-exec.js
COPY builtin-tools.json ./builtin-tools.json
COPY builtin-business.js ./builtin-business.js
COPY business-helpers.js ./business-helpers.js
COPY business-pse.js ./business-pse.js
COPY business-publish.js ./business-publish.js
COPY business-misc.js ./business-misc.js

# Toolchain for the `make` tool: host projects under /workspace are built via
# their own Makefiles (uv/python for investment-tool & pse frameworks, pnpm for web
# projects). uv is pinned to the system python (UV_PYTHON_PREFERENCE=only-system)
# so no managed-python downloads from github are needed in CN networks; pip and
# corepack go through CN mirrors. Note: this layer needs network at build time.
# 用 bookworm-slim (glibc) 而非 alpine(musl): 宿主 Python 项目的原生依赖
# (如 matplotlib) 在 musl 下无预编译 wheel, uv 会回退源码编译, 而 sidecar 未装
# C 编译器 → `make` 工具在投资工具类真实项目上回归。实测见 memory 日志。
RUN apt-get update \
  && apt-get install -y --no-install-recommends make git python3 python3-venv python3-pip ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple uv \
  && corepack enable
ENV UV_PYTHON_PREFERENCE=only-system \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN mkdir -p /app/.data
# DATA_DIR/PORT/HOST 由 compose 覆盖（数据 bind mount 到宿主 .data-sidecar）。
ENV DATA_DIR=/app/.data PORT=3000
EXPOSE 3000
# curl 用于容器 healthcheck（compose 的 /health 探针）。
CMD ["node", "server.js"]
