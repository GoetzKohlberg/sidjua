# REPORT-P430-PHASE2: Helper + Lint Rule + Config

**Date:** 2026-04-10 (PHT 14:58 / UTC 06:58)
**Phase:** 2 — HELPER + LINT RULE + CONFIG
**Redmine:** #775
**Status:** COMPLETE — awaiting Opus review before Phase 3

---

## Files Created / Modified

| File | Action | Purpose |
|------|--------|---------|
| `tests/_helpers/temp-dir.ts` | Created | Repo-local temp dir helper |
| `tests/globalSetup.ts` | Created | Vitest global setup/teardown |
| `tools/eslint-rules/no-raw-tempdir.js` | Created | ESLint rule — ban raw mkdtemp/os.tmpdir |
| `eslint.config.js` | Created | ESLint flat config wiring all custom rules |
| `vitest.config.ts` | Modified | Added `globalSetup: ["tests/globalSetup.ts"]` |
| `.gitignore` | Modified | Added `.tmp-tests/` entry |

---

## Helper: tests/_helpers/temp-dir.ts

- Base path: `<repoRoot>/.tmp-tests/` (resolved via `import.meta.dirname`)
- Sanity check: throws if resolved TMP_BASE does not contain `/sidjua/.tmp-tests`
- Exports:
  - `withTempDir(prefix, fn)` — scoped to callback; try/finally cleanup guaranteed
  - `useTempDir(prefix)` — scoped to single test; registers `afterEach` cleanup
  - `TMP_BASE` — for globalSetup and inspection

Implementation notes:
- Uses `import.meta.dirname` (Node 22 ESM — available per `node --version` = v22.22.0)
- `fsSync.mkdirSync(TMP_BASE, { recursive: true })` on import (idempotent base dir creation)
- `afterEach` registration happens once per `useTempDir` call (flag `registered`)
- Consistent with project ESM style (other test files use `fileURLToPath(import.meta.url)`)

---

## ESLint Rule: tools/eslint-rules/no-raw-tempdir.js

Rule ID: `sidjua/no-raw-tempdir` (error severity in tests)

Disallows in `tests/**/*.test.ts` and `tests/**/*.spec.ts`:
- `import { mkdtemp, mkdtempSync } from 'node:fs'`
- `import { mkdtemp, mkdtempSync } from 'node:fs/promises'`
- `import { mkdtemp, mkdtempSync } from 'fs'`
- `import { tmpdir } from 'node:os'`
- `import { tmpdir } from 'os'`
- `import * as os from 'node:os'` + subsequent `os.tmpdir()` call
- `require('node:os').tmpdir()`
- `require('fs').mkdtempSync(...)`

Allows:
- Any import whose specifier contains `_helpers/temp-dir`

Error message: `"Use withTempDir/useTempDir from tests/_helpers/temp-dir instead of raw mkdtemp/os.tmpdir. See #775 / P430 for context."`

---

## ESLint Config: eslint.config.js

Flat config (ESLint 9 format). Wires all three custom rules:
- `sidjua/no-raw-tempdir` — error on test files
- `sidjua/error-style` — warn on src + test files
- `sidjua/import-order` — warn on src + test files

**BLOCKER: ESLint not in devDependencies**

`eslint` is not currently installed (confirmed: `node_modules/eslint` absent, no `eslint` binary).
The `npm run lint` script is currently `tsc --noEmit` only.

To activate the rule, two changes are needed:
1. Add `eslint` to devDependencies (requires Opus approval per effort contract)
2. Update `npm run lint` script to include `eslint .` (new npm script — also requires Opus approval)

Suggested addition (pending approval):
```json
"lint": "tsc --noEmit && eslint .",
```
Or as a separate script:
```json
"lint:eslint": "eslint ."
```

**Action required:** Opus approval in #775 journal for:
- `"eslint": "^9.x"` as devDependency
- lint script update

---

## Vitest globalSetup: tests/globalSetup.ts

- `setup()`: rm -rf `.tmp-tests/` then mkdir (clean slate before run)
- `teardown()`: rm -rf `.tmp-tests/` (wipe after run)
- Same path sanity check as helper (throws if outside sidjua repo)

Wired in `vitest.config.ts` as `globalSetup: ["tests/globalSetup.ts"]`.

### Verification

```
npx vitest run  →  Test Files: 3 failed | 605 passed (613)
                   Tests: 2 failed | 8982 passed | 18 skipped (9002)
```

- 3 pre-existing failures confirmed (gui-bootstrap + related; fail without our changes too)
- `.tmp-tests/` dir: ABSENT after run (teardown confirmed)
- Our changes caused zero regressions

---

## .gitignore

Added `.tmp-tests/` as second line (after `dist/`).

---

## Next Steps

1. **Opus review** of this report
2. **Opus approval** for ESLint devDep in #775 journal
3. After approval: install ESLint, update lint script, verify `npm run lint` catches no-raw-tempdir
4. **Phase 3** (MECHANICAL migration) — do NOT start until Opus confirms V1.1.0 Golden + releases Phase 3 in #775

---

## Commit SHA

(Will be filled after commit)
