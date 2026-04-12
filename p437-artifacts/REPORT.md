# P437 Report — Dockerfile Layer Cleanup

Date: 2026-04-12T02:07:39Z (UTC) / 2026-04-12T10:07:39+08:00 (PST)
Redmine: #787
Parent: V1.1.0 RC (#615)
Build: #162 (pending, shared with P438)

## Phases Completed

| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | 469813c | Dockerfile — fold chown/chmod into COPY --chown + merged RUN |
| 2 | (this commit) | report + SHA256SUMS |

## Diff Summary

- Removed: `RUN chown -R sidjua:sidjua /app /data`
- Removed: `RUN chmod -R 555 /app/dist ...` (standalone)
- Added: `--chown=sidjua:sidjua` to 11 COPY directives (all COPY lines in production stage)
- Moved: `addgroup/adduser sidjua` — NOT required, already before WORKDIR
- Merged: `chmod 555` into build-meta RUN (`printf ... > /app/.build-meta && chown /app/.build-meta && chmod -R 555 ...`)
- Added: non-recursive `chown sidjua:sidjua` for dirs created by RUN mkdir (not COPY)
- Added: `RUN install -d -o sidjua -g sidjua -m 755 /data` (replaces `RUN mkdir -p /data`)
- Net layer delta: -2 (two RUN layers collapsed; chmod merged into build-meta RUN)

## Security Invariants Verified (static read of 469813c)

- [x] `USER sidjua` directive still present and unchanged (line 181)
- [x] All files under `/app/dist`, `/app/node_modules`, `/app/locales`, `/app/static`, `/app/sidjua-gui`, `/app/defaults`, `/app/docs` still receive mode 555 (merged into build-meta RUN, line 151)
- [x] `/data` mount point created with `sidjua:sidjua` ownership, mode 755 (`install -d -o sidjua -g sidjua -m 755 /data`)
- [x] `VOLUME ["/data"]` still declared (line 179)
- [x] `EXPOSE 47821/tcp` unchanged (line 183)
- [x] `HEALTHCHECK` unchanged (lines 187-188)
- [x] All `LABEL` lines unchanged (lines 72-85)
- [x] No new `ADD` directives
- [x] `.dockerignore` untouched (per TOUCH-ONLY guardrail)
- [x] `/app` itself owned by sidjua (added to non-recursive chown list in first mkdir RUN)
- [x] `/app/.build-meta` owned by sidjua (explicit `chown sidjua:sidjua /app/.build-meta` in build-meta RUN)
- [x] `/app/.system`, `/app/agents/*`, `/app/governance/*` owned by sidjua (second mkdir RUN chown list)

## Expected Build Metrics (validation deferred to Build #162)

Before (Build #161 2eb019007c53):
- `docker images SIZE`: 1.68GB
- `docker system df -v UNIQUE`: 1.508GB
- `docker image inspect .Size`: 389MB
- Tarball: 371MB

After (Build #162, expected):
- `docker images SIZE`: ~400MB (within ±50MB of Alpine+Node base + app content)
- `docker system df -v UNIQUE`: ~400MB
- `docker image inspect .Size`: ~389MB (unchanged — content identical)
- Tarball: ~371MB (unchanged)

Opus will record the actual post-build numbers in #787 journal after Build #162 completes.

## Out of Scope (not touched by P437)

- CSRF origin bug — P438/#786
- uid divergence 1001 vs spec-expected 1000 — pre-existing, separate scope
- `.dockerignore` optimization — separate ticket
- Multi-stage build introduction — separate ticket
- Node Alpine base swap to distroless — separate ticket
- hadolint static analysis — not installed on sidjua-dev

## Ready For

Build #162 on Ubuntu Dev (amd64 only, arm64 deferred per CEO D-S782-2) — execute after P438 Phase 2 lands.
