# P445a — AUDIT.md (Phase 1)
Generated: 2026-04-12T09:00:00Z

## Split Decision: P445a / P445b / P445c

- **P445a** = Phase 1 (this audit) + Phase 2 (locale dir dedup) ← current session
- **P445b** = Phase 3 (backend seed refactor: YAML → name_key → GUI render) ← next session
- **P445c** = Phase 4 + 5 (stub fill ru+es 200×2 + tests) ← dedicated session

Rationale: 400 translations alone saturate one session. Dedup is a low-risk, self-contained change that should land first as it unblocks b and c.

---

## 1.1 Canonical Locale Directory

**`src/locales/` is the canonical source.**

Evidence chain:
- `scripts/sync-locales.ts` reads/writes `src/locales/` (LOCALES = join(ROOT, "src", "locales"))
- `src/i18n/loader.ts:87`: `new URL("../locales/", import.meta.url)` → dev: `src/locales/`, compiled: `dist/locales/`
- `Dockerfile:133`: `COPY --from=builder /build/src/locales/ ./locales/` — Docker copies FROM `src/locales/`
- `package.json build`: `cp src/locales/*.json locales/` — copies src/locales → root ./locales (intermediate artifact)

**`./locales/` (root) is a committed build artifact.**
- Both dirs tracked by git (confirmed via `git ls-files`)
- `./locales/` is always overwritten by `cp src/locales/*.json locales/` during build
- No code reads from root `./locales/` at runtime:
  - Dev (tsx): loader reads `src/locales/`
  - Production Docker: loader reads `/app/locales/` which Dockerfile copies from `src/locales/`
  - Local compiled (`node dist/`): loader reads `dist/locales/` — BUILD SCRIPT BUG: currently copies to root `./locales/` instead of `dist/locales/`

**Dedup plan (Phase 2):**
1. `git rm -r --cached locales/` — untrack from git
2. `rm -rf locales/` — delete from working tree
3. Add `locales/` to `.gitignore`
4. Fix build script: replace `mkdir -p ... locales ...` with `... dist/locales ...`; replace `cp src/locales/*.json locales/` with `cp src/locales/*.json dist/locales/`
5. Fix `i18n:sync`: same `locales/` → `dist/locales/` in the trailing cp command
6. `npm run build` → verify exit 0

**Risk:** LOW. Docker unaffected (reads src/locales directly). Dev unaffected (tsx reads src/locales). Only impact: local `node dist/` runs now correctly read `dist/locales/` instead of a non-existent `./locales/`.

---

## 1.2 Locale Route Runtime Path

`src/api/routes/locale.ts` delegates to `src/i18n/loader.ts` functions (`loadLocaleData`, `getAvailableLocales`). Loader resolves path at line 87:

```typescript
const LOCALES_DIR = fileURLToPath(new URL("../locales/", import.meta.url));
// Dev (tsx src/i18n/loader.ts):      → src/locales/
// Prod (node dist/i18n/loader.js):   → dist/locales/  (= /app/locales/ in Docker)
```

After Phase 2, local compiled runs will also correctly find locales in `dist/locales/`.

---

## 1.3 YAML→DB→API→GUI Chain Map

**Chain 1: Divisions page (`/divisions`)**
```
src/defaults/divisions/*.yaml
  → loadDefaultDivisions() in src/defaults/loader.ts
    → returns Division[] with raw English name/description strings
      → GET /api/v1/starter-divisions (starter-agents.ts:53)
        → { id, name, protected, description, agent_count, agents, budget }
          → Divisions.tsx: {div.name}, {div.description}  ← CEO sees English always
```

**Chain 2: DB-backed divisions (Dashboard / agent assignment)**
```
src/apply/database.ts::syncDefaultDivisions()
  → INSERT OR IGNORE INTO divisions (code, name_en) VALUES (div.id, div.name)
    → GET /api/v1/divisions → SELECT * FROM divisions
      → consumed by Dashboard/agent views via name_en column
```

