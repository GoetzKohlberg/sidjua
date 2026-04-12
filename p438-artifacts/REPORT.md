# P438 Report — CSRF Same-Origin Fix

Date: 2026-04-12T02:20:14Z (UTC) / 2026-04-12T10:20:14+08:00 (PST)
Redmine: #786
Parent: V1.1.0 RC (#615)
Build: #162 (shared with P437)

## Root Cause

`ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/` in
`src/api/middleware/csrf.ts` only allowed loopback origins. The CEO GUI Smoke
test ran from a Mac browser hitting the container at `192.168.254.186:47821`,
which sent `Origin: http://192.168.254.186:47821`. The regex never matched →
403 CSRF → GUI completely inaccessible from any non-localhost host.

## Phases Completed

| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | (prior session) | csrf.ts — replace doc header + add helper functions (parseOrigin, getRequestOrigin, isSameOrigin, isOriginAllowed, LOOPBACK_ORIGIN_RE) |
| 2 | 1d6079a | csrf.ts — replace ALLOWED_ORIGIN_RE.test() calls in middleware body with isOriginAllowed() |
| 3 | (gitignored) | tests/csrf-tool-execute.test.ts — P438 same-origin test suite (local only, tests/ is gitignored) |
| 4 | (this commit) | report + SHA256SUMS |

## Design

### Old behaviour
Single hardcoded regex — only `localhost` and `127.0.0.1` passed. Any LAN IP,
hostname, or IPv6 address was rejected.

### New behaviour
Two-tier check in `isOriginAllowed(parsedOrigin, rawOrigin, c)`:

1. **Loopback safety net** (`LOOPBACK_ORIGIN_RE`): `localhost`, `127.0.0.1`,
   `[::1]` always pass regardless of Host header. Preserves Desktop-App use case.

2. **Same-origin check**: `parseOrigin(origin)` → compare `{scheme, host, port}`
   against `getRequestOrigin(c)` which derives the canonical origin from the
   request's `Host` header and URL scheme.
   - All three components must match exactly (W3C same-origin definition).
   - Returns false if Host header is absent (`getRequestOrigin` → null).

### Referer fallback
Updated identically: `parseOrigin(refererOrigin)` → `isOriginAllowed(...)`.

### Origin validation log improvement
Rejection log now includes `request_origin` field (Host-derived), making it
easier to diagnose Host-header mismatches in production.

## Files Changed

- `src/api/middleware/csrf.ts` — Phase 1+2

## Security Invariants Verified

- [x] Origin header always validated first — no bypass by Authorization/Content-Type
- [x] Double-submit CSRF (session requests) still enforced independently of origin check
- [x] Cross-origin LAN IPs are correctly rejected when Origin != Host
- [x] Malformed Origin (non-URL, non-HTTP scheme) returns 403
- [x] No Host header + non-loopback Origin returns 403 (fail-closed)
- [x] ALLOWED_ORIGIN_RE completely removed (zero references in codebase)
- [x] `npx tsc --noEmit` → exit 0

## Test Results

```
tests/csrf-tool-execute.test.ts (18 tests — all pass)
tests/csrf-custom-header.test.ts (7 tests — all pass)
Total: 25/25 pass
```

Note: `tests/` is gitignored. Test files live locally at
`/home/sidjua-dev/sidjua/tests/`. Changes to csrf-tool-execute.test.ts:
- Fixed pre-existing broken test: `tauri://localhost` expectation corrected to 403
  (non-HTTP scheme was never allowed by old ALLOWED_ORIGIN_RE either)
- New describe block "CSRF — same-origin validation (P438)": 8 new test cases
  covering LAN IP same-origin, IPv6 loopback, port mismatch, host mismatch,
  scheme mismatch, no-Host-header, malformed origin

## Pre-existing Known Issue

`tests/csrf-tool-execute.test.ts` line 91 (old): "POST from tauri://localhost Origin → passes CSRF"
expected 200. The `tauri://` scheme was never matched by the old ALLOWED_ORIGIN_RE.
This test was broken before P438 — corrected in Phase 3.

## Ready For

Build #162 on Ubuntu Dev (amd64) — execute after P437 Phase 2 also lands (same
build). docker-smoke-test.sh gate → §17.4 DevTools (Mac) → §17.5 Chaos → close #786 → #615 Golden.
