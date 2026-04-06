#!/usr/bin/env bash
# scripts/secret-scan.sh — Scan code for leaked secrets/internal data
set -euo pipefail
cd "$(dirname "$0")/.."

ISSUES=0
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

echo "  Scanning for secrets and internal data..."

# Hardcoded IPs
HITS=$(grep -rn "192\.168\.\|135\.181\." src/ sidjua-gui/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "// pipeline-ok\|test\|example\|mock" || true)
if [ -n "$HITS" ]; then
    echo -e "  ${RED}FAIL${NC} Hardcoded IPs:"
    echo "$HITS" | head -5
    ISSUES=$((ISSUES + 1))
fi

# API keys / tokens — require enough chars to avoid matching doc placeholders (sk-..., sk-*)
HITS=$(grep -rPn "\bsk-[a-zA-Z0-9-]{20,}|\bAKIA[A-Z0-9]{16}\b|api_key.*=['\"].{20,}" src/ sidjua-gui/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "test\|example\|mock\|placeholder\|process\.env\|pipeline-ok" || true)
if [ -n "$HITS" ]; then
    echo -e "  ${RED}FAIL${NC} Possible API keys:"
    echo "$HITS" | head -5
    ISSUES=$((ISSUES + 1))
fi

# .env files in git
HITS=$(git ls-files | grep "\.env" | grep -v "\.example" || true)
if [ -n "$HITS" ]; then
    echo -e "  ${RED}FAIL${NC} .env files tracked:"
    echo "$HITS"
    ISSUES=$((ISSUES + 1))
fi

# Large files
HITS=$(find src/ sidjua-gui/src/ -size +1M -type f 2>/dev/null || true)
if [ -n "$HITS" ]; then
    echo -e "  ${RED}FAIL${NC} Large files (>1MB):"
    echo "$HITS"
    ISSUES=$((ISSUES + 1))
fi

# Internal hostnames in code
HITS=$(grep -rn "sidjua-dev@\|root@135\|hetzner" src/ sidjua-gui/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || true)
if [ -n "$HITS" ]; then
    echo -e "  ${RED}FAIL${NC} Internal hostnames:"
    echo "$HITS" | head -5
    ISSUES=$((ISSUES + 1))
fi

if [ $ISSUES -gt 0 ]; then
    echo -e "  ${RED}SECRET SCAN: $ISSUES issue(s) found${NC}"
    exit 1
else
    echo -e "  ${GREEN}SECRET SCAN: clean${NC}"
fi

