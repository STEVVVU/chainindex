# syntax=docker/dockerfile:1

# Multi-stage build. The builder carries the C++ toolchain that better-sqlite3 needs
# when no prebuilt binary matches; the runtime image carries neither the toolchain nor
# the dev dependencies.
FROM node:24-bookworm-slim AS builder

# better-sqlite3 is a native addon. Prebuilds cover common platforms, but keeping
# node-gyp's prerequisites here means the build does not silently depend on one being
# published for this base image.
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dependency installation is cached independently of source.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reduce to production dependencies only. This rebuilds the native addon against the
# same Node ABI the runtime stage uses.
RUN npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Persisted SQLite lives on a volume, owned by the unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Default to the container-facing bind address and volume path. Both are plain
# overridable env vars; see .env.example for the full set.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/chainindex.sqlite

EXPOSE 3000
VOLUME ["/data"]

# Drop privileges: the service needs no root capability. It also holds no private key,
# so its only secret is the RPC URL.
USER node

# The API exposes /health, which reports checkpoint and backfill state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `serve` runs the indexing loop and the read-only query API in one process, matching
# the single-writer-per-SQLite-database assumption in docs/ARCHITECTURE.md.
CMD ["node", "dist/cli.js", "serve"]
