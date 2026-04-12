# P441 Report — GUI Font Scale Bump: 10px→12px, 12px→14px

Date: 2026-04-12T06:38:20Z (UTC) / 2026-04-12T14:38:20+08:00 (PST)
Redmine: #792
Parent: V1.1.0 RC (#615)
Depends-On: none
Concurrent-With: P440 (#791) — disjoint files, no conflicts

## Context

CEO Götz observed during Session #787 Act III (2026-04-12 13:43 PHT) on Mac browser
against Build #163 that GUI text is too small to read comfortably. Direct request:
bump the base type scale by roughly two points across the board.

Interpretation: 10pt → 12pt, 12pt → 14pt (using pt loosely as px).
Scope: `sidjua-gui/src/styles/components.css` (body base in `globals.css` unchanged).

## Phases Completed

| Phase | Commit   | Description |
|-------|----------|-------------|
| 1 | — (no code) | Investigation: find type-scale source of truth, count occurrences, inventory inline outliers |
| 2 | f4dfbba  | components.css — bulk font-size bump (49 values changed) |
| 3 | (this commit) | report + SHA256SUMS |

## Phase 1 — Investigation Results

### 1.1 Type-Scale Source of Truth

No Tailwind config found. No CSS custom property tokens for font-size.

Two relevant files:
1. **`sidjua-gui/src/styles/globals.css:193`** — `body { font-size: 14px }` — base
2. **`sidjua-gui/src/styles/components.css`** (1948 lines) — primary type-scale, hardcoded px values throughout all component classes

`globals.css` body base is 14px — this is already above the 12px→14px bump threshold, so it stays unchanged.

### 1.2 Target Values

| Before | After  | Occurrences in components.css |
|--------|--------|-------------------------------|
| 10px   | 12px   | 5 (action badges, step badge, micro labels)  |
| 12px   | 14px   | 44 (table cells, code blocks, card titles, date rows, stat labels, etc.) |
| 11px   | (unchanged) | 25 — not in 10→12 or 12→14 range per prompt |
| 13px   | (unchanged) | 45 — not in range per prompt |
| 14px+ and headings | (unchanged) | — |

### 1.3 Affected UI Inventory

Pages/components with visible change after bump:
1. **Configuration page** — `.page-config--code-block` (12→14), table cells, logging labels
2. **Cost Tracking page** — date rows, division bar headers, table cells (`.page-cost--*`)
3. **Governance page** — stat labels, step labels, step desc, legend, snapshot rows (`.page-gov--*`), action-badge (10→12)
4. **All pages with `.sidjua-table`** — `.sidjua-th` (11px, unchanged), `.sidjua-card-title` (12→14)
5. **Any page using `.page-cost--div-bar-header`** — now 14px (was 12px)

### 1.4 Inline `.tsx` Style Outliers (OUT OF SCOPE — Tech Debt)

51 occurrences of `fontSize: '10px'` or `fontSize: '12px'` inline styles across 21 `.tsx` files:

| File | Count |
|------|-------|
| `src/pages/AuditLog.tsx` | 10 |
| `src/pages/Divisions.tsx` | 4 |
| `src/pages/Configuration.tsx` | 4 |
| `src/components/overlay/StartOverModal.tsx` | 4 |
| `src/pages/Settings.tsx` | 3 |
| `src/pages/Chat.tsx` | 3 |
| `src/components/layout/UpdateBanners.tsx` | 3 |
| `src/components/chat/RedactionDialog.tsx` | 3 |
| `src/pages/OrgChart.tsx` | 2 |
| `src/pages/Dashboard.tsx` | 2 |
| `src/components/shared/MetricCard.tsx` | 2 |
| `src/components/shared/LanguageSelector.tsx` | 2 |
| `src/pages/Setup.tsx` | 1 |
| `src/pages/Agents.tsx` | 1 |
| `src/components/shared/Toast.tsx` | 1 |
| `src/components/shared/ProgressBar.tsx` | 1 |
| `src/components/shared/OrgChartCard.tsx` | 1 |
| `src/components/shared/ConfirmDialog.tsx` | 1 |
| `src/components/shared/AgentCard.tsx` | 1 |
| `src/components/layout/Sidebar.tsx` | 1 |
| `src/components/layout/Shell.tsx` | 1 |

These are NOT changed in P441 (scope guardrail: no .tsx files). Recommend a follow-up
consolidation ticket to migrate inline font-size values to CSS classes in components.css.

## Phase 2 — Code Changes

File: `sidjua-gui/src/styles/components.css`
Method: `sed -E` with backreference to preserve exact whitespace between `font-size:` and value.

### Values changed

**10px → 12px (5 rules):**
- `.page-gov--action-badge` — governance pipeline action chip (line ~574)
- 4 additional 10px values in audit/cost sections (lines ~1265, 1321, 1650, 1660)

**12px → 14px (44 rules):**
- `.sidjua-card-title` — card section headers across all pages
- `.page-config--code-block` — config JSON display
- `.page-config--logging-meta-label`, `.page-config--overrides-td`, `.page-config--log-note`, etc.
- `.page-cost--date-row`, `.page-cost--date-row-last`, `.page-cost--div-bar-header`
- `.page-cost--agent-td-div`, `.page-cost--agent-td-calls`
- `.page-gov--stat-label`, `.page-gov--step-label`, `.page-gov--step-desc`, `.page-gov--legend`
- `.page-gov--snapshot-ts`, `.page-gov--snapshot-badge`, `.page-gov--code-box`
- And many more component table cells, label classes, and body text

### Not changed (per scope)
- `globals.css` body `font-size: 14px` — unchanged
- All `11px` values (25×) — not in bump range
- All `13px` values (45×) — not in bump range
- Heading sizes (20px, 24px, 28px) — unchanged
- `.tsx` inline styles (51 occurrences) — out of scope

### Comment strategy
Added a single file-level comment block at the top of `components.css` documenting the P441 scale bump (ticket #792, date, and which values changed). Per-line comments on 49 individual declarations were judged impractical for a bulk bulk CSS replacement; the file header provides the necessary archaeological record.

## Verification

### tsc --noEmit (GUI)
PASS (exit 0). Type-scale bump does not affect TypeScript types.

### npm run build
PASS — Vite build completed in 3.06s.
```
dist/index.html                   1.17 kB │ gzip:   0.57 kB
dist/assets/index-Cg1WTfNr.css   34.39 kB │ gzip:   5.78 kB
dist/assets/index-CndE-XxV.js   375.36 kB │ gzip: 104.20 kB
```

### GUI test suite (tests/gui/)
```
Test Files  2 failed | 2 passed (4)
Tests      10 failed | 126 passed (136)
```
The 2 failing test files are pre-existing failures confirmed by running the suite
against the pre-P441 HEAD (commit 53579e4):
- `tests/gui/tauri-allowlist.test.ts` — 9 tests: check for `tauri.conf.json` which
  was removed in P434a (Tauri removal). Pre-existing.
- `tests/gui/update-check-row.test.ts` — 1 test: "sends Authorization header on check"
  asserts on Settings.tsx source content that changed in a prior commit. Pre-existing.
P441 (CSS-only change) introduced 0 new test failures.

### Visual spot-check
Not performed locally (no running dev server). CEO Act IV visual check against
Build #164 is the acceptance criterion.

## Out of Scope

- Inline `.tsx` font-size values (51 occurrences, 21 files) — see Phase 1.4
- `11px` values (25×) — not in CEO's stated range
- `13px` values (45×) — not in CEO's stated range
- Headings (h1/h2/h3, 20/24/28px) — out of scope per prompt guardrails
- Letter-spacing, line-height, font-family, font-weight — unchanged
- Dark mode — no font-size variables in dark theme; change is scheme-neutral
- Backend (`src/`) — untouched

## Ready For

Build #164 on Ubuntu Dev (amd64, BUILD_NUMBER=164). Bundled with P440.
CEO Session Act IV visual check: compare Settings/Configuration page text size
against Session #787 screenshot. Acceptance: text is visibly larger, no layout breakage.
