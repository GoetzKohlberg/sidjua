# REPORT-P434b: Backend Auth Layer — Session, Config, CSRF, Rate-Limit

**Date:** 2026-04-10 (PHT 16:35 / UTC 08:35)
**Redmine:** #779
**Sequence:** P434a → **P434b** → P434c → Build #158
**Status:** COMPLETE — awaiting Opus review before P434c

---

## Commits

| Phase | SHA | Description |
|-------|-----|-------------|
| Phase 1 | `4f6711f` | Config manager with atomic write, backup rotation, corrupt fallback |
| Phase 2 | `d1bca39` | Auth routes + session-based auth in middleware |
| Phase 3 | `7006601` | FileSessionStore + session cookie middleware |
| Phase 4 | `532a834` | Double-submit CSRF for session-based requests |
| Phase 5 | `d6c023e` | Auth-specific rate limiter (10 req / 15 min per IP) |
| Phase 6 | `cde6312` | Wire session middleware, health fields, auth routes in startup |
| Phase 7 | *(no commit — tests/ gitignored)* | Tests — 29 tests PASS, files on disk only |

---

## Phase 1 — ConfigManager (`src/api/config.ts`)

**New file.** Manages `.system/config.json` (schemaVersion 2):

- **Atomic write:** `config.json.tmp-<pid>-<hex>` → `datasync` → `rename(tmp, config.json)`
- **Backup rotation:** `copyFile` to `config.json.bak-<ISO8601>` before overwrite; prune to 5 most recent
- **Corrupt recovery:** `renameSync` to `config.json.corrupt-<ISO8601>`, set `recoveryMode=true`
- **First-run detection:** `isFirstRun()` → no file OR `passwordHash` null/absent
- **Write serialization:** Promise-chain mutex — no external dep

Config shape:
```json
{
  "schemaVersion": 2,
  "passwordHash":  "$argon2id$...",
  "sessionSecret": "<base64 32 bytes>",
  "createdAt":     "2026-04-10T...",
  "users":         []
}
```

---

## Phase 3 — Session Middleware (`src/api/middleware/session.ts`)

**New file.**

- **Cookie:** `sidjua_sid=<base64url_id>.<base64url_hmac_sha256>`
- **Signing:** `createHmac("sha256", Buffer.from(secret, "base64")).update(id).digest("base64url")`
- **Verification:** `timingSafeEqual` of expected vs provided signature
- **FileSessionStore:** `.system/sessions/<id>.json`, lazy expiry, `purgeExpired()` sweeper
- **Path traversal guard:** `_isValidId()` rejects non-base64url chars
- **Default TTL:** 8 hours (`SESSION_TTL_MS`)
- **Cookie flags:** `HttpOnly; SameSite=Strict; Path=/; Secure` (Secure omitted for localhost)

---

## Phase 2 — Auth Routes (`src/api/routes/auth.ts`) + Auth Middleware Update

**New file** (`routes/auth.ts`):

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/auth/setup` | POST | Public | First-run admin password setup (argon2id). Rate-limited. |
| `/api/v1/auth/login` | POST | Public | Password login → `sidjua_sid` cookie. Rate-limited. |
| `/api/v1/auth/logout` | POST | Public | Clear session cookie + delete from store. |
| `/api/v1/auth/verify` | GET | Public | Returns `{ authenticated, via }` — 401 if not logged in. |
| `/api/v1/auth/csrf` | GET | Session | Returns `{ csrfToken }` for X-CSRF-Token header. |
| `/api/v1/auth/settings/password` | POST | Session | Change admin password (currentPassword + newPassword). Rate-limited. |

**argon2id parameters:** `memoryCost=65536, timeCost=3, parallelism=4` (matches `src/apply/secrets.ts`)

**`src/api/middleware/auth.ts` changes:**
- Added `setup/login/logout/verify` to `PUBLIC_PATHS`
- Added session-cookie auth path (1b): `c.get(SESSION_KEY)` → if session present → `role: "admin"` CallerContext
- sessionMiddleware must precede authenticate in the chain (done in Phase 6)

---

## Phase 4 — Double-Submit CSRF (`src/api/middleware/csrf.ts`)

**Updated file.**

- Removed `tauri://localhost*` from `ALLOWED_ORIGIN_RE` (Tauri removed in P434a)
- **Step 1:** Origin present → validate allowlist (unchanged)
- **Step 2 (new):** Session in context → require `X-CSRF-Token` header matching `session.csrfToken` (timing-safe); blocks even with valid origin
- **Step 3:** No session → existing bypass logic (Authorization header, application/json, X-Requested-With, X-SIDJUA-Request)

