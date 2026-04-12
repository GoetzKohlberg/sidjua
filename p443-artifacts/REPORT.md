# P443 — REPORT.md
Generated: 2026-04-12T08:44:59Z

## Scope
CEO Act IV Build #164 collateral: B2 (Dashboard "Access denied"), B3 ("Getrennt" badge + warning bar), C (LLM card empty), B1 (stale docs panel). Also sibling S4 (connection indicator never fires in session-based auth).

## Root Causes Identified (Phase 1 Audit)

| Bug | Root Cause | File |
|-----|-----------|------|
| B2 Dashboard red card | `showBanner` included `|| !config.apiKey`; empty apiKey is normal for session auth → banner always shown | Shell.tsx |
| B3 Getrennt badge | `testConnection()` gated on `if (config.apiKey)` — always empty in session auth → `status='unknown'` forever | config.ts |
| CSRF 401 on reload | `/api/v1/auth/csrf` missing from `PUBLIC_PATHS`; raw `fetch()` in `checkAuth()` step 3 has no Bearer header → auth middleware rejects before session check | auth.ts |
| C LLM card empty | Pure cascade: `if (!catalog) return null` in ProviderSettings — resolves when B3/CSRF fixed | ProviderSettings.tsx |
| B1 Stale docs | `apikey_command`, `container_note`, `getting_started_body`, `where_apikey` still referenced docker exec / API key workflow | en.json, de.json, gui-errors.ts |

## Changes Applied

### Phase 2 — Connection Indicator (commit 4427747)
- `sidjua-gui/src/lib/config.ts`: removed `if (config.apiKey)` gate from `testConnection()` useEffect; now fires on mount unconditionally with `[config.serverUrl, config.apiKey]` deps
- `sidjua-gui/src/components/layout/Shell.tsx`: `showBanner` = `!isSettings && status === 'error'` (removed `|| !config.apiKey`)
- `src/api/middleware/auth.ts`: added `/api/v1/auth/csrf` to `PUBLIC_PATHS`

### Phase 3 — Stale String Retirement (commit ef53bd2)
**gui-errors.ts** — 9 entries rewritten:
- GUI-AUTH-001: "Not logged in." + /login or /setup suggestion
- GUI-AUTH-002: "Session expired or access denied." + /login suggestion
- GUI-CONN-001/002/GENERIC-001/WORKSPACE-002: `$(docker ps -aq -f name=sidjua)` → `<container-name>`
- GUI-CONN-005: removed "API key" reference
- GUI-SETTINGS-002: removed "API key" reference
- GUI-WORKSPACE-001: removed `sidjua backup create` docker command

**Settings.tsx** — Erste Schritte callout:
- Heading key → `where_apikey` (now "How do I log in?" / "Wie melde ich mich an?")
- `<code>` element → `<div>` (value is now a URL template, not a shell command)
- `apikey_command` → `http://<host>:<port>/setup`
- `container_note` → session auth duration note

**en.json** — 12 keys updated: gui.error.GUI-AUTH-001/002, GUI-CONN-001/002/005, GUI-GENERIC-001, GUI-SETTINGS-002, GUI-WORKSPACE-001/002, gui.dashboard.not_connected_cta, gui.chat.enter_server_details, gui.settings.help.where_apikey/apikey_command/container_note/getting_started_body

**de.json** — same 12 keys + gui.config.copy_logs_command, gui.config.docker_logs_command, gui.settings.error_logging_retrieve_cmd (container name placeholders)

## Test Results (Phase 4)

### TypeScript
- Backend `npx tsc --noEmit`: EXIT 0
- GUI `npx tsc --noEmit`: EXIT 0

### Vitest — auth/session BROAD-TEST-PREFLIGHT
```
tests/api/auth-p434b.test.ts       PASS
tests/api/session-p434b.test.ts    PASS
tests/api/middleware.test.ts       PASS
tests/security/auth-bypass-b2-b3.test.ts  PASS (35 tests)
tests/api/auth-verify.test.ts      FAIL (pre-existing: missing route file auth-verify.js)
```
Pre-existing failure documented in P441a REPORT. Not introduced by P443.

### P443 Assertions
- A1: `config.ts testConnection()` calls `/api/v1/health` (public endpoint) — VERIFIED via grep
- A2: `gui-errors.ts` contains 0 references to `api-key generate`, `/app/.system/api-key`, `docker exec.*sidjua`, "Access denied.*API key" — VERIFIED (count=0)
- A3: de.json contains 0 occurrences of `docker ps -aq -f name=sidjua` or `/app/.system/api-key` — VERIFIED (CLEAN)

## Stale Strings Retired
Total: 15 locale key updates across en.json + de.json + gui-errors.ts + Settings.tsx
- Pre-P436 auth wording: 4 (GUI-AUTH-001/002 message+suggestion each)
- Bare container name `name=sidjua`: 8 (CONN-001/002, GENERIC-001, WORKSPACE-002, config.copy_logs, config.docker_logs, settings.error_logging_retrieve_cmd, chat.enter_server_details)
- API key UI wording in auth context: 3 (CONN-005, SETTINGS-002, settings.help.where_apikey/apikey_command/container_note)

## Sibling Count
P443 = sibling 4 of deployment-model-not-localhost bug family (B1, B2, B3, C).

## Commit SHAs
- Phase 2: `4427747` fix(auth): connection indicator from public health endpoint
- Phase 3: `ef53bd2` fix(i18n): retire pre-P436 API-key fossil strings
