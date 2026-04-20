# SIDJUA Persistence Layout — Architecture Document

**Status:** SIGNED-OFF — Ready for Impl Prompt 2b
**Author:** Sonnet T2 Dev Lead
**Date:** 2026-04-15
**Sign-off:** CEO Goetz Kohlberg, 2026-04-15, via Opus T1

---

## 1. Two-Domain Framing

SIDJUA runs in two fundamentally different deployment modes with incompatible persistence requirements.

### Domain A — Container Runtime (`docker run` / `docker compose`)

- `/data` and `/app/*` are both writable at runtime, but only explicitly-mounted volumes survive `docker rm`.
- Container writable layer is ephemeral: destroyed on `docker rm` (unless committed, which is never done).
- State not on a mounted volume is **lost on every container replacement**.
- Two sub-variants exist — see Section 3.

### Domain B — Local CLI (`sidjua server start` on developer machine)

- `workDir = process.cwd()` by default, or `--work-dir <path>`.
- No Docker volumes. All state lives on the local filesystem.
- No persistence gap: workDir contents survive unless the user deletes them.
- **This domain must not be broken by any container persistence fix.**

---

## 2. Path System Inventory

Two independent path resolution systems coexist in the Node.js codebase. They are never unified.

### System 1 — `opts.workDir` (CLI option, default: `process.cwd()`)

Used by `server-startup.ts`, `start.ts`, `db-init.ts`, and all CLI commands.
All paths constructed directly as `join(opts.workDir, ...)`.

| Path template | Concrete path (workDir = /app) | Purpose |
|---|---|---|
| `workDir/.system/sidjua.db` | `/app/.system/sidjua.db` | Main SQLite database |
| `workDir/.system/server.pid` | `/app/.system/server.pid` | Server process identity |
| `workDir/.system/sessions/<id>.json` | `/app/.system/sessions/` | GUI session files |
| `workDir/.system/state.json` | `/app/.system/state.json` | Orchestrator state |
| `workDir/config/config.json` | `/app/config/config.json` | GUI admin config (password hash + session secret) |
| `workDir/config/mcp-servers.yaml` | `/app/config/mcp-servers.yaml` | MCP server config |
| `workDir/governance/orchestrator.yaml` | `/app/governance/orchestrator.yaml` | Orchestrator config |
| `workDir/modules/` | `/app/modules/` | Installed modules |
| `workDir/data/uploads/` | `/app/data/uploads/` | Uploaded files |

Source: `server-startup.ts:112,278,334,347`, `start.ts:110,131,465,496`, `session.ts` (FileSessionStore), `db-init.ts:80`.

### System 2 — `paths.ts DataPaths` (via `SIDJUA_DATA_DIR` env, `sidjua.config.json`, or `~/.sidjua`)

Used by `getPaths()` / `resolvePaths()` callers.

| `DataPaths` field | Path when `SIDJUA_DATA_DIR=/data` | Path when `SIDJUA_DATA_DIR=/app/data` | Local CLI default |
|---|---|---|---|
| `data.root` | `/data` | `/app/data` | `~/.sidjua` |
| `data.config` | `/data/config` | `/app/data/config` | `~/.sidjua/config` |
| `data.secrets` | `/data/secrets` | `/app/data/secrets` | `~/.sidjua/secrets` |
| `data.logs` | `/data/logs` | `/app/data/logs` | `~/.sidjua/logs` |
| `data.knowledge` | `/data/knowledge` | `/app/data/knowledge` | `~/.sidjua/knowledge` |
| `data.backups` | `/data/backups` | `/app/data/backups` | `~/.sidjua/backups` |
| `data.governance` | `/data/governance` | `/app/data/governance` | `~/.sidjua/governance` |

Source: `src/core/paths.ts:157-168`. Callers: `src/core/provider-config.ts`, `src/index.ts:259`, `src/cli/commands/rollback.ts`, `src/cli/commands/update.ts`, `src/cli/commands/version.ts`, `src/cli/commands/rules.ts`.

### System 3 — Hardcoded container-specific paths

| Hardcoded value | Source location | Note |
|---|---|---|
| `baseDir: '/data/uploads'` | `src/uploads/file-storage.ts:41` | DEFAULT_CONFIG — dead in container (overridden by server-startup.ts:347 to `workDir/data/uploads`) |
| `"/data/logs"` | `src/tool-integration/internal/log-reader.ts:15` | ALLOWED_LOG_DIRS — container-specific |
| `"/data/backups/borg"` | `src/tool-integration/internal/backup-status.ts:14` | DEFAULT_BORG_REPO — container-specific |
| `SIDJUA_ERROR_LOG="/data/logs/sidjua-error.log"` | `docker-entrypoint.sh:9` | Set as env var; consumed by `server-startup.ts:413` |

---

