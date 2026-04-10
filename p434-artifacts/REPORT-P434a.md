# REPORT-P434a: Tauri Rip-Out + Compose Bind + Static Asset Pipeline

**Date:** 2026-04-10 (PHT 15:43 / UTC 07:43)
**Redmine:** #779
**Sequence:** P434a → P434b → P434c → Build #158
**Status:** COMPLETE — awaiting Opus review before P434b

---

## Commits

| Phase | SHA | Description |
|-------|-----|-------------|
| Phase 1 | `8721218` | Delete Tauri dependencies and source references |
| Phase 2 | `26c700b` | Remove bootstrap injection from gui-server and start command |
| Phase 3 | `a56892c` | Compose bind 127.0.0.1:47821, Caddy static+proxy, build pipeline |
| Phase 4 | (no commit) | No Tauri installation references found in docs — see note |
| Phase 5 | *(this report)* | Verification |

---

## Phase 1 — Tauri Deletion

**Deleted:** `sidjua-gui/src-tauri/` (entire Rust Tauri backend — 24 files)

**`sidjua-gui/package.json` changes:**
- Removed from `dependencies`: `@tauri-apps/api@2.0.0`, `@tauri-apps/plugin-store@2.0.0`
- Removed from `devDependencies`: `@tauri-apps/cli@2.0.0`
- Removed scripts: `tauri`, `tauri:dev`, `tauri:build`
- Updated description: "SIDJUA Web GUI — browser-native React application"

**`sidjua-gui/src/lib/tauri-commands.ts`:**
- All functions stubbed with `throw new Error('... TODO P434c: rewire to REST API')`
- `isTauriEnvironment()` returns `false`
- `@tauri-apps/api/core` import removed

**`sidjua-gui/src/lib/config.ts`:**
- Removed: `SidjuaBootstrap` interface, `WindowWithBootstrap` interface
- Removed: `exchangeForAdminToken()` function
- Removed: bootstrap `useEffect` that read `window.__SIDJUA_BOOTSTRAP__`
- Simplified: `setConfig()` — removed token-exchange path, now calls `setConfigState` directly
- Removed unused imports: `API_PATHS`, `TokenCreateResponse`

**npm ls:** zero `@tauri-apps/*` in dependency tree

---

## Phase 2 — Server-Side Bootstrap Cleanup

**`src/api/gui-server.ts` — `serveIndexHtmlWithBootstrap()`:**
- Removed: `peerAddr`, `isLocal`, `serverUrl`, `payload`, `script` variables
- Removed: `window.__SIDJUA_BOOTSTRAP__` injection line
- Kept: Vite inline script nonce injection (CSP compliance)
- Kept: `no-store, no-cache` response headers
- `_getApiKey` parameter retained (underscore-prefixed) for call-site compatibility

**`src/cli/commands/start.ts` — local `serveIndexHtmlWithBootstrap()`:**
- Same changes as gui-server.ts

**tsc --noEmit:** exit 0 (clean)

---

## Phase 3 — Compose Bind + Static Asset Pipeline

**`docker-compose.yml`:**
- Port changed: `"3000:3000"` → `"127.0.0.1:47821:3000"` (loopback-only bind)
- Added volume: `./sidjua-gui/dist:/srv:ro` (Caddy static file root)

**`docker/proxy/Caddyfile`:**
- Added `/api/*` handle: `reverse_proxy sidjua_blue:4200`
- Added `handle`: `root * /srv`, `try_files {path} /index.html`, `file_server`
- (SPA fallback: unknown paths → index.html → React Router)

**`scripts/build-docker.sh`:**
- Added GUI pre-build step: `(cd sidjua-gui && npm run build)` before `docker buildx`
- Note: Dockerfile already builds GUI internally; local step ensures dist/ exists for compose bind

**GHA `docker-publish.yml`:** No Tauri steps found — no changes.

**`docker compose config` output:**
```
host_ip: 127.0.0.1
published: "47821"
```

---

## Phase 4 — Documentation

**Audit result:** No Tauri/dmg/msi *installation* references found in:
- `README.md` — only `.msi` = Node.js Windows installer; "Tauri" appears only in
  the V2.0 Architecture Vision section (explicitly forward-looking, not a current
  install guide, no change made)
- `docs/INSTALLATION.md` — `.msi` = Node.js installer only; no Tauri references
- `INSTALLATION-V1.md` — file does not exist in repo
- `DEPLOY-PIPELINE-V1.md` — file does not exist in repo

No documentation commit needed.

---

## Phase 5 — Verification Gates

### §18.3 Grep Results (all must be zero)

| Pattern | Files Searched | Hits | Exit |
|---------|---------------|------|------|
| `@tauri-apps` | `sidjua-gui/src`, `sidjua-gui/package.json` | 0 | 1 ✓ |
| `window.__TAURI__` | `sidjua-gui/src` | 0 | 1 ✓ |
| `__SIDJUA_BOOTSTRAP__` | `src/`, `sidjua-gui/src` | 0 | 1 ✓ |
| `exchangeForAdminToken` | `sidjua-gui/src` | 0 | 1 ✓ |
| `secureStoreSet\|Get\|Delete` | `sidjua-gui/src` | 0 | 1 ✓ |
| `keyring` | `sidjua-gui/src` | 0 | 1 ✓ |

### npm ls

```
npm ls | grep -i tauri → 0 results (exit 1 = no match)
```

### docker compose config

```
host_ip: 127.0.0.1
published: "47821"
```

### sidjua-gui npm run build

```
✓ 1630 modules transformed.
dist/index.html       1.17 kB │ gzip:   0.57 kB
dist/assets/*.css    34.39 kB │ gzip:   5.79 kB
dist/assets/*.js    367.52 kB │ gzip: 102.65 kB
✓ built in 2.78s
```

Exit: 0 ✓

### tsc --noEmit (sidjua root)

Exit: 0 ✓

### tsc --noEmit (sidjua-gui)

Exit: 0 ✓

### npm run lint (sidjua root)

Exit: 0 ✓

---

## Notes for Opus / P434b

1. **P434a is NOT independently deployable.** Auth flow stubs are in place — the GUI
   will show an empty state (no credentials, no auto-bootstrap). P434b adds the
   backend `GET /api/v1/auth/verify` endpoint and session flow.

2. **tauri-commands.ts stubs:** `tauriRevealSecret`, `tauriCreateToken`,
   `tauriShutdownServer` throw at runtime. Currently no caller exists in the GUI
   (grep confirmed). P434c rewires these to REST.

3. **Dockerfile:** Line 35 still has `--ignore-scripts` comment referencing
   `@tauri-apps/cli`. This is harmless (the flag has no effect without the package)
   and Dockerfile is outside the TOUCH-ONLY scope — flag for cleanup in P434c or
   post-Golden.

4. **`isBootstrapSession`:** Still in the exported `AppConfigContextValue` interface
   and in component state, but will always be `false` now. Safe to remove in P434c
   once the new auth flow is wired.
