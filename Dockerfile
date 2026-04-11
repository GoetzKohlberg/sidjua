# syntax=docker/dockerfile:1
# SIDJUA — AI Governance Platform
# AGPL-3.0-only | https://github.com/sidjua-dev/sidjua

# Build-time arguments (injected by scripts/build-docker.sh)
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
ARG BUILD_SIGNATURE
ARG BUILD_NUMBER=0

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Install native-module build dependencies (better-sqlite3 requires these)
RUN apk add --no-cache python3 make g++ build-base linux-headers

WORKDIR /build

# Install all dependencies (devDeps needed for build tools)
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source files
COPY src/ ./src/
COPY tsup.config.ts tsconfig.json vitest.config.ts ./

# Compile TypeScript → dist/
RUN npm run build

# Build GUI (served at / by the API server)
# --ignore-scripts skips the @tauri-apps/cli binary download (not needed for web build)
WORKDIR /build/sidjua-gui
COPY sidjua-gui/package.json sidjua-gui/package-lock.json ./
RUN npm ci --ignore-scripts
COPY sidjua-gui/src/       ./src/
COPY sidjua-gui/public/    ./public/
COPY sidjua-gui/index.html sidjua-gui/tsconfig.json sidjua-gui/tsconfig.node.json sidjua-gui/vite.config.ts ./
RUN npm run build
WORKDIR /build

# Strip devDependencies — keeps only production node_modules
RUN npm prune --production

# Remove TypeScript declaration files that are only needed at build time
# (@types/* packages end up in dependencies rather than devDependencies in some packages;
#  source maps and .d.ts files serve no purpose in the production container)
RUN find node_modules/@types -maxdepth 0 -exec rm -rf {} + 2>/dev/null || true; \
    find node_modules -name "*.d.ts" -not -path "*/better-sqlite3/*.d.ts" -delete 2>/dev/null || true; \
    find node_modules -name "*.map" -delete 2>/dev/null || true

# ─── Stage 2: Production ─────────────────────────────────────────────────────
FROM node:22-alpine AS production
ARG VERSION="dev"
ARG BUILD_DATE="unknown"
ARG VCS_REF="unknown"
ARG BUILD_SIGNATURE="unknown"
ARG BUILD_NUMBER=0

# Propagate build args to runtime environment
# Default runtime configuration (all overridable via -e at docker run time)
ENV SIDJUA_VERSION=$VERSION \
    BUILD_DATE=$BUILD_DATE \
    VCS_REF=$VCS_REF \
    BUILD_NUMBER=$BUILD_NUMBER \
    SIDJUA_PORT=47821 \
    SIDJUA_DATA_DIR=/data \
    SIDJUA_LOG_LEVEL=info \
    SIDJUA_GUI_BOOTSTRAP=true \
    NODE_ENV=production

LABEL org.opencontainers.image.title="SIDJUA Free" \
      org.opencontainers.image.description="SIDJUA Free — Multi-Agent Governance Framework" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.vendor="Götz Kohlberg" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/sidjua-dev/sidjua" \
      org.opencontainers.image.url="https://sidjua.io" \
      com.sidjua.build.signature="${BUILD_SIGNATURE}" \
      com.sidjua.security.non-root="true" \
      com.sidjua.security.uid="1001" \
      com.sidjua.security.read-only-app="true" \
      com.sidjua.security.no-new-privileges="true"

# Runtime-only system packages:
#   tini        — PID 1 init (proper signal forwarding + zombie reaping)
#   tar         — required by backup/restore engine (Phase 10.9)
#   sqlite      — CLI for production debugging / migrations
#   bubblewrap  — sandbox isolation via user namespaces (Phase 19)
#   socat       — Unix socket bridge for bwrap network isolation (Phase 19)
#
# NOTE: Using bubblewrap inside Docker requires SYS_ADMIN capability:
#   docker run --cap-add=SYS_ADMIN --security-opt seccomp=unconfined sidjua:latest
# Without this, bwrap cannot create user namespaces and will error at runtime.
# The "none" sandbox provider (default) works without any extra capabilities.
RUN apk add --no-cache tini tar sqlite bubblewrap socat

# Create non-root user (uid/gid 1001)
RUN addgroup -g 1001 sidjua && \
    adduser -u 1001 -G sidjua -H -D sidjua

WORKDIR /app

# Create runtime data directories (volumes will be mounted here)
RUN mkdir -p \
    /app/data/backups \
    /app/data/knowledge \
    /app/data/governance-snapshots \
    /app/config \
    /app/logs \
    /app/defaults

# Copy compiled artifacts + production node_modules from builder
COPY --from=builder /build/dist/             ./dist/
COPY --from=builder /build/node_modules/     ./node_modules/
COPY --from=builder /build/package.json      ./
# Copy GUI build (served at / by `sidjua server start`)
COPY --from=builder /build/sidjua-gui/dist/  ./sidjua-gui/dist/
# Copy locale JSON files (loader resolves ../locales/ relative to dist/index.js = /app/locales/)
COPY --from=builder /build/src/locales/      ./locales/
# Copy static assets (org-public.ts resolves ../static/glasscheibe-widget.js relative to dist/index.js = /app/static/)
COPY --from=builder /build/src/api/static/   ./static/

# Copy entrypoint and bundled default configs
COPY docker-entrypoint.sh ./
RUN chmod +x /app/docker-entrypoint.sh
COPY defaults/ ./defaults/
COPY docs/    ./docs/
COPY system/  ./system/
COPY NOTICE ./

# Embed build metadata for runtime verification
RUN printf '{"version":"%s","build":"%s","ref":"%s","vendor":"sidjua","sig":"%s","build_number":%s}\n' \
    "${VERSION}" "${BUILD_DATE}" "${VCS_REF}" "${BUILD_SIGNATURE}" "${BUILD_NUMBER}" > /app/.build-meta

# Install sidjua as a global CLI binary
RUN printf '#!/bin/sh\nexec node /app/dist/index.js "$@"\n' > /usr/local/bin/sidjua \
    && chmod +x /usr/local/bin/sidjua \
    && cat /usr/local/bin/sidjua \
    && sidjua --version

# Pre-create persistent directories so Docker named volumes initialize with correct ownership
RUN mkdir -p \
    /app/.system \
    /app/agents/skills \
    /app/agents/definitions \
    /app/agents/templates \
    /app/governance/audit

# Persistent data volume (SQLite databases, agent configs, knowledge base)
# /data is declared as a VOLUME so Docker creates a named volume for it.
RUN mkdir -p /data

VOLUME ["/data"]

# Make read-only app directories non-writable (defence-in-depth)
# Writable at runtime: /app/.system  /app/config  /app/logs  /app/data  /data
RUN chmod -R 555 /app/dist /app/node_modules /app/locales /app/static /app/sidjua-gui /app/defaults /app/docs

# Transfer ownership to non-root user before switching
RUN chown -R sidjua:sidjua /app /data

USER sidjua

EXPOSE 47821

# Health check hits the public /api/v1/health endpoint (no auth required)
# Reads SIDJUA_PORT at runtime so override via -e SIDJUA_PORT=XXXX is respected
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.SIDJUA_PORT||'47821')+'/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# tini → entrypoint.sh → CMD
# --host 0.0.0.0 is required so Docker port mapping works (default 127.0.0.1 is loopback-only)
# Port is injected by docker-entrypoint.sh from SIDJUA_PORT (default 47821)
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js", "server", "start", "--host", "0.0.0.0"]
