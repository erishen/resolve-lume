# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --registry https://registry.npmmirror.com
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/share/nginx/html

# Serve static files with a simple Node server that also proxies /api/ to sidecar
COPY --from=build /app/dist .

# server-entrypoint.mjs only uses Node built-ins (http/fs/path/url).
# The runtime stage therefore needs no npm install at all — the earlier
# `npm install http-proxy` was a dead dependency.
# One COPY for all runtime sources: OrbStack's buildkit races on concurrent
# context reads for multiple COPY lines (checksum mismatch), so keep it single.
COPY package.json server-entrypoint.mjs novnc-route.mjs ./
EXPOSE 80
CMD ["node", "server-entrypoint.mjs"]