## 3. Container Architecture — Two Sub-Variants (V1.0.x vs V1.1.0)

### Sub-variant A: V1.0.x — `docker-compose.yml` with 6 named volumes

**Source:** `docker-compose.yml` (image: `ghcr.io/goetzkohlberg/sidjua:1.0.1`)

```
SIDJUA_DATA_DIR=/app/data   (set in docker-compose.yml environment)
SIDJUA_PORT=4200
workDir = /app              (process.cwd(), WORKDIR /app)
```

**Named volumes declared in `docker-compose.yml` (lines 163–175):**

| Volume name | Container mount | Covers System 1 path(s) | Persistent? |
|---|---|---|---|
| `sidjua-data` | `/app/data` | `workDir/data/uploads/` | Yes |
| `sidjua-config` | `/app/config` | `workDir/config/config.json`, `workDir/config/mcp-servers.yaml` | Yes |
| `sidjua-logs` | `/app/logs` | `workDir/logs/` | Yes |
| `sidjua-system` | `/app/.system` | `workDir/.system/sidjua.db`, `workDir/.system/sessions/`, PID, state | Yes |
| `sidjua-workspace` | `/app/agents` | `workDir/agents/` (agent skills, definitions) | Yes |
| `sidjua-governance` | `/app/governance` | `workDir/governance/orchestrator.yaml` | Yes |

**Persistence status in V1.0.x: ALL critical paths are on named volumes. No gap.**

Docker run equivalent (single-container, no compose):
```bash
docker run -d \
  -v sidjua-system:/app/.system \
  -v sidjua-config:/app/config \
  -v sidjua-data:/app/data \
  -v sidjua-logs:/app/logs \
  -v sidjua-workspace:/app/agents \
  -v sidjua-governance:/app/governance \
  -e SIDJUA_DATA_DIR=/app/data \
  -p 47821:4200 \
  ghcr.io/goetzkohlberg/sidjua:1.0.1
```

---

### Sub-variant B: V1.1.0 — Dockerfile with single `/data` volume (current)

**Source:** `Dockerfile` (current main branch, image: `sidjua:1.1.0-amd64`)

```
SIDJUA_DATA_DIR=/data       (ENV in Dockerfile:67)
SIDJUA_PORT=47821
workDir = /app              (process.cwd(), WORKDIR /app — no --work-dir in CMD)
```

**Volume declared in `Dockerfile:179`:**

```dockerfile
VOLUME ["/data"]
```

Named conventionally `sidjua-data` when operator passes `-v sidjua-data:/data`.

Docker run (CEO Act deployment):
```bash
docker run -d \
  -v sidjua-data:/data \
  -p 47821:47821 \
  sidjua:1.1.0-amd64
```

**Persistence gap — V1.1.0:**

| Path | System 1 template | On `/data` volume? | Lost on docker rm? |
|---|---|---|---|
| `/app/.system/sidjua.db` | `workDir/.system/sidjua.db` | **NO** | **YES** |
| `/app/.system/sessions/` | `workDir/.system/sessions/` | **NO** | **YES** |
| `/app/.system/state.json` | `workDir/.system/state.json` | **NO** | **YES** |
| `/app/config/config.json` | `workDir/config/config.json` | **NO** | **YES** |
| `/app/config/mcp-servers.yaml` | `workDir/config/mcp-servers.yaml` | **NO** | **YES** |
| `/app/governance/orchestrator.yaml` | `workDir/governance/orchestrator.yaml` | **NO** | **YES** |
| `/app/data/uploads/` | `workDir/data/uploads/` | **NO** | **YES** |
| `/data/logs/sidjua-error.log` | `SIDJUA_ERROR_LOG` env | **YES** | no |
| `/data/backups/borg` | `DEFAULT_BORG_REPO` (if used) | **YES** | no |

**Summary: nothing from System 1 (workDir-based paths) is on the `/data` volume. `SIDJUA_DATA_DIR=/data` and `VOLUME ["/data"]` were added but `workDir` was never changed from `/app` to `/data`. V1.1.0 is a regression from V1.0.x.**

---

## 4. Root Cause

The V1.1.0 Dockerfile was refactored from 6 named volumes (V1.0.x docker-compose) to a single `/data` volume. The refactor:

1. Added `ENV SIDJUA_DATA_DIR=/data` — correctly routes `paths.ts DataPaths` to the volume.
2. Added `VOLUME ["/data"]` — declares the mount point.
3. **Did NOT** change `workDir` from `/app` to `/data`.
4. **Did NOT** add `-v` mounts for `/app/.system`, `/app/config`, `/app/governance`, etc. in the CMD or entrypoint.

`server-startup.ts` constructs all critical paths from `opts.workDir` and never consults `SIDJUA_DATA_DIR`. These two systems evolved independently and were never unified for V1.1.0.

---

