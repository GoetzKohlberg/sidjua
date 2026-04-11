# P435 Report — Legacy Auth-Residue Cleanup + Port-Drift Fix

Date: 2026-04-11T12:30:40Z (UTC) / 2026-04-11T08:30:40+08:00 (PST)
Redmine: #779
Parent: V1.1.0 RC (#615)

## Phases Completed

| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | 2467c4a | docker-entrypoint.sh — remove zero-config api-key, V1.0.x notice, port 47821 |
| 2 | 04f96c3 | Dockerfile — healthcheck + EXPOSE + ENV port 47821 |
| 3 | 7f89d90 | start.ts — remove admin-token auto-gen (P269/P316 residue) |
| 4 | 8bff652 | server-startup.ts — remove admin-token + GUI bootstrap injection fallback |
| 5 | 29e646f | docker-smoke-test.sh — dynamic version, port 47821, strict log-grep, container cleanup |
| 6 | 18051ab | docs — port 47821, API-key references → /setup flow |
| 7 | (this commit) | report + SHA256SUMS |

## Verification

### Port-Drift Scan (primary targets)
Command: `grep -rn "4200" README.md docs/INSTALLATION.md docker-entrypoint.sh Dockerfile scripts/docker-smoke-test.sh`
Result: (empty — zero matches)

### Port-Drift — Out-of-Scope Residuals
Files NOT in P435 TOUCH-ONLY list that still contain 4200:
- `docs/TROUBLESHOOTING.md` — 9 port references
- `docs/translations/README.*.md` — 22 translation files, ~3 refs each

These are outside the P435 scope guardrail. Require separate ticket or P436 doc pass.

### Admin-Token Residue Scan
Command: `grep -rn "admin.token|sk-sidjua|Zero-Config API Key" src/ docker-entrypoint.sh`
Result:
```
src/cli/commands/logs.ts:116:  * Try to read the admin token from .system/admin.token.
src/cli/commands/logs.ts:120:    const tokenFile = join(workDir, ".system", "admin.token");
src/cli/commands/logs.ts:241:  // Polling fallback (server not running or no admin token)
src/cli/commands/start-over.ts:415:  join(".system", "admin.token"),
src/cli/commands/api-key.ts:160:  // Safety: refuse if no admin token exists — would cause a lockout.
src/api/token-store.ts:286:  * Used at startup to decide whether to generate a bootstrap admin token.
src/api/middleware/auth.ts:238:  // Warn prominently when admin tokens already exist
```
All expected — see "Known Residues Left in Place" below.

### TypeScript
Command: `npx tsc --noEmit`
Result: PASS (exit 0)

### Lint
Command: `npm run lint` (alias for `tsc --noEmit`)
Result: PASS (exit 0)

### Shellcheck
shellcheck not installed on Ubuntu Dev host.
Bash syntax check (`bash -n scripts/docker-smoke-test.sh`): PASS

## Known Residues Left in Place (by design)

- `src/cli/commands/logs.ts` — `readAdminToken()` function kept as vestigial SSE path; `readAdminToken` returns null if file absent → DB polling fallback kicks in (verified by Opus)
- `src/cli/commands/api-key.ts` — CLI admin workflow intentionally preserved (CEO decision: `sidjua api-key generate` stays for API/REST access distinct from browser login)
- `src/cli/commands/start-over.ts` — `admin.token` in delete-if-exists cleanup list (idempotent, harmless)
- `src/api/token-store.ts` / `src/api/middleware/auth.ts` — internal comments only, no functional auto-gen

## Phase 4 Note: guiKeyFn

`guiKeyFn` IS still referenced at `server-startup.ts:439` (`registerGuiRoutes`), so it was kept as `const guiKeyFn: () => string = () => apiKeyState.currentApiKey;` (fallback to bootstrap key). The conditional-reassignment block (admin.token file read) was deleted.

## Phase 5 Note

Container collision cleanup (`docker rm -f "$CONTAINER"`) was already present at line 54 of the original file. No duplicate cleanup added. Self-test deferred to Build #160 smoke gate (requires rebuilt image with these changes).

## Ready For

Build #160 on sidjua:1.1.0-amd64 → §17.4 DevTools smoke → §17.5 Chaos tests → close chain #779 → #615 Golden.
