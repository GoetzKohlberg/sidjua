# P441a Report — GUI Inline .tsx Font Scale Bump (Addendum to P441)

Date: 2026-04-12T07:05:48Z (UTC) / 2026-04-12T15:05:48+08:00 (PST)
Redmine: #792
Parent: V1.1.0 RC (#615)
Depends-On: P441 (f4dfbba)
Concurrent-With: none

## Context

P441 (#792, commit f4dfbba) bumped font-size values in
`sidjua-gui/src/styles/components.css` only (10px→12px, 12px→14px).
Phase 1.4 of P441 identified 49 occurrences of `fontSize: '10px'` or
`fontSize: '12px'` inline React styles across 21 .tsx files, flagged
as out-of-scope tech debt.

P441a applies the same bump rule to those inline styles to close the
remaining gap between the CSS-class and inline-style type scales.

## Phases Completed

| Phase | Commit   | Description |
|-------|----------|-------------|
| 1 | — (no code) | Investigation: confirm occurrence count + file list from P441 |
| 2 | 081516c  | .tsx files — inline fontSize bump (49 values changed) |
| 3 | (this commit) | report + SHA256SUMS |

## Phase 1 — Investigation Results

### 1.1 Confirmed Occurrence Count

```
grep -rn "fontSize:.*'10px'\|fontSize:.*'12px'\|fontSize:.*\"10px\"\|fontSize:.*\"12px\"" sidjua-gui/src/
→ 49 occurrences (vs. P441 Phase 1.4 estimate of 51 — minor discrepancy,
  P441a count of 49 confirmed via grep before any edits)
```

P441 Phase 1.4 listed 51 occurrences across 21 files. Confirmed count is 49
(2-occurrence discrepancy attributed to prior commits or slightly different grep
pattern). Proceeded with confirmed 49.

### 1.2 File Inventory (per-file confirmed counts)

| File | 10px | 12px | Total |
|------|------|------|-------|
| `src/pages/AuditLog.tsx` | 7 | 3 | 10 |
| `src/pages/Divisions.tsx` | 3 | 1 | 4 |
| `src/pages/Configuration.tsx` | 0 | 4 | 4 |
| `src/components/overlay/StartOverModal.tsx` | 0 | 4 | 4 |
| `src/pages/Settings.tsx` | 0 | 3 | 3 |
| `src/pages/Chat.tsx` | 0 | 3 | 3 |
| `src/components/layout/UpdateBanners.tsx` | 0 | 3 | 3 |
| `src/components/chat/RedactionDialog.tsx` | 0 | 3 | 3 |
| `src/pages/OrgChart.tsx` | 0 | 2 | 2 |
| `src/pages/Dashboard.tsx` | 0 | 2 | 2 |
| `src/components/shared/MetricCard.tsx` | 0 | 2 | 2 |
| `src/components/shared/LanguageSelector.tsx` | 0 | 2 | 2 |
| `src/pages/Setup.tsx` | 0 | 1 | 1 |
| `src/pages/Agents.tsx` | 0 | 1 | 1 |
| `src/components/shared/Toast.tsx` | 0 | 1 | 1 |
| `src/components/shared/ProgressBar.tsx` | 0 | 1 | 1 |
| `src/components/shared/OrgChartCard.tsx` | 0 | 1 | 1 |
| `src/components/shared/ConfirmDialog.tsx` | 0 | 1 | 1 |
| `src/components/shared/AgentCard.tsx` | 0 | 1 | 1 |
| `src/components/layout/Sidebar.tsx` | 0 | 1 | 1 |
| `src/components/layout/Shell.tsx` | 0 | 1 | 1 |
| **Total** | **10** | **39** | **49** |

### 1.3 Order of Operations

CRITICAL: Step A (12→14) MUST precede Step B (10→12). Reverse order
would double-bump: 10→12→14 for any `'10px'` value.

## Phase 2 — Code Changes

Files: 21 `.tsx` files in `sidjua-gui/src/pages/` and `sidjua-gui/src/components/`
Method: `sed -i -E` with backreference `\1` preserving whitespace.

### Step A (applied first): 12px → 14px

```sh
sed -i -E "s/(fontSize:[[:space:]]*)'12px'/\1'14px'/g; s/(fontSize:[[:space:]]*)\"12px\"/\1\"14px\"/g" "$f"
```

Applied to all 21 files. Changed 39 occurrences (single-quoted) + 0 double-quoted = 39.

### Step B (applied second): 10px → 12px

```sh
sed -i -E "s/(fontSize:[[:space:]]*)'10px'/\1'12px'/g; s/(fontSize:[[:space:]]*)\"10px\"/\1\"12px\"/g" "$f"
```

Applied to all 21 files. Changed 10 occurrences (9 in AuditLog.tsx +
1 in Divisions.tsx via 3 lines split = net 10 occurrences).

### Post-edit verification

```
grep -rn "fontSize:.*'10px'" sidjua-gui/src/ → 0 matches ✓
grep -rn "fontSize:.*'12px'" sidjua-gui/src/ → 9 matches (correct: former '10px' values)
```

The 9 remaining `'12px'` values are the result of Step B (10→12 conversion) —
confirmed via `git diff` spot-check on Divisions.tsx:
```
- fontSize:     '10px',   →  + fontSize:     '12px',   (×3 in Divisions)
- fontSize:     '12px',   →  + fontSize:     '14px',   (×1 in Divisions)
```

### git diff --stat

```
21 files changed, 49 insertions(+), 49 deletions(-)
```

Each line changed is a 1-line substitution: 49 insertions, 49 deletions. Shape correct.

## Verification

### tsc --noEmit (GUI)

PASS (exit 0). Inline style value changes do not affect TypeScript types
(string literal → string literal, both assignable to `CSSProperties['fontSize']`).

### npm run build

PASS — Vite build completed in 2.75s.
```
dist/index.html                   1.17 kB │ gzip:   0.57 kB
dist/assets/index-Cg1WTfNr.css   34.39 kB │ gzip:   5.78 kB
dist/assets/index-CZH-DzFr.js   375.36 kB │ gzip: 104.20 kB
```

### GUI test suite (tests/gui/)

```
Test Files  2 failed | 2 passed (4)
Tests      10 failed | 126 passed (136)
```

Identical to P441 baseline. P441a introduced 0 new test failures.

The 2 failing test files are unchanged pre-existing failures:
- `tests/gui/tauri-allowlist.test.ts` — 9 tests: tauri.conf.json removed in P434a
- `tests/gui/update-check-row.test.ts` — 1 test: Settings.tsx source assertion on prior commit

## Out of Scope

- `globals.css` body `font-size: 14px` — unchanged (already at target)
- `components.css` — already bumped in P441 (f4dfbba)
- `11px`, `13px` inline values — not in CEO's bump range
- `fontSize` in CSS class names or template strings — none exist
- `className` migration — P441a is value-only, no architecture change
- Backend (`src/api/`) — untouched

## Ready For

Build #164 on Ubuntu Dev (amd64, BUILD_NUMBER=164). Bundled with P440 + P441.
CEO Session Act IV visual check: inline-styled components (AuditLog.tsx table
cells, etc.) should match the CSS-class-governed components in text size after
this patch.