## 5. Files That Must NOT Be on the Persistent Volume

| Path | Reason |
|---|---|
| `/app/dist/` | Read-only compiled code; baked into image |
| `/app/node_modules/` | Read-only; rebuilt per image |
| `/app/locales/` | Read-only locale JSON |
| `/app/static/` | Read-only static assets |
| `/app/sidjua-gui/` | Read-only GUI build |
| `/app/defaults/` | Read-only default configs (templates) |
| `/app/docs/` | Read-only documentation |
| `/app/system/` | Read-only system schemas/migrations (package-owned) |
| `.system/server.pid` | Process identity; must not survive restart |

These are all image-layer content (`chmod -R 555` in `Dockerfile:151`). Writing to them from a volume would be wrong.

---

## 6. Container First-Boot and Restart Flow (V1.1.0 current, broken)

```
docker run -v sidjua-data:/data sidjua:1.1.0-amd64
  └─ tini → docker-entrypoint.sh
       ├─ mkdir -p /app/data/backups /app/data/knowledge ...   # writable layer only
       ├─ mkdir -p /data/logs                                   # volume ✓
       ├─ SIDJUA_ERROR_LOG=/data/logs/sidjua-error.log         # volume ✓
       ├─ sidjua apply --force --work-dir /app
       │    └─ writes governance/, config/ → /app/*            # writable layer only
       └─ node dist/index.js server start --host 0.0.0.0
            └─ workDir = /app (process.cwd(), no --work-dir flag)
                 ├─ opens /app/.system/sidjua.db               # writable layer — LOST on rm
                 ├─ sessions at /app/.system/sessions/         # writable layer — LOST on rm
                 ├─ config at /app/config/                     # writable layer — LOST on rm
                 ├─ uploads at /app/data/uploads/              # writable layer — LOST on rm
                 └─ error log at /data/logs/sidjua-error.log  # volume ✓

docker rm    → /app writable layer destroyed → ALL state lost
docker run   → fresh container, database gone, config gone, uploads gone
```

---

## 7. Fix Options for V1.1.0

### Option 1 — Single volume, change `workDir` to `/data` (minimal change)

Change `docker-entrypoint.sh` and CMD so `workDir=/data`:

```sh
# docker-entrypoint.sh
sidjua apply --force --work-dir /data          # was: --work-dir /app
# ...
exec "$@" --port "$PORT" --work-dir /data      # add --work-dir
```

Result:
- `sidjua.db` → `/data/.system/sidjua.db` ✓
- `config/` → `/data/config/` ✓
- `governance/` → `/data/governance/` ✓
- `data/uploads/` → `/data/data/uploads/` ← awkward nesting (see Q2)

Operator mount: `-v sidjua-data:/data` (unchanged).

### Option 2 — Six named volumes, revert to V1.0.x pattern (no code change)

Keep `workDir=/app`, add explicit volume mounts in operator docs / compose:

```bash
docker run -d \
  -v sidjua-system:/app/.system \
  -v sidjua-config:/app/config \
  -v sidjua-data:/app/data \
  -v sidjua-governance:/app/governance \
  -e SIDJUA_DATA_DIR=/app/data \
  -p 47821:47821 \
  sidjua:1.1.0-amd64
```

This requires no code changes and matches what docker-compose.yml already does (for V1.0.x). However, it requires updating `SIDJUA_DATA_DIR` back to `/app/data` (or removing it) and updating Dockerfile `VOLUME` declaration.

---

## 8. Local CLI Unchanged Behavior Guarantee

Any container fix MUST be container-only. Invariants that must hold:

- `sidjua server start` without `--work-dir` still uses `process.cwd()`
- `.system/sidjua.db` still resolves to `process.cwd()/.system/sidjua.db` by default
- `SIDJUA_DATA_DIR` unset in local CLI → `paths.ts` still falls back to `~/.sidjua`
- No CLI option defaults change in non-container code paths

Acceptable isolation mechanisms: `SIDJUA_WORK_DIR` env var consumed only when set (override in Dockerfile `ENV`, not in source defaults), or explicit `--work-dir` in container CMD.

---

## 9. Open Questions for CEO Sign-off

| # | Question | Affects |
|---|---|---|
| Q1 | Fix Option 1 or Option 2? Option 1 = simple entrypoint change, single volume. Option 2 = multi-volume (no code change), matches docker-compose pattern. | Scope of impl |
| Q2 | Option 1 only: accept `/data/data/uploads/` nesting, or flatten to `/data/uploads/` (requires `server-startup.ts:347` change)? | One extra file change |
| Q3 | Upgrade path: existing V1.1.0 deployments have DB at `/app/.system/sidjua.db` (in writable layer). Is a first-boot migration (copy DB to volume) required, or clean-break acceptable? | Ops impact |
| Q4 | Sessions: should they survive container replacement (users stay logged in), or reset on each restart (re-login required after update)? Reset is simpler and more secure. | UX decision |
| Q5 | `/data` volume encrypted at host? `config/config.json` contains admin password hash and session secret. If not encrypted, secrets-at-rest risk exists once moved to volume. | Security posture |
| Q6 | `docker-compose.yml` references `ghcr.io/goetzkohlberg/sidjua:1.0.1`. Does it need to be updated for V1.1.0 simultaneously, or is that a separate task? | Scope |

