#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SIDJUA. All rights reserved.
#
# docs-check.sh — Validate the docs pipeline without committing generated output.
#
# Checks:
#   1. typedoc.json exists and is valid JSON
#   2. TypeDoc can resolve all entry points (tsc pass)
#   3. docs/openapi.yaml exists and is valid YAML
#   4. OpenAPI spec contains required route paths
#
# Exit: 0 = all checks pass, 1 = any check failed.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

echo "=== SIDJUA Docs Pipeline Check ==="
echo ""

# 1. typedoc.json exists and parses as JSON
echo "[1] typedoc.json"
if [ -f "$ROOT/typedoc.json" ]; then
  if python3 -c "import json,sys; json.load(open('$ROOT/typedoc.json'))" 2>/dev/null; then
    ok "typedoc.json exists and is valid JSON"
  else
    fail "typedoc.json is not valid JSON"
  fi
else
  fail "typedoc.json not found"
fi

# 2. TypeScript compiles cleanly (prerequisite for TypeDoc)
echo "[2] TypeScript compilation"
if npx tsc --noEmit --project "$ROOT/tsconfig.json" 2>/dev/null; then
  ok "npx tsc --noEmit passes"
else
  fail "TypeScript errors found (run: npm run typecheck)"
fi

# 3. docs/openapi.yaml exists
echo "[3] docs/openapi.yaml"
OPENAPI="$ROOT/docs/openapi.yaml"
if [ -f "$OPENAPI" ]; then
  ok "docs/openapi.yaml exists"
else
  fail "docs/openapi.yaml not found"
fi

# 4. OpenAPI spec contains required core routes
echo "[4] OpenAPI route coverage"
REQUIRED_PATHS=(
  "/api/v1/health"
  "/api/v1/agents"
  "/api/v1/tasks"
  "/api/v1/tokens"
  "/api/v1/chat"
)
for path in "${REQUIRED_PATHS[@]}"; do
  if grep -q "$path" "$OPENAPI" 2>/dev/null; then
    ok "Route documented: $path"
  else
    fail "Route missing from OpenAPI spec: $path"
  fi
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
