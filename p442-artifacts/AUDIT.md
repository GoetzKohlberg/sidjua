# P442 Audit — Real Font Scale Source of Truth

Date: 2026-04-12T08:21:28Z
Redmine: #TBD

---

## Phase 2 Strategy Decision

**Strategy B+ — Comprehensive +2px across all body-text range (9–16px)**

Rationale: No token system, no rem values. The entire scale is hard-coded px.
The only way to move all visible text is to bulk-bump every px value in the
body-text range (+2px per tier, highest value first to prevent double-bumping).
CSS-only bump would miss ~337 inline-style px values that govern the surfaces
CEO actually views. Both CSS files and .tsx inline fontSize literals must be
touched. Cutoff: values ≥ 17px left unchanged (heading/emphasis territory).

---

## 1.1 Type-Scale Source of Truth

No Tailwind config found. No CSS custom property font-size tokens in `:root`.
No rem usage anywhere in the codebase.

Two authoritative files — both use hard-coded px exclusively:

| File | Role |
|------|------|
| `sidjua-gui/src/styles/globals.css:193` | `body { font-size: 14px }` — base |
| `sidjua-gui/src/styles/components.css` (1948 lines) | All component-class type scale |

Plus: **inline `fontSize` literals in .tsx files** are the de-facto source of truth
for the CEO-visible surfaces (Dashboard, Settings, Sidebar). These are independent
of both files above — they win via CSS specificity.

## 1.2 Occurrence Inventory (pre-P442)

### components.css

| Value | Count | Bump |
|-------|-------|------|
| 11px  | 25    | →13px |
| 12px  | 5     | →14px |
| 13px  | 45    | →15px |
| 14px  | 53    | →16px |
| 15px  | 1     | →17px |
| 16px  | 3     | →18px |
| 18px  | 1     | unchanged |
| 28px  | 1     | unchanged (heading) |
| 32px  | 1     | unchanged (heading) |
| **Total bumped** | **132** | |

### globals.css

| Rule | Value | Bump |
|------|-------|------|
| `body { font-size }` | 14px | →16px |
| `input,textarea,select { font-size }` | inherit | unchanged |

### .tsx inline styles (post-P441a baseline)

| Value | Count | Bump |
|-------|-------|------|
| 9px   | 2     | →11px |
| 10px  | 0     | (clean) |
| 11px  | 30    | →13px |
| 12px  | 9     | →14px |
| 13px  | 86    | →15px ← main fix |
| 14px  | 64    | →16px |
| 15px  | 5     | →17px |
| 16px  | 5     | →18px |
| 17px  | 2     | unchanged |
| 18px  | 4     | unchanged |
| **Total bumped** | **201** | |

### Tailwind class usages
`grep -rnE "text-(xs|sm|base|md|lg|xl)" sidjua-gui/src/ → 0 matches`
No Tailwind utility classes in use.

## 1.3 Current Rendered Scale Baseline

- `html` element: browser default 16px (no explicit override in codebase)
- `body { font-size: 14px }` — overrides browser default for body content
- `1rem` = 16px (browser default) — but nothing in the project uses rem
- Effective body text: **14px**
- Effective dominant component text: **13px** (85% of inline values are 13–14px)
- `text-xs`/`text-sm`: N/A (no Tailwind)

On Mac Retina at default zoom, 13–14px system-UI text appears noticeably small
compared to modern applications that default to 15–16px body.

## 1.4 CEO Surface → Font-Size Source Map

### Dashboard.tsx (inline-style dominant)
- KPI metric labels: `fontSize: '13px'` (lines 38, 171, 380, 381, 389, 390)
- Alert/error text: `fontSize: '13px'` (lines 397, 410)
- Table cells (cost summary): `fontSize: '13px'` (lines 266, 269)
- Interactive element: `fontSize: '14px'` (line 298)
- Micro labels: `fontSize: '11px'` (lines 239, 363)
- **CSS class contribution: negligible** — all main content inline-styled

### Settings.tsx (inline-style dominant)
- Section descriptions/hint text: `fontSize: '13px'` (lines 567, 1014, 1025, 1049, 1063, 1079, 1137)
- Form labels / controls: `fontSize: '14px'` (lines 61, 311, 1172, 1261, 1532)
- Small hint/badge text: `fontSize: '12px'` (line 103)
- Debug/code: `fontSize: '11px'` (lines 707, 1098, 1247)
- **CSS class contribution: negligible** — all section content inline-styled

### Sidebar navigation (inline-style dominant)
- Logo text (expanded): `fontSize: '16px'` (line 110)
- Logo text (collapsed): `fontSize: '14px'` (line 110 conditional)
- Nav item labels: `fontSize: '14px'` (line 148)
- Badge / count: `fontSize: '12px'` (line 163)
- Version string: `fontSize: '11px'` (line 184)
- **CSS class contribution: zero** — fully inline-styled

### AuditLog.tsx
- Row action text: `fontSize: '15px'` (line 160)
- Row metadata: `fontSize: '13px'`/`fontSize: '11px'` (lines 191, etc.)
- Mix of inline styles and `.sidjua-table` CSS classes

### Why P441/P441a had zero visible effect on CEO surfaces

P441 bumped `components.css` px values (10→12, 12→14). P441a bumped inline
`'10px'`→`'12px'` and `'12px'`→`'14px'` in 21 files. These ranges represent
the BOTTOM of the scale (micro labels, badges). The dominant body text (13px,
14px) — which accounts for 150/201 of the bumped-in-range values — was never
touched. CSS specificity means the inline 13px values in Dashboard/Settings/
Sidebar always override any body/components rule.

**Root cause of CEO "still too small":** 86 occurrences of `fontSize: '13px'`
and 64 occurrences of `fontSize: '14px'` in inline styles were never bumped.
These govern everything CEO actually reads.
