# P442 Report — Real Font Scale Audit + Comprehensive +2px Bump

Date: 2026-04-12T08:23:31Z (UTC) / 2026-04-12T16:23:31+08:00 (PST)
Redmine: #TBD
Parent: V1.1.0 RC (#615)
Depends-On: P441 (f4dfbba), P441a (081516c)

## Phases Completed

| Phase | Commit   | Description |
|-------|----------|-------------|
| 1 | — (no code) | Audit: type-scale source of truth, occurrence inventory, surface map |
| 2 | — (no code) | Strategy decision: B+ (comprehensive +2px, see AUDIT.md) |
| 3 | 5883b0e  | globals.css + components.css + 32 .tsx files bumped |
| 4 | (this commit) | AUDIT.md + REPORT.md + SHA256SUMS |

## Phase 1 — Audit Findings (summary; full in AUDIT.md)

**Why P441/P441a had zero visible effect:**
P441 bumped `components.css` 10→12 and 12→14 (the bottom of the scale).
P441a bumped inline `'10px'`→`'12px'` and `'12px'`→`'14px'` (same bottom tier).
The CEO-visible surfaces (Dashboard, Settings, Sidebar) are fully inline-styled
at 13px (86 occurrences) and 14px (64 occurrences) — these were never touched.
CSS specificity means inline styles win over any body/class rule; changing
`components.css` rules had zero effect on those surfaces.

**Source of truth:**
- No Tailwind. No CSS custom property font-size tokens. No rem values anywhere.
- `globals.css:193 body { font-size: 14px }` — base (affects only non-overridden elements)
- `components.css` — all component-class scales (hardcoded px)
- Inline `.tsx` `fontSize` literals — de-facto source of truth for CEO-visible surfaces

## Phase 2 — Strategy

**Strategy B+ — Comprehensive +2px across body-text range 9–16px**

Rationale: No token system to target. Every visible size is a hardcoded px value.
A root-level rem/body bump (Strategy A) would not propagate to children with
explicit px overrides. The only correct fix is a bulk +2px on every tier of
the scale simultaneously. Cutoff at 17px+ (heading territory — unchanged).

Bump map: 9→11, 11→13, 12→14, 13→15, 14→16, 15→17, 16→18

## Phase 3 — Changes

### globals.css
- `body { font-size: 14px }` → `16px` (1 rule; form fields inherit → auto-scale)

### components.css
Sed applied largest-first to prevent double-bumping:

| Before | After | Count |
|--------|-------|-------|
| 11px   | 13px  | 25    |
| 12px   | 14px  | 5     |
| 13px   | 15px  | 45    |
| 14px   | 16px  | 53    |
| 15px   | 17px  | 1     |
| 16px   | 18px  | 3     |
| **Total** | | **132** |
| 18px, 28px, 32px | unchanged | — |

### .tsx inline styles (32 files)
Same sed order (16→18 first):

| Before | After | Count |
|--------|-------|-------|
| 9px    | 11px  | 2     |
| 11px   | 13px  | 30    |
| 12px   | 14px  | 9     |
| 13px   | 15px  | 86    |
| 14px   | 16px  | 64    |
| 15px   | 17px  | 5     |
| 16px   | 18px  | 5     |
| **Total** | | **201** |
| 17px, 18px+ | unchanged | — |

**git diff --stat:** 34 files changed, 334 insertions(+), 334 deletions(-)

**Post-bump verification (components.css):**
0 × 11px, 0 × 12px, 0 × 13px old values remain.
New distribution: 13px(25), 14px(5), 15px(45), 16px(53), 17px(1), 18px(4)

**Post-bump verification (.tsx):**
0 × 9px, 0 × 11px, 0 × 12px, 0 × 13px, 0 × 14px old values remain.
New distribution: 11px(2), 13px(30), 14px(9), 15px(86), 16px(64), 17px(7), 18px(9)

## Verification

### tsc --noEmit (GUI): PASS (exit 0)

### npm run build: PASS — 2.72s
```
dist/assets/index-DT7uvIhU.css   34.39 kB │ gzip:  5.78 kB
dist/assets/index-DTrVpJJR.js   375.36 kB │ gzip: 104.19 kB
```

### GUI test suite (tests/gui/):
```
Test Files  2 failed | 2 passed (4)   — identical to P441/P441a baseline
Tests      10 failed | 126 passed (136)
```
P442 introduced 0 new test failures. Pre-existing failures unchanged.

## Out of Scope

- 17px, 18px, 20px, 22px, 24px, 28px, 32px values — heading/emphasis, unchanged
- Letter-spacing, line-height, font-weight — unchanged
- Dark mode — font-size changes are scheme-neutral
- Backend (`src/api/`) — untouched
- CSS layout, grid, component structure — unchanged

## Ready For

Build #165 on Ubuntu Dev (amd64, BUILD_NUMBER=165).
CEO Session Act V visual check: Dashboard KPI labels, Settings section text,
Sidebar navigation labels should all be visibly larger (~15% increase on body
text tier). Acceptance: perceptible size improvement, no card/button overflow.
