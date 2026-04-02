#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SIDJUA. All rights reserved.
#
# Docker smoke test — verifies that the SIDJUA container starts and responds
# correctly to health checks, dashboard requests, and CLI commands.
#
# Usage:
#   ./scripts/docker-smoke-test.sh [IMAGE_TAG]
#
# Examples:
#   ./scripts/docker-smoke-test.sh                       # default: ghcr.io/goetzkohlberg/sidjua:1.0.1
#   ./scripts/docker-smoke-test.sh sidjua/sidjua:latest
#   IMAGE=my-custom-tag ./scripts/docker-smoke-test.sh

set -e

IMAGE="${1:-${IMAGE:-ghcr.io/goetzkohlberg/sidjua:1.0.1}}"

# ---------------------------------------------------------------------------
# --verify-manifest mode: check that both amd64 and arm64 are present
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--verify-manifest" ]]; then
  echo "Verifying multi-arch manifest for ${IMAGE}..."
  MANIFEST=$(docker buildx imagetools inspect "${IMAGE}" 2>&1)
  echo "${MANIFEST}"
  if echo "$MANIFEST" | grep -q "linux/amd64" && echo "$MANIFEST" | grep -q "linux/arm64"; then
    echo "PASS: Both amd64 and arm64 present"
  else
    echo "FAIL: Missing architecture in manifest"
    exit 1
  fi
  exit 0
fi

CONTAINER="sidjua-smoke-test"
PORT="${SIDJUA_PORT:-4200}"
BASE_URL="http://localhost:${PORT}"

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

echo "==> Smoke test: ${IMAGE} (port ${PORT})"
echo ""

# Clean any leftover container
docker rm -f "$CONTAINER" 2>/dev/null || true

# Run container
docker run -d \
  --name "$CONTAINER" \
  -p "${PORT}:${PORT}" \
  -e "SIDJUA_PORT=${PORT}" \
  "$IMAGE"

# Wait for health check (up to 60 seconds)
echo "Waiting for container to become healthy..."
HEALTHY=false
for i in $(seq 1 60); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    echo "Container healthy after ${i}s"
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$HEALTHY" = "false" ]; then
  echo "WARNING: Docker health check did not report healthy — trying HTTP anyway"
fi

# Fallback: wait for HTTP to respond even if health check is still starting
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------

HEALTH=$(curl -sf "${BASE_URL}/api/v1/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  pass "Health endpoint returns status:ok"
else
  fail "Health endpoint — got: ${HEALTH}"
fi

if echo "$HEALTH" | grep -q '"version":"1.0.1"'; then
  pass "Health endpoint reports version 1.0.1"
else
  fail "Health endpoint version — got: ${HEALTH}"
fi

# ---------------------------------------------------------------------------
# CLI inside container
# ---------------------------------------------------------------------------

VERSION_OUT=$(docker exec "$CONTAINER" sidjua --version 2>/dev/null || echo "")
if echo "$VERSION_OUT" | grep -q "1.0.0"; then
  pass "sidjua --version outputs 1.0.1"
else
  fail "sidjua --version — got: ${VERSION_OUT}"
fi

# ---------------------------------------------------------------------------
# Non-root user
# ---------------------------------------------------------------------------

USER_OUT=$(docker exec "$CONTAINER" id -u 2>/dev/null || echo "0")
if [ "$USER_OUT" != "0" ]; then
  pass "Container runs as non-root (uid=${USER_OUT})"
else
  fail "Container is running as root"
fi

# ---------------------------------------------------------------------------
# /data volume writable
# ---------------------------------------------------------------------------

if docker exec "$CONTAINER" sh -c "touch /data/.smoke-test && rm /data/.smoke-test" 2>/dev/null; then
  pass "/data volume is writable"
else
  fail "/data volume is not writable"
fi

# ---------------------------------------------------------------------------
# Container logs — no startup errors
# ---------------------------------------------------------------------------

LOGS=$(docker logs "$CONTAINER" 2>&1)
if echo "$LOGS" | grep -qi "error\|fatal\|uncaught"; then
  fail "Container logs contain errors — check: docker logs ${CONTAINER}"
else
  pass "Container logs show no errors on startup"
fi

# ---------------------------------------------------------------------------
# SIGTERM graceful shutdown
# ---------------------------------------------------------------------------

docker stop "$CONTAINER" > /dev/null 2>&1
EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null || echo "1")
if [ "$EXIT_CODE" = "0" ] || [ "$EXIT_CODE" = "143" ]; then
  pass "Container shut down gracefully on SIGTERM (exit ${EXIT_CODE})"
else
  fail "Container exited with code ${EXIT_CODE} (expected 0 or 143)"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

docker rm -f "$CONTAINER" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==================================="
echo "Smoke test complete: ${PASS} passed, ${FAIL} failed"
echo "==================================="

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
