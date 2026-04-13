#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SIDJUA GUI — web build script
#
# Usage:
#   ./scripts/build.sh
#
# Produces web assets in dist/
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Building SIDJUA GUI"

cd "$GUI_DIR"

# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || { echo "node not found" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm not found"  >&2; exit 1; }

echo "==> Installing npm dependencies"
npm ci --prefer-offline 2>/dev/null || npm install

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

echo "==> Running build"
npm run build

# ---------------------------------------------------------------------------
# Summarise artifacts
# ---------------------------------------------------------------------------

DIST_DIR="$GUI_DIR/dist"

echo ""
echo "==> Build complete. Artifacts in $DIST_DIR:"
find "$DIST_DIR" -type f | while read -r f; do echo "    $f ($(du -sh "$f" | cut -f1))"; done

echo ""
echo "Done."
