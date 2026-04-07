# Changelog

All notable changes to SIDJUA are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-04-XX

### Added
- GUI Update Check panel in Settings/About with configurable auto-check interval
- Updater container self-shutdown sequence after a verified, successful update
- Blue/green update infrastructure: agent freeze/resume lifecycle, drain middleware, GUI update and maintenance banners
- Tool calling in the LLM orchestrator — full reasoning loop with provider-side tool-use, memory verification, and context budget tracking
- Webhook inbound adapter with per-webhook token store, rate limiter, REST routes, and CLI management
- Prometheus metrics endpoint and bundled Grafana dashboard for runtime observability
- REST Tool Factory and Qdrant REST adapter for vector-store-backed tool retrieval
- Governed memory consolidation pipeline with feature flag infrastructure
- Composite tool wiring with HR dual-strategy extension and REST tool catalog
- YAML schema validation and MCP client integration
- Agent runtime benchmark suite with configurable load scenarios
- Migration system: versioned SQLite migrations with integrity checks and automatic backup/restore on failure
- Module SDK Light for lightweight agent module authoring; LLM SSE streaming for real-time inference output
- OpenClaw agent import pipeline — parser, field mapper, and executor
- Documentation generator scripts and CI pipeline; PDF report generator with HTML templates
- 18 additional locale languages (total 26+ supported)
- Agent definition templates, skill files, delegation protocol, and config templates
- Knip dead-code detection, `npm audit`, and Playwright smoke tests integrated into the dev pipeline

### Changed
- Orchestrator split into dedicated event-handlers and IPC modules for maintainability
- `init.ts` decomposed into `init-workspace`, `init-providers`, `init-agents`, and `init-health` modules
- Shared MCP tool execution extracted to `tool-executor-core.ts` to eliminate duplication
- CLI `logs` command migrated from long-polling to SSE streaming (with polling fallback)
- Route helpers centralised in `route-helpers.ts`; `parsePagination` and `apiHandler` deduplicated across route files
- Dead code identified by Knip removed (Phase 1)

### Fixed
- Agent-daemon rate-state upsert ordering and heartbeat sequencing
- GUI regressions: i18n key gaps, dynamic status badge, polling back-off, and CSP style-src alignment
- Variable naming in bare `catch` blocks in the definition loader (prevents `ReferenceError` at runtime)

### Security
- Symlinks with non-existent targets are now rejected in `resolveSkillPath`
- Vulnerable dependencies updated (`npm audit fix`)
- Gate-4 comprehensive audit remediation — 135 files, 2 116 insertions, 441 deletions
- Division isolation hardened; cross-division messaging restricted at the adapter and gateway layers
- Module security hardening: capability checks enforced at load time
- Token and auth hardening: scoped bearer validation, stricter SSE ticket binding
- Path security: additional traversal guards and real-path normalisation
- CLI governance gate: admission checks enforced before task submission
- Dual-audit review — 24 verified security findings addressed
- Bootstrap key migration, CSRF protection, and secret audit pipeline hardening
- WAL checkpoint failure mode changed to non-fatal (prevents service disruption on checkpoint error)

---

## [1.0.1] - 2025-12-XX

### Added
- Governance admission gate for external task creation (TaskAdmissionGate with division and budget pre-check)
- Server-side API key injection; `gui-bootstrap` endpoint deprecated in favour of server-side flow
- Bootstrap → admin token exchange on first startup (#token-exchange)
- GUI: user-friendly error messages extracted to i18n locale files
- GUI: `update_agent_role` and `update_division` tools

### Changed
- Legacy API key restricted to `bootstrap` scope only; SSE auth hardened
- LLM provider catalog metadata stripped from public responses
- CLI secret arguments removed; secrets passed via config or env

### Fixed
- Llama tool call parsing and agent auto-refresh
- Model dropdown family grouping and provider persistence
- Agent status consistency and routing defaults
- First-run UX: bootstrap token hidden, welcome overlay deferred, `firstRun` check corrected
- DB lifecycle in `run --wait`; workspace path in rollback; guarded JSON parse in pending decisions
- Docker container detection in all user-facing docker commands
- GUI: `localStorage` secrets removed; abort signal handling; CSP alignment
- Consistent division sync across all sources; RBAC reads agent definitions

### Security
- IPC socket authentication added; permissions enforced at `0600`
- Hostname-derived encryption replaced with a randomly generated master key; migration path provided
- Governance bypass env var removed; all execution routed through the orchestrator
- Tool visibility filtered by agent tier, division, and classification level
- Scoped caller context enforced on secrets routes; TTY gate for CLI reveal commands
- Sandbox fail-closed for network modules; cross-division isolation enforced
- SSRF validator added; logger race condition fixed; failover retry cap applied
- Path traversal guard on `start-over` backup; GUI serving parity enforced
- Hardened `start-over` backup path; unified bootstrap auth; secret reveal scope narrowed
- Secrets migrated from plaintext `.env` to the encrypted central secrets store

---

## [1.0.0] - 2025-10-XX

Initial stable release of SIDJUA Community Edition (V1.0.0 Golden).

[1.1.0]: https://github.com/sidjua/sidjua/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/sidjua/sidjua/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/sidjua/sidjua/releases/tag/v1.0.0
