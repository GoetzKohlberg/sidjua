# SIDJUA GUI

Browser-native web UI for the [SIDJUA](../README.md) AI agent governance platform, built with **React 18**, **TypeScript**, and **Vite 6**.

---

## Overview

The SIDJUA GUI provides a real-time monitoring and governance dashboard that connects to a running SIDJUA server over its REST API. It is a **pure API client** — all data and governance logic lives in the SIDJUA server process; the GUI only displays and controls it.

### Features

| Page | Description |
|---|---|
| **Dashboard** | Summary metrics, division overview, real-time activity feed, system health |
| **Agents** | Live agent list with status updates, filterable by division/status, detail panel |
| **Governance** | Pipeline overview, snapshot history, CLI reference |
| **Audit Log** | Filterable, paginated audit trail with JSON/CSV export |
| **Cost Tracking** | Spend by period, division breakdown, sortable agent cost table |
| **Configuration** | Division config viewer (syntax-highlighted JSON), system info, log levels |
| **Settings** | Server URL + API key, light/dark theme toggle |

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 22+ |
| npm | 10+ |

---

## Development

```bash
# Install dependencies
npm install

# Start Vite dev server
npm run dev
```

Open `http://localhost:1420` in a browser.

---

## Build

```bash
# Using the build script (recommended)
./scripts/build.sh

# Direct Vite CLI
npm run build
```

Web assets are produced in `dist/`.

---

## Configuration

Connection settings (server URL + API key) are saved to browser `localStorage` by the Settings page.

### Environment variables (Vite build time)

| Variable | Default | Description |
|---|---|---|
| `VITE_DEFAULT_SERVER_URL` | `http://localhost:3000` | Pre-filled server URL |

---

## Project Structure

```
sidjua-gui/
├── src/
│   ├── api/
│   │   ├── client.ts       # SidjuaApiClient — typed REST wrappers
│   │   ├── sse.ts          # SidjuaSSEClient — SSE with ticket auth + reconnect
│   │   └── types.ts        # All API response types
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Shell.tsx       # Root layout (sidebar + header + main)
│   │   │   ├── Sidebar.tsx     # Navigation (collapses to icons < 1000px)
│   │   │   └── Header.tsx      # Breadcrumbs + connection indicator
│   │   └── shared/
│   │       ├── ActivityFeed.tsx  # Real-time event stream
│   │       ├── ConfirmDialog.tsx # Modal confirmation with danger variant
│   │       ├── ErrorBoundary.tsx
│   │       ├── LoadingSpinner.tsx
│   │       ├── MetricCard.tsx
│   │       ├── ProgressBar.tsx
│   │       ├── StatusBadge.tsx
│   │       ├── Toast.tsx         # Toast stack + ToastProvider + useToast hook
│   │       └── ThemeToggle.tsx
│   ├── hooks/
│   │   ├── useAgents.ts    # Agent list with filter deps
│   │   ├── useAgent.ts     # Single agent detail
│   │   ├── useApi.ts       # Generic fetch hook with cancellation
│   │   ├── useDivisions.ts # Division list
│   │   ├── useHealth.ts    # Polling health check (30s interval)
│   │   ├── useSse.ts       # SSE connection + last event
│   │   ├── useTheme.ts     # theme context consumer
│   │   └── useUndo.ts      # Undo stack + Ctrl/Cmd+Z global handler
│   ├── lib/
│   │   ├── config.ts       # AppConfigProvider + useAppConfig
│   │   ├── download.ts     # Browser Blob export helpers
│   │   ├── format.ts       # formatCurrency, formatUptime, formatRelative, …
│   │   ├── highlight.ts    # JSON syntax highlighter (no library)
│   │   └── theme.ts        # ThemeProvider
│   ├── pages/
│   │   ├── Agents.tsx
│   │   ├── AuditLog.tsx
│   │   ├── Configuration.tsx
│   │   ├── CostTracking.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Governance.tsx
│   │   └── Settings.tsx
│   ├── styles/
│   │   └── globals.css     # CSS custom properties, dark/light themes
│   ├── App.tsx
│   └── main.tsx
├── scripts/
│   └── build.sh            # Web build helper
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Real-Time Updates

The GUI connects to the SIDJUA SSE endpoint for live updates:

1. **Ticket auth**: `POST /api/v1/sse/ticket` (Bearer token) → UUID ticket
2. **EventSource**: `GET /api/v1/events?ticket=<uuid>`
3. **Reconnect**: exponential backoff (1s → 30s max)
4. **Event types**: `agent:started`, `agent:stopped`, `task:created`, `task:completed`, `governance:blocked`, `cost:budget_warning`, etc.

The Dashboard seeds its activity feed from the REST audit log on first load, then prepends live SSE events. The Agents page maintains a `Map<id, Agent>` that's updated on every agent SSE event with a 1.5s flash animation.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Escape` | Close detail panel (Agents, Audit Log) |
| `Ctrl+Z` / `Cmd+Z` | Undo last undoable action |

---

## License

AGPL-3.0-only — same as the SIDJUA server. See [../LICENSE](../LICENSE).
