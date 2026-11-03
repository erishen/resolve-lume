# syntax=docker/dockerfile:1
# resolve-lume sidecar — zero-dependency Node HTTP gateway + feature backend.
# Runs entirely on Node built-ins (no npm install) so the build never needs network.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./package.json
COPY store.js ./store.js
COPY agent.js ./agent.js
COPY server.js ./server.js
RUN mkdir -p /app/.data
ENV DATA_DIR=/app/.data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
