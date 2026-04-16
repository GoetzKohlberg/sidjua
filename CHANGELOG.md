# Changelog

All notable changes to SIDJUA are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-04-18

> Deep security-hardening pass, native LLM tool calling, blue/green updates, webhook inbound, observability foundation, migration system, and i18n rebuild. Consolidates scope from skipped V1.0.2 and V1.0.3. Some features announced for V1.1 (Brainpool, Translation Agent, Documentation Site, Community Skill System, MCP Server Mode, Agent Training Pipeline, user-facing Chat Memory, user-facing Built-in Self-Audit) moved to V1.2.

### Added
- Native LLM tool calling — full reasoning loop with provider-side tool-use, memory verification, and context budget tracking, abstracted across Claude, GPT, Gemini, Llama, Mistral, DeepSeek, and local Ollama
- Webhook inbound adapter with per-webhook token store, rate limiter, REST routes, and CLI management
- Blue/green update infrastructure: agent freeze/resume lifecycle, drain middleware, GUI update and maintenance banners
- GUI Update Check panel in Settings/About with configurable auto-check interval
- Updater container self-shutdown sequence after a verified, successful update
- Prometheus-compatible `/metrics` endpoint and bundled Grafana dashboard (foundation, full OpenTelemetry integration lands later) [Prepared]
- Versioned migration system: SQLite schema upgrades with integrity checks and automatic backup/restore on failure
- Settings / LLM Provider Redesign — provider configuration UI reworked; 44/44 backend and 25/25 GUI tests pass
- i18n architecture rebuild — 44 supported locale languages (18 added in this release), key-gap-free and machine-verified
- OpenClaw agent import pipeline — parser, field mapper, and executor, end-to-end
- Qdrant REST adapter for vector-store-backed tool retrieval, plus feature-flag-gated memory consolidation pipeline (backend only; user-facing Chat Memory arrives in V1.2) [Prepared]
- MCP client integration — SIDJUA agents can consume any MCP-compatible external tool; YAML schema validation and full client lifecycle
- Module SDK Light — lightweight authoring API for agent modules
- LLM SSE streaming — real-time inference output across providers
- Agent runtime benchmark suite with configurable load scenarios
- Composite tool wiring with HR dual-strategy extension and REST tool catalog
- Documentation generator scripts and CI pipeline; PDF report generator with HTML templates
- Zammad public support at tickets.sidjua.com with five-tier defence stack (nginx rate-limiting, CrowdSec, bot filtering, allowlist, Zammad-native guards)
- V1.2 architecture groundwork: Security Abstraction Layer, Tool Contract v2, Central Policy Decision Point, Consent Grant Service, Policy Migration, and Enterprise Backend Adapters — specification-complete, implementation post-Golden [Prepared]
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
- Gate-4 comprehensive audit remediation — 135 files, 2 116 insertions, 441 deletions
- Dual-audit review — 24 independently verified security findings addressed
- Multi-layer bouncer chain — seven pre-execution gates per agent action, tool-call parameter filter redacts sensitive data before it reaches the LLM, input sanitizer blocks prompt-injection patterns (redaction-approval persistence lands in V1.2)
- Auth, CSRF, and session hardening — session-cookie ordering, CSRF on raw fetch flows, cryptographic UUIDs replace weak random, save-activate connection-status stabilised, end-to-end authentication chain reviewed
- Division isolation hardened — cross-division messaging restricted at adapter and gateway layers; IPC authentication between agent processes with 0600 socket permissions; module capability checks enforced at load time
- Path and symlink security — path traversal guards, real-path normalisation, symlinks with non-existent targets rejected
- Secret pipeline hardening — bootstrap key migration, CSRF protection on secrets routes, secret audit pipeline hardened
- CLI governance gate — historical bypass paths closed, admission checks enforced before task submission
- Token and auth hardening: scoped bearer validation, stricter SSE ticket binding
- WAL checkpoint failure mode changed to non-fatal (prevents service disruption on checkpoint error)
- Vulnerable dependencies updated (`npm audit fix`)

### Known Limitations

These issues ship with V1.1.0 Golden and are scheduled for V1.1.1 (2026-05-10):

- Organization page displays "0 agents" for populated organizations (backend data is correct; GUI counter miscount only) — issue #819
- Chat redaction approval is not persisted to the tool-call bouncer; users must re-approve per session — issue #836
- Multi-tab provider configuration can become stale after a switch; a page reload resolves it — issue #829
- Copy-to-clipboard button in the Management Console fails silently over plain HTTP on non-localhost origins (browser `navigator.clipboard` secure-context restriction); use HTTPS or localhost — issue #824
- Locale dropdown shows internal `_de`, `_it`, `_pl` template entries alongside user-facing locales — issue #830

---

## [1.0.1] - 2026-03-31

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

## [1.0.0] - 2026-03-25

Initial stable release of SIDJUA Community Edition (V1.0.0 Golden).

[1.1.0]: https://github.com/sidjua/sidjua/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/sidjua/sidjua/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/sidjua/sidjua/releases/tag/v1.0.0
