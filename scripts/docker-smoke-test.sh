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
#   ./scripts/docker-smoke-test.sh                       # default: sidjua:<version>-amd64 (local build)
#   ./scripts/docker-smoke-test.sh sidjua/sidjua:latest
#   IMAGE=my-custom-tag ./scripts/docker-smoke-test.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_VERSION=$(node -p "require('${SCRIPT_DIR}/../package.json').version" 2>/dev/null || echo "unknown")

IMAGE="${1:-${IMAGE:-sidjua:${EXPECTED_VERSION}-amd64}}"

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
PORT="${SIDJUA_PORT:-47821}"
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

if echo "$HEALTH" | grep -q "\"version\":\"${EXPECTED_VERSION}\""; then
  pass "Health endpoint reports version ${EXPECTED_VERSION}"
else
  fail "Health endpoint version — got: ${HEALTH}"
fi

# ---------------------------------------------------------------------------
# CLI inside container
# ---------------------------------------------------------------------------

VERSION_OUT=$(docker exec "$CONTAINER" sidjua --version 2>/dev/null || echo "")
if echo "$VERSION_OUT" | grep -q "${EXPECTED_VERSION}"; then
  pass "sidjua --version outputs ${EXPECTED_VERSION}"
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

ERRORS=$(docker logs "$CONTAINER" 2>&1 | grep -E "^\[ERROR\]|^\[FATAL\]|Uncaught|UnhandledPromise" || true)
if [ -n "$ERRORS" ]; then
  echo "FAIL: Container logs contain errors:"
  echo "$ERRORS" | head -5
  FAIL=$((FAIL + 1))
else
  echo "PASS: No ERROR/FATAL in container logs"
  PASS=$((PASS + 1))
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