---

## Phase 5 — Auth Rate Limiter (`src/api/middleware/rate-limiter.ts`)

**Updated file.**

- `AUTH_RATE_LIMIT`: `10 req / 15 min window, burst 0`
- `authRateLimiter()`: IP-only bucket key (`auth:<ip>` namespace), separate from general `ip:*` buckets
- Applied as route-level middleware on `/setup`, `/login`, `/settings/password`

---

## Phase 6 — Startup Wiring

**`src/api/server.ts`:**
- `ApiServerConfig` extended: `sessionStore?: FileSessionStore | null`, `getSessionSecret?: () => string | null`
- `sessionMiddleware` inserted before `csrfMiddleware` in chain

**`src/api/server-startup.ts`:**
- `ConfigManager` initialized at startup; logs first-run / recovery-mode state
- `FileSessionStore` created; `purgeExpired()` called on boot (fire-and-forget)
- `setHealthAuthProvider` wired: `GET /health` now includes `setup_required` and `recovery_mode`
- Both passed into `ApiServerConfig` and `registerAllRoutes`

**`src/api/routes/system.ts`:**
- `setHealthAuthProvider()` + `HealthAuthFields` type added
- Health response includes `setup_required` / `recovery_mode` when provider is set

**`src/api/routes/index.ts`:**
- `AuthRouteServices` + `auth` field added to `AllRouteServices`
- `registerAuthRoutes(app, services.auth)` called when services.auth is present

---

## Phase 7 — Tests

All tests pass. Files are on disk under `tests/` (gitignored by design, P430 finding).

| Test file | Tests | Result |
|-----------|-------|--------|
| `tests/api/config-manager.test.ts` | 8 | PASS |
| `tests/api/session-p434b.test.ts` | 10 | PASS |
| `tests/api/auth-p434b.test.ts` | 11 | PASS |
| **Total** | **29** | **PASS** |

---

## Verification Gates

### tsc --noEmit (sidjua root)

Exit: 0 ✓

### npm run lint (sidjua root)

Exit: 0 ✓

### Grep — no tauri references remain

```
grep @tauri-apps sidjua-gui/src/ sidjua-gui/package.json → 0 results ✓
```

### grep verification of P434b symbols

| Pattern | Location | Hits |
|---------|----------|------|
| `class ConfigManager` | `src/api/config.ts` | 1 ✓ |
| `class FileSessionStore` | `src/api/middleware/session.ts` | 1 ✓ |
| `SESSION_KEY` | `src/api/middleware/session.ts` | 1 ✓ |
| `/api/v1/auth/setup` | `src/api/routes/auth.ts` | 1 ✓ |
| `authRateLimiter` | `src/api/middleware/rate-limiter.ts` | 1 ✓ |
| `setup_required` | `src/api/routes/system.ts` | 1 ✓ |

---

## Notes for Opus / P434c

1. **P434b is NOT independently deployable without GUI changes.** The auth endpoints exist but the browser-side SPA still needs to be wired to call `/api/v1/auth/setup` on first run and `/api/v1/auth/login` for subsequent logins. This is P434c scope.

2. **`src/cli/commands/start.ts` not updated** — it is a separate foreground-mode startup path. P434c should mirror the ConfigManager/FileSessionStore initialization there if needed.

3. **`isBootstrapSession`** remains in the GUI state (noted in P434a). Safe to remove in P434c once the new login flow is wired to the frontend.

4. **argon2id in setup endpoint** — first call takes 100-200ms (intentional KDF delay). SPA should show a loading indicator during setup/login.

5. **Session purge:** Called once on startup. For long-running servers, consider adding a periodic purge (e.g., `setInterval(() => sessionStore.purgeExpired(), SESSION_TTL_MS / 2)`). Currently deferred to P434c.
