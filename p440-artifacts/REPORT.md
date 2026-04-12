# P440 Report — First-Run Overlay State from Public Health Endpoint

Date: 2026-04-12T06:23:39Z (UTC) / 2026-04-12T14:23:39+08:00 (PST)
Redmine: #790
Parent: V1.1.0 RC (#615)
Depends-On: P439 (06bd3ce — same session)

## Context

CEO Session #785 Act III (2026-04-12 PHT) confirmed P439 fixed the session
cookie Secure flag. Post-P439 the dashboard rendered, but FirstRunOverlay
appeared with `networkError=true` on a fresh Docker container. The user
expected a normal "configure your first LLM provider" overlay (networkError=false).

Root cause: `ProtectedApp.checkFirstRun()` called `client!.getWorkspaceConfig()`
→ `GET /api/v1/config` which is auth-gated via `requireScope("readonly")`.
On a fresh Docker deployment the API client used Bearer token auth. Under
certain timing or configuration paths the call failed → `catch` branch →
`setFirstRunState('error')` → `FirstRunOverlay` rendered with `networkError=true`.

Fix: `GET /api/v1/health` (already in PUBLIC_PATHS, already fetched by
AuthProvider on mount) exposes `first_run_completed` when DB is available.
ProtectedApp reads `authState.firstRunCompleted` from the auth context —
no separate auth-gated network call, no 'error' state reachable from the
public health endpoint.

Identical architectural pattern to P434b (`HealthAuthFields` / `setHealthAuthProvider`).
Fixes DEPLOYMENT-MODEL-NOT-LOCALHOST-ONLY for workspace first-run overlay.

## Phases Completed

| Phase | Commit   | Description |
|-------|----------|-------------|
| 1 | — (no code) | Investigation: read system.ts, workspace-config.ts, App.tsx, auth.ts; grep call sites; verify PUBLIC_PATHS |
| 2+3 | 06bd3ce  | Backend + frontend — provider injection + AuthState.firstRunCompleted |
| 4 | (gitignored) | gui-bootstrap-p440.test.ts + workspace-config.test.ts additions (tests/ is gitignored) |
| 5 | (this commit) | report + SHA256SUMS |

Note: `tests/` is excluded by `.gitignore:39`. Test changes are local-only on
sidjua-dev, same pattern as P438/P439 phase 3.

## Phase 1 — Investigation Results

### system.ts (148 lines)
- Health handler uses injected providers: `_deepHealthProvider`, `_healthAuthProvider`
- Pattern: `setXxxProvider(fn)` exported + wired in `server-startup.ts` / `start.ts` / `registerAllRoutes`
- `HealthAuthFields = { setup_required: boolean; recovery_mode: boolean }` — parallel type for new field
- `/api/v1/health` confirmed in `PUBLIC_PATHS` (auth.ts:47)

### workspace-config.ts (143 lines)
- `getFirstRunCompleted(db: Database): boolean` at line 24 — file-local, NOT exported
- Queries `workspace_config.first_run_completed`, auto-completes if `isProviderConfigured()`
- Action: export function; wire via `setFirstRunCompletedProvider` in `registerAllRoutes`

### App.tsx (185 lines)
- `ProtectedApp` at lines 70-104: `checkFirstRun` calls `client!.getWorkspaceConfig()` (line 77)
- `getWorkspaceConfig()` → `GET /api/v1/config` → `requireScope("readonly")` → auth-gated
- `AuthGuard` (lines 35-61): only renders children when `authState.status === 'authenticated'`
- Session-based callerContext grants `admin` scope (auth.ts:177-180), so route not blocked for sessions

### auth.ts (177 lines)
- `checkAuth()` ALREADY calls `GET /api/v1/health` and reads `setup_required`, `recovery_mode`
- Adding `first_run_completed` requires only: read field + add to `AuthState.firstRunCompleted`
- AuthProvider calls `checkAuth` on mount; data available when ProtectedApp renders

### Phase 1.3 — getConfig call sites
```
grep -rn "\.getConfig|getConfig(" sidjua-gui/src/ → 0 matches
```
Only `getWorkspaceConfig()` at App.tsx:77 (the bug site). No other GUI frontend calls.

### Phase 1.4 — Bootstrap-path audit
- auth.ts `checkAuth`: health → setup_required/recovery_mode; verify → session status; csrf → token
- config.ts: independent health fetch for build info (`buildInfo` field)
- Session auth: auth middleware (auth.ts:136-151) returns 401 if no Bearer header; BUT
  session check at lines 171-180 fires after scoped-token check, before legacy-key check.
  API client sends `Authorization: Bearer ${apiKey}` — if key is empty/invalid, scoped check
  fails, session check runs → admin context granted. No latent 4th sibling bug.

### Phase 1.5 — Test files
12 files matched. Key ones:
- `tests/api/gui-bootstrap.test.ts` — health endpoint tests (target for P440 test)
- `tests/api/workspace-config.test.ts` — GET /api/v1/config tests (target for export test)
- `tests/api/server.test.ts` — basic health/auth tests
- `tests/security/defense-in-depth-p196.test.ts` — broad preflight

### Phase 1.6 — PUBLIC_PATHS
`/api/v1/health` confirmed at auth.ts:47. No change needed.

## Phase 2+3 — Code Changes

### workspace-config.ts
```typescript
// OLD
function getFirstRunCompleted(db: Database): boolean {

// NEW — P440: exported for use by setFirstRunCompletedProvider in registerAllRoutes
export function getFirstRunCompleted(db: Database): boolean {
```

### system.ts — new provider
```typescript
// NEW — parallel to _healthAuthProvider pattern
let _firstRunCompletedProvider: (() => boolean) | null = null;

export function setFirstRunCompletedProvider(fn: (() => boolean) | null): void {
  _firstRunCompletedProvider = fn;
}
```

Health handler — added field:
```typescript
const firstRunDone = _firstRunCompletedProvider ? _firstRunCompletedProvider() : null;
return c.json({
  ...
  ...(auth ?? {}),
  ...(firstRunDone !== null ? { first_run_completed: firstRunDone } : {}),
});
```
Field omitted (not `null`) when no provider wired (DB-less path) — same pattern as
`_deepHealthProvider`. Frontend: `Boolean(undefined) === false` → pending overlay (safe).

### index.ts — wire provider
```typescript
import { setDeepHealthProvider, setFirstRunCompletedProvider } from "./system.js";
import { registerWorkspaceConfigRoutes, getFirstRunCompleted } from "./workspace-config.js";

// In if (db !== null) block:
setFirstRunCompletedProvider(() => getFirstRunCompleted(db));
```

### auth.ts — AuthState.firstRunCompleted
```typescript
export interface AuthState {
  status:             'loading' | 'authenticated' | 'unauthenticated';
  isFirstRun:         boolean;
  isRecoveryMode:     boolean;
  firstRunCompleted:  boolean;  // P440
}
```
Default value, `checkAuth` (both `authenticated` and `unauthenticated` branches),
`logout` health re-fetch — all updated to carry `firstRunCompleted`.

### App.tsx — ProtectedApp
```typescript
// OLD — auth-gated fetch, 'error' state possible
function ProtectedApp() {
  const { client } = useAppConfig();
  const [firstRunState, setFirstRunState] = useState<FirstRunState>('loading');
  const checkFirstRun = useCallback(async () => {
    setFirstRunState('loading');
    try {
      const res = await client!.getWorkspaceConfig();
      setFirstRunState(res.firstRunCompleted ? 'completed' : 'pending');
    } catch {
      setFirstRunState('error');
    }
  }, [client]);
  useEffect(() => { void checkFirstRun(); }, [checkFirstRun]);
  ...
}

// NEW — public health endpoint via AuthProvider, 'error' state unreachable
function ProtectedApp() {
  const { client }    = useAppConfig();
  const { authState } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const firstRunState: FirstRunState =
    dismissed || authState.firstRunCompleted ? 'completed' : 'pending';
  const handleDismiss = useCallback(async () => {
    setDismissed(true);
    try { await client!.completeFirstRun(); } catch { /* non-fatal */ }
  }, [client]);
  return <AppRoutes firstRunState={firstRunState} onDismiss={handleDismiss} onRetry={() => undefined} />;
}
```

Key properties:
- No extra network call — AuthProvider already fetched `/api/v1/health` before ProtectedApp renders
- `firstRunState` is `'completed' | 'pending'` — never `'error'` or `'loading'`
- `dismissed` local override: once user dismisses overlay, stays completed even before authState refresh
- `completeFirstRun()` POST still sent (auth-gated, requires session — correct, ProtectedApp only renders when authenticated)

## Residue Scan

```
grep -n "getWorkspaceConfig" sidjua-gui/src/App.tsx
→ 0 matches
```
No auth-gated config fetch remains in ProtectedApp.

## Phase 4 — Tests (local-only, tests/ gitignored)

### gui-bootstrap.test.ts — additions

New describe "GET /api/v1/health — first_run_completed field (P440)":
- No provider wired → field absent from response
- Provider returning false → `first_run_completed: false`
- Provider returning true → `first_run_completed: true`
- Other health fields still present alongside first_run_completed
(afterEach: `setFirstRunCompletedProvider(null)` to clean global state)

### workspace-config.test.ts — additions

Import `getFirstRunCompleted` from route module.
New describe "getFirstRunCompleted — P440 export":
- Returns false on fresh DB
- Returns true after POST /api/v1/config/first-run-complete via route
- State changes correctly false → true
- Multiple calls without side-effects on false state

## Verification

### tsc --noEmit (backend)
PASS (exit 0) after Phase 2+3 changes.

### tsc --noEmit (GUI)
PASS (exit 0) after Phase 3 changes.

### Primary test files (2 files)
```
tests/api/gui-bootstrap.test.ts   13 tests  pass  (+4 P440 tests)
tests/api/workspace-config.test.ts 23 tests  pass  (+4 P440 tests)
Total: 36/36
```

### Broad preflight suite (4 files)
```
tests/api/auth-p434b.test.ts             15 tests  pass
tests/api/session-p434b.test.ts          20 tests  pass
tests/security/defense-in-depth-p196.test.ts  pass
tests/api/server.test.ts                      pass
Total: 88/88 pass
```

### Full tests/api suite (49 files)
697/697 tests pass.
1 file failure: `tests/api/auth-verify.test.ts` — "Cannot find module auth-verify.js"
Pre-existing failure (documented in P436 + P439 reports) — not caused by P440.

## Session #785 Act III Reproduction

P440 acceptance test: CEO repeats Mac browser flow on fresh Docker container
(reset /data volume) → http://192.168.254.186:47821/setup → submit password →
expect:
- Dashboard renders (P439 cookie fix)
- FirstRunOverlay visible with NO networkError (P440 fix: pending, not error)
- User configures LLM provider via Settings → overlay dismissed
- LLM-provider menu populated in Chat

## Out of Scope

- Frontend unit tests for `App.tsx ProtectedApp` (Vitest + React Testing Library —
  deferred, GUI tests are gitignored and require JSDOM setup)
- `getWorkspaceConfig()` removal from `client.ts` — method retained; may be used
  by other GUI routes; separate cleanup ticket if needed

## Ready For

Build #164 on Ubuntu Dev (amd64, BUILD_NUMBER=164). Reset sidjua-ceo /data
container to fresh state. CEO Session #785 Act III re-test.
