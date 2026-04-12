# P439 Report — Session Cookie Secure Flag: Scheme-Based Not Host-Based

Date: 2026-04-12T04:55:37Z (UTC) / 2026-04-12T12:55:37+08:00 (PST)
Redmine: #789
Parent: V1.1.0 RC (#615)
Depends-On: P438 phase 2 (1d6079a)

## Context

CEO Session #785 Act II (2026-04-12 12:18 PHT) confirmed P438 fixed the CSRF
origin check. The login POST to /setup succeeded and the session cookie was minted,
but every subsequent request arrived unauthenticated → 401 cascade → AuthGuard
redirect loop → dead-end.

Root cause: `buildSessionCookieHeader` decided the `Secure` flag based on whether
the `host` header hostname was `localhost` or `127.0.0.1`. Any LAN IP or custom
hostname was treated as "production HTTPS" → `Secure=true` on a plain-HTTP cookie.
Browser spec: a `Secure` cookie is never sent over `http://`. So the browser
accepted the `Set-Cookie` but silently refused to send it back on all follow-up
requests — the server saw no session, returned 401.

Identical structural bug to P438 csrf.ts (`ALLOWED_ORIGIN_RE` localhost-only
assumption). Fixes DEPLOYMENT-MODEL-NOT-LOCALHOST-ONLY for session auth.

## Phases Completed

| Phase | Commit   | Description |
|-------|----------|-------------|
| 1 | — (no code) | Investigation: read session.ts + auth.ts, grep call sites, preflight test list |
| 2 | 3938147  | session.ts + auth.ts — scheme-based Secure flag |
| 3 | (gitignored) | session-p434b.test.ts + auth-p434b.test.ts new tests (tests/ is gitignored) |
| 4 | (this commit) | report + SHA256SUMS |

Note: `tests/` is excluded by `.gitignore:39`. Test changes are local-only on
sidjua-dev, same pattern as P438 phase 3 and P438.1 phase 2.

## Phase 1 — Investigation Results

### session.ts
- 288 lines. `buildSessionCookieHeader(signedValue, host, ttlMs)` lines 250-259.
- `clearSessionCookieHeader()` lines 264-266 — no Secure at all (bug by omission).
- Top-of-file doc comment line 10: "Secure (when non-localhost)" — outdated.

### Call sites (auth.ts)
```
src/api/routes/auth.ts:120  buildSessionCookieHeader(signed, host)  ← /auth/setup
src/api/routes/auth.ts:203  buildSessionCookieHeader(signed, host)  ← /auth/login
src/api/routes/auth.ts:219  clearSessionCookieHeader()               ← /auth/logout
```
All 3 call sites used `c.req.header("host") ?? "localhost"` — removed entirely.

### Scheme access pattern
`new URL(c.req.url, "http://localhost").protocol === "https:"` — same as P438 csrf.ts.

### Test files (preflight list)
Primary: `tests/api/session-p434b.test.ts`, `tests/api/auth-p434b.test.ts`
Broad preflight (8 files): auth-p434b, session-p434b, defense-in-depth-p196, server.test.ts,
csrf-tool-execute, csrf-custom-header, prompt-119-fixes, api-validation-h1-h2.

## Phase 2 — Code Changes

### session.ts

```typescript
// OLD — hostname-based
export function buildSessionCookieHeader(
  signedValue: string,
  host: string,
  ttlMs: number = SESSION_TTL_MS,
): string {
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || ...;
  const secure = isLocalhost ? "" : "; Secure";
  ...
}
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// NEW — scheme-based
export function buildSessionCookieHeader(
  signedValue: string,
  isHttps:     boolean,
  ttlMs:       number = SESSION_TTL_MS,
): string {
  const secure = isHttps ? "; Secure" : "";
  ...
}
export function clearSessionCookieHeader(isHttps: boolean): string {
  const secure = isHttps ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=0`;
}
```

`clearSessionCookieHeader` also updated because the clear-cookie must mirror the
Secure flag of the original Set-Cookie — a clear without Secure is silently ignored
by browsers for Secure cookies.

### auth.ts (all 3 call sites)

```typescript
// OLD
const host      = c.req.header("host") ?? "localhost";
const cookieHdr = buildSessionCookieHeader(signed, host);
// or:
c.header("Set-Cookie", clearSessionCookieHeader());

