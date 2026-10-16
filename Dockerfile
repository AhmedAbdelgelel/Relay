# syntax=docker/dockerfile:1
#
# T21 — reproducible image for the LLM gateway.
# Two stages: build (full deps + tsc) -> runtime (prod deps only, non-root).
#
#   docker build -t llm-gateway .
#   docker run --rm -p 3000:3000 llm-gateway
#
# PORT is honored (read by src/infrastructure/config.ts; default 3000), e.g.:
#   docker run --rm -e PORT=8080 -p 8080:8080 llm-gateway
# The container HEALTHCHECK probes GET /health (registered in
# src/api/routes/chat.ts) using Node 24's global fetch — no curl/wget needed.

# ---------- Stage 1: build ----------
# Full dependency install on purpose: the build needs the `typescript`
# devDependency for `npm run build` (= tsc -p tsconfig.json -> dist/).
FROM node:24-alpine AS build
WORKDIR /app
# Lockfile-first copy: the npm layer stays cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# package.json must ship as well: it carries "type":"module", which the ESM
# output in dist/ needs at import time — the image is not just dist/ alone.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The playground UI is served from process.cwd()/public at runtime
# (src/api/routes/playground.ts) -> public/ must exist under /app.
COPY public ./public
# Manual-apply migration records referenced by the runbook (the pgvector DDL
# itself is embedded in dist/ code, so boot does not depend on these files);
# copied for operators, a few KB.
COPY db ./db
# The image ships the built-in non-root `node` user (uid 1000); hand it /app.
RUN chown -R node:node /app
USER node
# Documentation only; the actual bind port comes from PORT (default 3000).
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
