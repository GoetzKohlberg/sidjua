# P438.1 Report — Remove Obsolete Tauri CSRF Test Cases

Date: 2026-04-12T03:56:26Z (UTC) / 2026-04-12T11:56:26+08:00 (PST)
Redmine: #786 (re-opened from Resolved to In Progress for P438 collateral fix)
Parent: V1.1.0 RC (#615)
Depends-On: P438 phase 2 (1d6079a)

## Context

P438 code-DONE was declared with "25/25 CSRF tests grün" but only 2 test files
were verified. The full CSRF-relevant surface is 8 files / 184 tests. Broader
run at commit 360bf69 surfaced 6 failures in 3 files — all of them pre-existing
assertions against Tauri origins that P438 now correctly rejects as malformed.

Tauri is gone. P434a ripped Tauri out. BOOTSTRAP-V2 v1.0 (Tauri-based) is
ARCHIVED. BOOTSTRAP-V2 v2.1 + ARCHITECTURE-BROWSER-ONLY V1.1 are the current
rules. Any test asserting "tauri:// passes CSRF" encodes a dead spec.

## Phases Completed

| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | — (no code) | Investigation: baseline run, file reads, production grep, test surface grep |
| 2 | (gitignored) | Delete 6 Tauri tests from 3 files (tests/ is gitignored, local only) |
| 3 | — (no code) | Verification: target suite, CSRF broad suite, full suite counts |
| 4 | (this commit) | report + SHA256SUMS |

Note: `tests/` is excluded by `.gitignore:39`. Test changes are local-only on
sidjua-dev, same as P438 phase 3. No force-add.

## Phase 1 — Investigation Results

### Baseline (commit 360bf69)
```
npx vitest run tests/security/xai-audit-medium-p174.test.ts \
              tests/security/api-validation-h1-h2.test.ts \
              tests/security/prompt-119-fixes.test.ts
Tests: 6 failed | 117 passed (123)
```
Exactly 6 failures in 3 files, as specified. Count matches prompt — no escalation needed.

### Production code Tauri refs
```
grep -rn "tauri://" src/ → 0 matches
```
Confirmed: Tauri completely removed from production code.

### Test files with tauri://
```
grep -rln "tauri://" tests/ → 4 files
  tests/csrf-tool-execute.test.ts           ← already migrated in P438 phase 3 (expects 403)
  tests/security/xai-audit-medium-p174.test.ts
  tests/security/api-validation-h1-h2.test.ts
  tests/security/prompt-119-fixes.test.ts
```
No additional files beyond the 3 targets. No scope expansion needed.

## Deleted Tests (6 Tauri + 1 orphaned non-Tauri within T4 block = 7 total)

### tests/security/xai-audit-medium-p174.test.ts — entire T4 describe (4 tests)

| Test | Tauri? | Was failing? |
|------|--------|-------------|
| "Tauri 1.x origin (tauri://localhost) passes CSRF check" | Yes | Yes |
| "Tauri 2.x origin (tauri://localhost.localhost) passes CSRF check" | Yes | Yes |
| "Unknown origin is rejected with 403" | No — but inside T4 block | No (was passing) |
| "CSRF source regex handles both Tauri versions explicitly" | Yes (asserted `(\.localhost)` in removed ALLOWED_ORIGIN_RE) | Yes |

Prompt specified "delete entire T4 describe block". The 4th test ("Unknown origin")
was a passing test inside the T4 block; its assertion is covered by ≥5 other tests
in other files. Also removed: `buildCsrfApp()` helper, dead `csrfMiddleware` +
`Hono` imports, T4 entry in file JSDoc (updated to document removal).

### tests/security/api-validation-h1-h2.test.ts — 1 test in H2 #519 describe

- "tauri://localhost Origin passes" — expects status 200, gets 403

11 other H2 #519 tests kept intact.

### tests/security/prompt-119-fixes.test.ts — 2 tests in FIX M4 describe

- "POST from tauri://localhost is allowed" — expects status 200, gets 403
- "POST from tauri://localhost.localhost (macOS Tauri variant) is allowed" — expects 200, gets 403

11 other FIX M4 tests kept intact.

## Residue Scans

```
grep -rn "tauri://" src/     → 0 matches
grep -rn "tauri://" tests/   → 3 lines in csrf-tool-execute.test.ts only:
  - comment line (// tauri:// is a non-HTTP scheme...)
  - it() description string ("POST from tauri://localhost Origin → 403 CSRF...")
  - headers value in test request body
  All 3 lines are inside a test asserting 403, NOT 200. No live Tauri-allowing
  assertions remain anywhere in the test suite.
```

## Verification

### tsc --noEmit
PASS (exit 0) after Phase 2 deletions.

### Target file suite (3 files)

| Metric | Before P438.1 | After P438.1 |
|--------|---------------|--------------|
| Tests  | 123           | 116          |
| Pass   | 117           | 116          |
| Fail   | 6             | 0            |

### CSRF-relevant broad suite (8 files)

| Metric | Before P438.1 | After P438.1 |
|--------|---------------|--------------|
| Files  | 8             | 8            |
| Tests  | 184           | 177          |
| Pass   | 178           | 177          |
| Fail   | 6             | 0            |

### Full suite

| Metric | Before P438.1 (360bf69) | After P438.1 |
|--------|------------------------|--------------|
| Tests  | 9028                   | 9021         |
| Pass   | 8971                   | 8970         |
| Fail   | 39                     | 33           |
| Skip   | 18                     | 18           |

Fail delta: −6 (exactly the 6 Tauri tests). Total delta: −7 (6 failing + 1
passing "Unknown origin" test inside T4). Pass delta: −1 (that same test).

## Pre-Existing Failures Not Addressed (33 remaining)

These are pre-existing unrelated failures present before P438/P438.1:
- bwrap/bubblewrap not installed on sidjua-dev — sandbox tests that hit real binary
- Various other host-dependency drifts (auth-verify.test.ts missing module, etc.)
None of these are CSRF-related or caused by P438/P438.1. Not in scope.

## Lessons Applied

Per-prompt CSRF middleware preflight grep (NEW RULE from P438.1):
```bash
grep -rln "tauri://\|ALLOWED_ORIGIN\|allowedOrigins\|sameOrigin\|csrfMiddleware\|origin.*header" \
  tests/ --include="*.test.ts"
```
Every matched file must be explicitly run with `npx vitest run <file>` in verification.
"N/N tests grün" on one file is not a valid closing condition when other files touch the
same middleware. Opus to add to RECURRING-ERRORS-BLOCK.md.

## Ready For

Build #162 on Ubuntu Dev (amd64, BUILD_NUMBER=162). P437 + P438 + P438.1 all
complete. docker-smoke-test.sh gate → §17.4 DevTools (Mac) → §17.5 Chaos →
close #786 → #615 Golden.
