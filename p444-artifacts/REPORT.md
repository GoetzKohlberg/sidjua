# P444 — REPORT.md
Generated: 2026-04-12T08:46:00Z

## Change

`sidjua-gui/src/styles/components.css` — `.page-settings--sensitivity-row` + `.page-settings--sensitivity-label`

### Before
```css
.page-settings--sensitivity-row {
  display:     flex;
  align-items: center;
  gap:         10px;
  margin-top:  4px;
}
.page-settings--sensitivity-label {
  font-size: 15px;
  color:     var(--color-text-secondary);
  flex:      1;
}
```

### After
```css
.page-settings--sensitivity-row {
  display:        flex;
  flex-direction: column;
  gap:            6px;
  margin-top:     4px;
}
.page-settings--sensitivity-label {
  font-size: 15px;
  color:     var(--color-text-secondary);
}
```

## Rendering
Label ("Erkennungsempfindlichkeit") on own line. Select element on line below, stretching to full container width. Long options ("Streng — erkennt die meisten Muster…") no longer crowd adjacent elements.

## Verification
- `npx tsc --noEmit` (GUI): EXIT 0
- JSX unchanged — pure CSS fix
- No other classes touched

## Commit
`a793555` fix(gui): sensitivity dropdown row→column layout (P444 phase 2)
