# REPORT-P434c — React Frontend Auth Wiring

Redmine: #779
Sequence: P434a (argon2id) → P434b (session/CSRF backend) → **P434c (frontend wire-up)**
Timestamp: 2026-04-10T09:19:45Z (UTC) / 2026-04-10T17:19:45+08:00 (PST)

---

## Phase 1: Auth Context + CSRF Store + API Paths

### `sidjua-gui/src/lib/csrf.ts` (NEW)
Module-level CSRF token store shared between `auth.ts` (writer) and `client.ts`/`useTranslation.ts` (readers).
Avoids circular imports — both consumers import from `csrf.ts`, no cycle.

```typescript
let _csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void { _csrfToken = token; }
export function getCsrfToken(): string | null { return _csrfToken; }
```

### `sidjua-gui/src/api/paths.ts` (UPDATED)
Added 6 auth endpoints:
- `authVerify`, `authSetup`, `authLogin`, `authLogout`, `authCsrf`, `authPasswordChange`

### `sidjua-gui/src/api/client.ts` (UPDATED)
- `headers()` now injects `X-CSRF-Token` from `getCsrfToken()` when non-null
- Added `changePassword(currentPassword, newPassword)` method → `POST /api/v1/auth/settings/password`

### `sidjua-gui/src/lib/config.ts` (UPDATED)
- `loadConfig()` always returns `window.location.origin` as serverUrl (no localStorage read)
- Client created unconditionally via `useMemo` — session cookie handles auth; apiKey may be empty

### `sidjua-gui/src/lib/auth.ts` (NEW)
Full `AuthProvider` with:
- `AuthState`: `{ status: 'loading'|'authenticated'|'unauthenticated', isFirstRun, isRecoveryMode }`
- `checkAuth()`: GET /health (setup_required/recovery_mode) → GET /auth/verify → GET /auth/csrf
- Idle timeout: `setInterval` 60s polling `/auth/verify`; on 401 → `unauthenticated`
- `onLoginSuccess(csrfToken)`: sets module-level + React state token, marks `authenticated`
- `logout()`: POST `/auth/logout` with CSRF header, clears token, re-checks health

### `sidjua-gui/src/hooks/useTranslation.ts` (UPDATED — B1 fix)
`setLocale()` POST now includes `X-CSRF-Token: getCsrfToken()` so locale persist works post-login.

### `sidjua-gui/src/App.tsx` (REWRITTEN)
- `HashRouter` moved to `App()` root
- `AuthProvider` placed inside `HashRouter` (enables `useNavigate` in `AuthGuard`)
- `AuthGuard`: redirects `unauthenticated` → `/setup` (first-run) or `/login`; shows `LoadingSpinner` while loading
- `ProtectedApp`: separate workspace first-run gate (calls `client!.getWorkspaceConfig()`)
- Public routes: `/setup`, `/login` outside `AuthGuard`
- Fixed `client!` non-null assertions (TypeScript: `AppConfigContextValue.client` typed as `| null` but always created)

---

## Phase 2: Setup Page

### `sidjua-gui/src/pages/Setup.tsx` (NEW)
First-run admin password setup:
- Min 12 characters enforced client-side
- POST `/api/v1/auth/setup` with `X-SIDJUA-Request: 1`
- On success: `onLoginSuccess(data.csrfToken)` → navigate `/`
- Error handling: 409 (already configured), 400 (weak password), network error
- Loading spinner during argon2id processing

---

## Phase 3: Login Page

### `sidjua-gui/src/pages/Login.tsx` (NEW)
Admin password login:
- POST `/api/v1/auth/login` with `X-SIDJUA-Request: 1`
- 429: "Too many login attempts. Please wait 15 minutes."
- 401: "Invalid password."
- On success: `onLoginSuccess(data.csrfToken)` → navigate `/`

---

## Phase 4: Settings — Password Change

### `sidjua-gui/src/pages/Settings.tsx` (UPDATED)
- Removed: "Server Connection" section (apiKey/server URL form, test connection)
- Removed imports: `Eye`, `EyeOff`, `getIsBootstrapSession`, `AppConfig`
- Added: "Admin Password" section with `currentPw`/`newPw`/`confirmPw` inputs
- `handleChangePassword()` calls `client!.changePassword(currentPw, newPw)`
- `UpdateCheckRow`: now reads CSRF token via `getCsrfToken()` instead of `config.apiKey`

---

## Phase 5: Dashboard

### `sidjua-gui/src/pages/Dashboard.tsx` (UPDATED)
- B3 removed: apiKey redirect guard (`hasRedirectedRef` + useEffect → /settings when no key)
- B3 removed: "not connected" early return block
- Destructuring changed: `{ config, client }` → `{ buildInfo }` only
- B4 added: version footer using `buildInfo` from `useAppConfig()`

---

## Phase 6: Backend

### `src/cli/commands/start.ts` (UPDATED)
- Added imports: `ConfigManager`, `FileSessionStore`, `SESSION_TTL_MS`, `setHealthAuthProvider`
- Before `createApiServer`: init ConfigManager + load(), init FileSessionStore + fire-and-forget purge
- Periodic session purge: `setInterval(() => void sessionStore.purgeExpired()..., SESSION_TTL_MS / 2)` + `.unref()`
- `setHealthAuthProvider(() => ({ setup_required, recovery_mode }))`
- `createApiServer` receives: `sessionStore`, `getSessionSecret: () => configManager.getConfig().sessionSecret`
- `routeServices.auth`: `{ configManager, sessionStore }`
- Shutdown handler: `clearInterval(sessionPurgeTimer)`

### `src/api/server-startup.ts` (UPDATED)
- Added `SESSION_TTL_MS` to session import
- Periodic session purge: `setInterval(() => void sessionStore.purgeExpired()..., SESSION_TTL_MS / 2)` + `.unref()`
- Shutdown: `clearInterval(sessionPurgeTimer)`

(Fire-and-forget `purgeExpired()` on startup was already present from P434b.)

### Launcher Scripts (NEW)
- `Stop-Sidjua.command` (macOS): `docker compose down` wrapper, double-click to stop
- `Stop-Sidjua.bat` (Windows): `docker compose down` wrapper, double-click to stop

---

## Phase 7: Verification

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` (repo root) | PASS |
| `npm run lint` (repo root) | PASS |
| `npx tsc --noEmit` (sidjua-gui) | PASS (after `client!` fix in App.tsx) |

---

## Changed Files Summary

New:
- `sidjua-gui/src/lib/csrf.ts`
- `sidjua-gui/src/lib/auth.ts`
- `sidjua-gui/src/pages/Setup.tsx`
- `sidjua-gui/src/pages/Login.tsx`
- `Stop-Sidjua.command`
- `Stop-Sidjua.bat`

Modified:
- `sidjua-gui/src/App.tsx`
- `sidjua-gui/src/api/client.ts`
- `sidjua-gui/src/api/paths.ts`
- `sidjua-gui/src/hooks/useTranslation.ts`
- `sidjua-gui/src/lib/config.ts`
- `sidjua-gui/src/pages/Dashboard.tsx`
- `sidjua-gui/src/pages/Settings.tsx`
- `src/api/server-startup.ts`
- `src/cli/commands/start.ts`

---

## Closing Loop

- Redmine #779 → status_id=4 (Resolved)
- Depends on: P434b (commit 09cff4e)
- Gate: tsc PASS, lint PASS