// NEW
const isHttps   = new URL(c.req.url, "http://localhost").protocol === "https:";
const cookieHdr = buildSessionCookieHeader(signed, isHttps);
// or:
c.header("Set-Cookie", clearSessionCookieHeader(isHttps));
```

Top-of-file doc comment updated: "Secure (when non-localhost)" →
"Secure (when HTTPS — plain-HTTP omits Secure)".

## Residue Scan

```
grep -n "isLocalhost|host === \"localhost\"|host === \"127" src/api/middleware/session.ts
→ 0 matches
```
No hostname-based Secure logic remains.

## Phase 3 — Tests

### New unit tests in session-p434b.test.ts

New describe "buildSessionCookieHeader — scheme-based Secure (P439)":
- isHttps=false → no Secure (HTTP LAN / loopback)
- isHttps=true → Secure (HTTPS LAN / loopback)
- HTTP: HttpOnly + SameSite=Strict + Path=/ + Max-Age always present
- HTTPS: same invariants
- Custom ttlMs reflected in Max-Age
- Default ttlMs = SESSION_TTL_MS / 1000
- Secure is a distinct cookie attribute (not embedded in cookie value)

New describe "clearSessionCookieHeader — scheme-based Secure (P439)":
- isHttps=false → no Secure + Max-Age=0
- isHttps=true → Secure + Max-Age=0
- Always emits HttpOnly + SameSite=Strict + Path=/ + Max-Age=0 (loop over both booleans)

### New integration tests in auth-p434b.test.ts

New describe "P439: Secure cookie — scheme derived from request URL":
- HTTP login → no Secure in Set-Cookie (CEO smoke case reproduced and fixed)
- HTTPS login → Secure in Set-Cookie
- HTTP logout → clear-cookie has no Secure
- HTTPS logout → clear-cookie has Secure

### Existing tests

T1 (setup with Host:localhost:4200), T4 (login with Host:localhost), T8 (logout
Max-Age=0) — all still pass unchanged. These used relative paths → isHttps=false
→ no Secure, same as before (old code: isLocalhost=true → no Secure).

## Verification

### tsc --noEmit
PASS (exit 0) after Phase 2 changes.

### Primary test files (2 files)
```
tests/api/session-p434b.test.ts  20 tests  pass
tests/api/auth-p434b.test.ts     15 tests  pass
Total: 35/35
```

### Broad preflight suite (8 files)
207/207 pass. No regressions in CSRF, session, auth, or defense-in-depth tests.

### Full tests/api suite (49 files)
689/689 tests pass.
1 file failure: `tests/api/auth-verify.test.ts` — "Cannot find module auth-verify.js"
This is a PRE-EXISTING failure (documented in P436 report as "pre-existing issue
unrelated to P436/P439") — not caused by P439.

## Session #785 Act II Reproduction

P439 acceptance test deferred to CEO Act III:
Repeat Mac browser flow → http://192.168.254.186:47821/setup → submit password →
expect: dashboard renders, FirstRunOverlay network error gone, LLM-provider menu
populated, no phantom 30s redirect loop.

## Out of Scope

- X-Forwarded-Proto / reverse-proxy TLS trust — future ticket, explicit SIDJUA_TRUSTED_PROXIES allowlist required
- TLS auto-enable — deferred to V1.2 per #790 ADR
- Frontend AuthGuard redirect logic — auto-resolves once cookie flows correctly

## Ready For

Build #163 on Ubuntu Dev (amd64, BUILD_NUMBER=163). Reset sidjua-ceo /data container
to fresh state. CEO Session #785 Act III test.
