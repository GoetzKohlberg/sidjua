# P445a — REPORT.md
Generated: 2026-04-12T08:52:54Z

## Split Decision
P445a (this) = Phase 1 + 2. P445b = Phase 3 (seed refactor). P445c = Phase 4+5 (stub fill + tests).

## Phase 2 — Locale Dir Dedup

**Commit:** `7003526`

**Files changed:**
- `.gitignore` — added `locales/` entry
- `package.json` — build script: `locales` → `dist/locales` in mkdir + cp
- `package.json` — i18n:sync: `locales/` → `dist/locales/` + mkdir -p guard
- `scripts/sync-locales.ts` — updated hint message
- 45 locale files deleted from root `locales/` (git rm -r --cached + rm -rf)
- `p445-artifacts/AUDIT.md` — Phase 1 deliverable

**Before:**
```
mkdir -p ... locales ...
cp src/locales/*.json locales/
```
Root `./locales/` was tracked in git (45 files, ~41K loc), always overwritten by build.

**After:**
```
mkdir -p ... dist/locales ...
cp src/locales/*.json dist/locales/
```
`src/locales/` is now the only committed copy. `locales/` is in .gitignore.

**Build verification:**
```
npm run build → EXIT 0
dist/locales/ → 45 files present
```

**Runtime paths confirmed:**
- Dev (tsx): `src/i18n/loader.ts` → `../locales/` = `src/locales/` ✓
- Compiled local: `dist/i18n/loader.js` → `../locales/` = `dist/locales/` ✓ (now populated)
- Docker: COPY `src/locales/` → `/app/locales/` (unaffected) ✓

## Architecture Decision Summary (for P445b)

Hybrid A: add `name_key`/`description_key` to `Division` type derived from id. GUI uses `t(name_key) || name`. No DB migration. See AUDIT.md §1.4 for full rationale.

## Stub Summary (for P445c)
- ru.json: 200 stubs ([RU] prefix), 7 in cli.lang, 193 in gui.*
- es.json: 200 stubs ([ES] prefix), same distribution
- Target: 0 stubs post P445c