Note: `syncDefaultDivisions` uses `INSERT OR IGNORE` — if a user customized a division name post-install, the row is NOT overwritten. This is intentional and must be preserved.

---

## 1.4 Architecture Decision: Hybrid A for System Seeds

**Decision: Architecture A (lean, key-derivation variant) for system-seeded divisions + roles.**

Rationale:
- (a) **DB migration cost**: Not needed for the Divisions page fix — `starter-divisions` reads from YAML, not DB. For the DB path, a one-time migration would update `name_en` to a key, but this breaks user-customized names (INSERT OR IGNORE means user-modified rows coexist). Avoid DB migration.
- (b) **Backwards compat**: System-seeded divisions have `protected: true` (executive, system). Workspace is `protected: false` but still a seed. User-customized divisions have user-defined names. By leaving DB `name_en` untouched and adding a GUI-side lookup, no existing data is modified.
- (c) **Custom division coexistence**: A custom division named "Vertrieb" has no `name_key` in the API response → GUI falls back to `div.name` (raw string). System divisions get `name_key` derived from `id` → GUI renders `t(name_key)`.

**Implementation (P445b):**
- Add `name_key` and `description_key` fields to `Division` type: `gui.divisions.system_seed.{id}.name`
- Populate them in `parseDivisionFile()` (or `loadDefaultDivisions()`) via simple template: `gui.divisions.system_seed.${div.id}.name`
- `GET /api/v1/starter-divisions` already maps YAML fields → include `name_key`, `description_key`
- `Divisions.tsx`: `t(div.name_key) || div.name` — graceful fallback for custom divisions
- Same pattern for roles in `getStarterAgents()`
- DB path (`/api/v1/divisions`) is a separate chain — add `name_key` there too, derive from `code` if it matches a known protected set

**New translation keys (18 total):**
- `gui.divisions.system_seed.executive.name` / `.description`
- `gui.divisions.system_seed.system.name` / `.description`
- `gui.divisions.system_seed.workspace.name` / `.description`
- `gui.roles.system_seed.guide.name` / `.description`
- `gui.roles.system_seed.hr.name` / `.description`
- `gui.roles.system_seed.it.name` / `.description`
- `gui.roles.system_seed.auditor.name` / `.description`
- `gui.roles.system_seed.finance.name` / `.description`
- `gui.roles.system_seed.librarian.name` / `.description`

---

## 1.5 Stub Cluster Breakdown

**ru.json: 200 stubs**
```
gui.governance   50  (pipeline steps, snapshot, policies)
gui.start_over   30  (backup/wipe flow)
gui.cost         24  (cost metrics, limits)
gui.settings     21  (bouncer, logging, appearance)
gui.config       19  (log levels, divisions config view)
gui.agents       12  (filter labels, capabilities)
gui.audit        12  (audit log table)
gui.bouncer       7  (sensitivity, patterns)
gui.org           6  (org chart)
gui.chat          5  (connection state, placeholders)
gui.divisions     5  (agents count, budget labels)
gui.first_run     2  (initial setup messages)
cli.lang          7  (language management commands)
```

**es.json: 200 stubs** — identical namespace distribution (same 200 keys, same [ES] prefix pattern)

**Translation quality target (P445c):**
- `gui.settings.*`, `gui.agents.*`, `gui.divisions.*`, `gui.chat.*` — native-level (high-visibility)
- `gui.governance.*`, `gui.audit.*`, `gui.cost.*` — competent-translator level
- `cli.lang.*` — functional, CLI-appropriate

---

## Migration Plan

**Phase 2 (this session):** Locale dir dedup only. No DB changes, no YAML changes.

**Phase 3 (P445b):** Add `name_key`/`description_key` fields. Pure additive — API response gets new optional fields, GUI uses them with fallback. Zero DB migration. Zero schema change.

**Phase 4 (P445c):** Fill 200 ru + 200 es stubs. Pure JSON text changes. Add stub-regression test.

**Post-P445:** DB path (`/api/v1/divisions`) also needs `name_key` for Dashboard names. Defer to P446 or include in P445b.