---

## 10. Sign-off

[x] **Ready for Impl Prompt 2b — Option 1 (single /data volume, workDir change to /data)**
[ ] Blocked — Q# needs answer first

### CEO Decisions (2026-04-15)

**Q1 — Fix Option:** Option 1. Single `/data` volume, change workDir to `/data` via `--work-dir /data` in docker-entrypoint.sh and Dockerfile CMD. Simpler than 6-volume revert, matches current Dockerfile `VOLUME ["/data"]` declaration.

**Q2 — Upload path nesting:** Flatten. `server-startup.ts:347` must resolve uploads to `/data/uploads/` directly, not `workDir/data/uploads/` (which would produce the ugly `/data/data/uploads/` nesting). One-line change, container-only path override, must not affect local CLI default (workDir/data/uploads stays correct for Domain B).

**Q3 — Upgrade path for existing V1.1.0 deployments:** Clean-break, no migration. No production V1.1.0 deployments exist. First-boot on the new image starts with an empty `/data` volume, `sidjua apply --force` runs from scratch, admin re-setup required.

**Q4 — Sessions across container replacement:** Re-login required on container replacement. docker-entrypoint.sh must wipe `/data/.system/sessions/*` before `server start`. Simpler and more secure than session survival. One-line entrypoint change.

**Q5 — Volume encryption at rest:** Option E (Host-Hardening only) for V1.1.0. No LUKS, no gocryptfs, no app-level secret encryption in V1.1.0 scope. Risk statement must be added to `INSTALLATION.md` (or `docs/security/v1.1-threat-model.md`) documenting:
- `/data` volume is plaintext on host filesystem
- Host-level access (root on Hetzner dev host) = full data access
- admin password is bcrypt-hashed (not plaintext)
- session secret is regeneratable on restart
- Accepted threat model for V1.1 beta (no production customer data)
- Enterprise security (volume encryption, secrets management, DSGVO Art. 32 compliance) is deferred to a post-V1.2 architecture spec — a follow-up architecture ticket will be filed.

**Q6 — docker-compose.yml:** Update in scope of P2b. Three changes:
1. Volumes: 6 named volumes → single `/data` volume, matches Dockerfile and Option 1
2. Image reference: `ghcr.io/goetzkohlberg/sidjua:1.0.1` → `ghcr.io/goetzkohlberg/sidjua:${SIDJUA_VERSION:-1.1.0}` (variable substitution with default, no more hardcoded version in compose file)
3. New `.env.example` with `SIDJUA_VERSION=1.1.0`, tracked in git; `.env` must be gitignored
4. `INSTALLATION.md` updated: operator copies `.env.example` to `.env`, edits version if needed, then `docker compose up`

Follow-up ticket (post-V1.2, not in P2b scope): parameterize build pipeline so `package.json` version is the single source of truth and propagates to `.env`, Dockerfile ARG, and compose automatically. Out-of-scope for persistence fix.

### P2b Impl Scope Summary

1. `docker-entrypoint.sh`: `--work-dir /data` (was `/app`), plus `rm -rf /data/.system/sessions/* 2>/dev/null` before server start
2. `Dockerfile` CMD: explicit `--work-dir /data`
3. `src/api/server-startup.ts:347`: upload path resolution override for container, flatten to `/data/uploads/`
4. `docker-compose.yml`: single `/data` volume, `${SIDJUA_VERSION:-1.1.0}` image ref, remove 6 named volumes
5. `.env.example`: new file, `SIDJUA_VERSION=1.1.0`
6. `.gitignore`: ensure `.env` ignored (verify, add if missing)
7. `INSTALLATION.md`: 6-volume doc removed, single `/data` documented, `.env` copy step, Host-Hardening risk statement
8. Domain B (local CLI) non-regression: `sidjua server start` without `--work-dir` still uses `process.cwd()`, `paths.ts` fallback to `~/.sidjua` unchanged, no source-default changes — verified via Step 5 CLI non-regression test in P2b prompt

### Rule Candidate Validation

This sign-off validates the candidate rule **DOMAIN-SEPARATION-IN-DESIGN**: the document successfully framed container vs CLI as two independent domains, kept CLI defaults untouched, and scoped all fixes to container-only. Rule candidate upgradable to permanent after the persistence fix lands and Step 5 CLI non-regression passes.
