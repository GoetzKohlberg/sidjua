#!/bin/bash
# SIDJUA — AI Agent Governance Platform
# Double-click to stop SIDJUA on macOS.

cd "$(dirname "$0")"

echo ""
echo " ┌─────────────────────────────────────────┐"
echo " │  SIDJUA — AI Agent Governance Platform  │"
echo " │  Stopping...                            │"
echo " └─────────────────────────────────────────┘"
echo ""

# ------------------------------------------------------------
# 1. Check Docker is installed
# ------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    echo " Docker Desktop is not installed."
    echo " Nothing to stop."
    echo ""
    read -rp " Press Enter to close..." _
    exit 0
fi

# ------------------------------------------------------------
# 2. Stop SIDJUA
# ------------------------------------------------------------
echo " Stopping SIDJUA..."
docker compose down

if [ $? -eq 0 ]; then
    echo ""
    echo " ✓ SIDJUA stopped."
else
    echo ""
    echo " SIDJUA was not running or could not be stopped."
fi

echo ""
read -rp " Press Enter to close..." _
exit 0
