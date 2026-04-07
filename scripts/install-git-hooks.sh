#!/usr/bin/env bash
# scripts/install-git-hooks.sh — Install version-tracked git hooks into .git/hooks/
#
# Usage:
#   bash scripts/install-git-hooks.sh
#
# Idempotent: safe to run multiple times. Backs up any existing hook that
# differs from the source before overwriting.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_SRC="${REPO_ROOT}/scripts/git-hooks"
HOOKS_DST="${REPO_ROOT}/.git/hooks"

echo "Installing git hooks from ${HOOKS_SRC} → ${HOOKS_DST}"

# ---------------------------------------------------------------------------
# pre-push
# ---------------------------------------------------------------------------
HOOK_NAME="pre-push"
HOOK_SRC="${HOOKS_SRC}/${HOOK_NAME}"
HOOK_DST="${HOOKS_DST}/${HOOK_NAME}"

if [ ! -f "$HOOK_SRC" ]; then
  echo "  FAIL: source hook not found: $HOOK_SRC"
  exit 1
fi

if [ -f "$HOOK_DST" ] && ! cmp -s "$HOOK_SRC" "$HOOK_DST"; then
  BACKUP="${HOOK_DST}.bak.$(date +%s)"
  cp "$HOOK_DST" "$BACKUP"
  echo "  existing ${HOOK_NAME} backed up → $(basename "$BACKUP")"
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "  ${HOOK_NAME} installed ($(ls -lh "$HOOK_DST" | awk '{print $5}'))"

echo ""
echo "Done. Hooks installed:"
ls -la "${HOOKS_DST}/pre-push"
