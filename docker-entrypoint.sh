#!/bin/sh
set -e

# P2b (P454 Option 1): workDir is now /data (the Docker volume mount point).
# --work-dir /data is passed in the Dockerfile CMD (CMD is the canonical owner of --work-dir).
# All persistent state (DB, config, governance, uploads, sessions) lands on the /data volume.
# /app remains the process CWD for read-only image content (dist, locales, static, sidjua-gui).

# Ensure persistent data directories exist on the /data volume (idempotent, first-boot safe).
mkdir -p /data/.system /data/config /data/governance /data/uploads /data/logs

# Error log with PII redaction (written by the Node.js process via SIDJUA_ERROR_LOG env).
export SIDJUA_ERROR_LOG="/data/logs/sidjua-error.log"

# First-run detection: seed default divisions.yaml into /data if not present.
# sidjua apply (--work-dir /data) resolves the config path as /data/divisions.yaml.
if [ ! -f /data/divisions.yaml ]; then
  echo "First run detected — seeding default divisions.yaml into /data"
  cp /app/defaults/divisions.yaml /data/divisions.yaml 2>/dev/null || true
fi

# Q4 (P454 CEO decision): wipe session files on every container start so users
# must re-authenticate after a container replacement or restart. Simpler and more
# secure than session survival across container boundaries.
rm -rf /data/.system/sessions 2>/dev/null || true

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
sidjua apply --force --work-dir /data 2>&1 || {
  echo "[WARN] Provisioning failed — server will start but agents may be missing"
}

# Inject --port from SIDJUA_PORT env var when starting the API server.
# This lets operators override the port without rebuilding the image:
#   docker run -e SIDJUA_PORT=8080 -p 8080:8080 sidjua/sidjua:1.0.0
# --work-dir /data is already embedded in the Dockerfile CMD, not re-injected here.
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
