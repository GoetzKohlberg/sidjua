# P436 Report — server-startup API-Key Gate Removal (Build #160 Hotfix)

Date: 2026-04-11T12:57:34Z (UTC) / 2026-04-11T08:57:34+08:00 (PST)
Redmine: #779
Parent: V1.1.0 RC (#615)
Predecessor: P435 (e4c385e)

## Phases Completed

| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | 00327d9 | server-startup.ts — remove legacy API-key hard-exit gate |
| 2 | d17b14e | auth.ts — reject legacy path when currentKey is empty |
| 3 | (this commit) | report + SHA256SUMS |

## Verification

### TypeScript
Command: `npx tsc --noEmit`
Result: PASS (exit 0)

### Lint
Command: `npm run lint`
Result: PASS (exit 0)

### Auth Tests
Command: `npx vitest run tests/api/auth`
Result: 11 passed / 0 failed (auth-p434b.test.ts)
Note: auth-verify.test.ts fails with "Cannot find module auth-verify.js" — pre-existing
issue unrelated to P436; confirmed by stash-revert check showing same failure before changes.

### Gate Residue Scan
Command: `grep -n "API key required" src/api/server-startup.ts`
Result: (empty — zero matches)

### Full process.exit scan in server-startup.ts
Command: `grep -n "process.exit" src/api/server-startup.ts`
Result:
```
297:          process.exit(1);   # orchestrator startup failure
327:    process.exit(1);         # HTTP server start failure
524:    process.exit(0);         # clean SIGTERM/SIGINT shutdown
529:    process.exit(1);         # uncaught server error
```
All pre-existing, unrelated to apiKey gate.

## Build #160 Root-Cause Summary

Container crashed with exit 1 at `runServerStart()` line ~140 because `apiKeyState.currentApiKey === ""` on a fresh first-run container. P435 correctly removed all API-key auto-generation paths (docker-entrypoint.sh zero-config block, start.ts admin-token block, server-startup.ts admin-token block). The remaining gate was pre-admin-token legacy code that predates both the P269 scoped-token work and the P434 browser-session work.

Architectural intent per SPEC-BOOTSTRAP-V2 v2.1 §5: server starts with `setup_required=true`, browser completes first-time setup via `/setup` password flow, session-cookie auth takes over. Legacy API-key path becomes optional, used only if an operator explicitly generates one via `sidjua api-key generate` (CLI admin workflow, preserved per CEO decision in P435).

## Known Residues (by design, unchanged by P436)

- `src/cli/commands/api-key.ts` — CLI admin workflow for generating legacy keys, preserved per CEO
- `src/cli/commands/logs.ts` — vestigial `readAdminToken()` SSE fallback path
- `src/cli/commands/start-over.ts` — `admin.token` in idempotent delete list

## Ready For

Build #161 on Ubuntu Dev (amd64) → docker-smoke-test.sh gate → §17.4 DevTools (Mac) → §17.5 Chaos → close chain #779 → #615 Golden.
