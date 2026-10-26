# syntax=docker/dockerfile:1
#
# Relay control plane (web/) — production image for the Next.js 16 App Router UI.
#
# BUILD CONTEXT MUST BE web/, NOT THE REPO ROOT:
#   docker build -t relay-web --build-arg GATEWAY_URL=http://gateway:3000 web/
#   (docker compose up --build builds and wires both images for you; see
#    docker-compose.yml at the repo root.)
#
# GATEWAY_URL is baked in at BUILD time: web/next.config.ts reads it while
# `rewrites()` runs during `next build`, and Next.js serialises the rewrite
# destinations into .next/routes-manifest.json. Pass --build-arg
# GATEWAY_URL=<gateway origin>; setting it only at container start does NOT
# retarget an existing image — rebuild to change it. Inside the compose network
# the gateway origin is http://gateway:3000; for a standalone container against
# a gateway on the host use http://host.docker.internal:3000.
#
# Runtime: `next start` on PORT=3001, runs as the image's non-root `node` user,
# dev deps pruned (prod-only `npm ci --omit=dev`). Docker HEALTHCHECK probes "/"
# (not "/health", which is a proxy to the gateway).

# ---------- Stage 1: dependencies (lockfile-exact; dev deps needed for the build) ----------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- Stage 2: production build ----------
FROM node:24-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
# The web/.dockerignore keeps node_modules, .next, .env* and test files out.
COPY . .
# Guarantee web/public exists so the runtime stage can copy it unconditionally
# (the current app has no public/ directory; if you add one, it is copied).
RUN mkdir -p public
# Baked into .next/routes-manifest.json by `npm run build` (see header).
ARG GATEWAY_URL=http://relay-gateway
ENV GATEWAY_URL=$GATEWAY_URL
RUN npm run build

# ---------- Stage 3: runtime (production dependencies only, non-root) ----------
FROM node:24-slim AS runner
WORKDIR /app
ARG GATEWAY_URL=http://relay-gateway
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001 \
    GATEWAY_URL=$GATEWAY_URL
# package.json is required (npm start, "private", no "type"), lockfile for the
# exact prod tree. next/react/react-dom are runtime dependencies, so this is all
# `next start` needs besides .next/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/.next ./.next
# next.config.ts is loaded by `next start` (the rewrite destinations themselves
# come from .next/routes-manifest.json, but keep config + tsconfig for parity).
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/public ./public
RUN chown -R node:node /app
USER node
EXPOSE 3001
# Container liveness for Docker; probes "/" and not "/health" (which proxies the
# gateway, so it would couple web liveness to the gateway being up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["npm", "start"]
