#!/usr/bin/env bash
# scripts/test-endpoints.sh — Automated endpoint smoke test
# Usage: bash scripts/test-endpoints.sh http://localhost:4200
set -euo pipefail

URL="${1:-http://localhost:4200}"
PASS=0; FAIL=0; TOTAL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

check() {
    local method="$1" path="$2" expect="$3" desc="$4"
    TOTAL=$((TOTAL + 1))
    local code
    if [ "$method" = "GET" ]; then
        code=$(curl -s -o /dev/null -w "%{http_code}" "${URL}${path}" 2>/dev/null || echo "000")
    else
        code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "${URL}${path}" \
            -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")
    fi
    if [ "$code" = "$expect" ]; then
        echo -e "  ${GREEN}PASS${NC} [$code] $method $path — $desc"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} [$code] $method $path — expected $expect — $desc"
        FAIL=$((FAIL + 1))
    fi
}

echo "═══════════════════════════════════════"
echo " ENDPOINT TEST — $URL"
echo " $(date -u +'%Y-%m-%d %H:%M UTC')"
echo "═══════════════════════════════════════"

# Core endpoints
check GET  "/api/v1/health"   200 "Health check"
check GET  "/api/v1/version"  200 "Version info"

# Auth-required endpoints (expect 401 without token)
check GET  "/api/v1/agents"         401 "Agents list (needs auth)"
check GET  "/api/v1/divisions"      401 "Divisions (needs auth)"
check GET  "/api/v1/governance"     401 "Governance (needs auth)"
check GET  "/api/v1/config"         401 "Config (needs auth)"

# SSE ticket endpoint (needs auth)
check POST "/api/v1/sse/ticket"     401 "SSE ticket (needs auth)"

# SSE events endpoint (should pass through to handler, not 401 from middleware)
# Without ticket, handler should return 401 (not middleware AUTH-001)
check GET  "/api/v1/events"         401 "SSE events (no ticket = handler 401)"

# GUI serving
check GET  "/"                      200 "GUI index.html"

# Verify version matches package.json
VERSION_BODY=$(curl -s "${URL}/api/v1/version" 2>/dev/null || echo "{}")
if echo "$VERSION_BODY" | grep -q "1.0.1"; then
    echo -e "  ${GREEN}PASS${NC} Version body contains 1.0.1"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${NC} Version body does not contain 1.0.1: $VERSION_BODY"
    FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

echo ""
echo "═══════════════════════════════════════"
echo " RESULT: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════"

[ $FAIL -eq 0 ] && exit 0 || exit 1

