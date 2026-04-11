#!/bin/sh
set -e

# Ensure data directories exist (volumes may be freshly mounted)
mkdir -p /app/data/backups /app/data/knowledge /app/data/governance-snapshots
mkdir -p /app/config /app/logs /data/logs

# Error log with PII redaction (written by the Node.js process)
export SIDJUA_ERROR_LOG="/data/logs/sidjua-error.log"

# First-run detection: copy bundled default config if none exists
if [ ! -f /app/config/divisions.yaml ]; then
  echo "First run detected — creating default divisions.yaml"
  cp /app/defaults/divisions.yaml /app/config/divisions.yaml 2>/dev/null || true
fi

# Ensure divisions.yaml is available at /app/divisions.yaml (default config path for `sidjua apply`)
if [ ! -f /app/divisions.yaml ]; then
  cp /app/defaults/divisions.yaml /app/divisions.yaml 2>/dev/null || true
fi

# --- Startup Info ---
# Security check: warn if running as root
if [ "$(id -u)" = "0" ]; then
  echo "[WARN] Running as root is not recommended. Use: docker run --user 1001:1001"
fi
echo "[INFO] Platform: $(uname -m)"
echo "[INFO] SIDJUA ${SIDJUA_VERSION:-unknown} starting on port ${SIDJUA_PORT:-47821}"

# --- First-Run Provisioning ---
# Apply divisions + agents on every startup (idempotent).
# Ensures starter agents are registered in the DB even on first boot.
echo "[INFO] Running provisioning (sidjua apply)..."
sidjua apply --force --work-dir /app 2>&1 || {
  echo "[WARN] Provisioning failed — server will start but agents may be missing"
}

# Inject --port from SIDJUA_PORT env var when starting the API server.
# This lets operators override the port without rebuilding the image:
#   docker run -e SIDJUA_PORT=8080 -p 8080:8080 sidjua/sidjua:1.0.0
PORT="${SIDJUA_PORT:-47821}"

# Only inject --port when the CMD looks like a server start invocation.
# Direct `docker exec` calls (sidjua --version, sidjua init, etc.) bypass this script.
case "$*" in
  *"server start"*)
    exec "$@" --port "$PORT"
    ;;
  *)
    exec "$@"
    ;;
esac
