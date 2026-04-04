# SONNET STATE — `cat` THIS FIRST, EVERY PROMPT
# Updated: 2026-04-03 07:45 PHT | Sonnet T2

## HARD GATES (run before code)
Gate0: cat SONNET-STATE.md (this file)
Gate1: test -x .git/hooks/pre-commit
Gate2: npx tsc --noEmit → exit 0
Gate3: npm test → 0 failed
Gate4: docker compose up -d --build → OK
Gate5: package.json version check
Gate6: no internal data in staged files

## BANS — ZERO TOLERANCE
catch {}: ALWAYS name error → catch (err) or catch (_err)
catch in governance: MUST return false/denied. NEVER catch { return true }
as never / as unknown as T: ZERO in src/. Fix actual types, never cast
process.cwd(): use opts.workDir for DB paths
JSON.parse on DB rows: wrap per-row try/catch
fetch() without URL validation: reject private IPs
sync fs ops in hot paths: use fs/promises
internal refs in code/commits: NO ticket#, prompt#, session#, IPs, NAS paths, agent names
static callerContext fallback: NEVER. Use per-request middleware (requireCallerCtx pattern)
CLI reveal without TTY check: secret/token/email --reveal MUST guard process.stdout.isTTY
duplicate utility functions: canonical location only (version-utils.ts, db/helpers.ts)
work-dir without boundary check: validateWorkDir() rejects system-critical paths
--file/--config without size check: statSync().size > 1MB → reject before loading

## COMMIT FORMAT
RIGHT: fix: description | feat: description | security: description
WRONG: fix(#7): ... | feat(P281): ... | docs(Z#4): ...
NO ticket numbers. NO prompt numbers. Repo is PUBLIC.

## TEST EXPECTATIONS
HR tools: 7 (create_agent_role, create_division, list_agents, list_divisions, get_agent_role, update_agent_role, update_division)
Routing default: "guide" (NOT "opus-t1")
Docker image: ghcr.io/goetzkohlberg/sidjua:1.0.0
i18n _template.json: same keys as en.json, all values ""
Bare catch blocks in src/: 0
`as never` casts in src/: 0
Bouncer scan route: MUST be registered BEFORE /api/v1/chat/:agentId (route order matters)
workspace_config keys: locale, bouncer_enabled, bouncer_sensitivity, installed_languages

## DUAL CODE PATHS — MUST SYNC
start.ts = CLI, cli-server.ts = Docker. Change one → change both.
When adding services to ChatRouteServices or OrgChartRouteServices: wire in BOTH entry points.

## COMPLETED BLOCKS (V1.0.2)
Block A: P338-P344 + P344A/B/C — Internal Tools + MCP + Audit 1 Fixes
Block B: P345-P347 — Org Chart System
Block C: P348-P349 — Glasscheibe Public Visualizer
Block D: P350 — Org Chart Import
Block E: P351-P354 — File Upload in Chat
Block F: P355 — Audit-2 Security Hardening
Block G: P356 — Qdrant Vector Store Integration
Activity Stream: P336-P337

## COMPLETED BLOCKS (V1.0.3)
Block H: P357-P360 — Bouncer + Task Pipeline Viz + Language Management
Block I: P367-P370 — Blue/Green Update Infrastructure (full)
  P368: Caddy proxy + Go sidecar (bluegreen.go/caddy.go/state.go/main.go) + drain/readonly middleware
        + system/update lifecycle routes + agent freeze/resume + GUI UpdateBanner/MaintenanceBanner
  P369: Migration framework (SQLite safety PRAGMAs, WAL, busy_timeout) + 9 new tests
  P370: Blue/Green integration tests (blocked from public repo by design)
  P368-AD: TS error fixes (exactOptionalPropertyTypes), deep health wired into /api/v1/health
           via injectable provider in system.ts, updater proxy route tests (+5)

## KEY FILES FOR BLOCK I
docker/updater/main.go + bluegreen.go + caddy.go + state.go (Go sidecar — compile with go build)
docker/Caddyfile + docker-compose.yml — Caddy reverse proxy blue/green config
src/api/middleware/drain.ts + readonly.ts — request-level gate middleware
src/api/routes/update-lifecycle.ts — POST /prepare /cancel /drain (called BY sidecar)
src/api/routes/system-lifecycle.ts — POST /freeze /resume, GET /state (called BY sidecar)
src/api/routes/updater.ts — GET /status /check /last-check, POST /start /rollback (UI→sidecar proxy)
src/api/routes/system.ts — setDeepHealthProvider(), /health merges deep fields when DB available
src/core/health/deep-health.ts — checkDeepHealth(db, workDir) → healthy/db_read/db_write/disk_ok/...
src/core/db/sqlite-safety.ts — enforceSQLiteSafety() WAL+synchronous+busy_timeout+foreign_keys
src/core/update/migration-framework.ts — MigrationRunner + MigrationRegistry
tests/api/update-system.test.ts — drain/readonly/lifecycle/updater proxy tests (23 tests total)

## CURRENT
Version: 1.0.1 | Build: 91 | Tests: 8328 pass, 0 fail (pre-existing flaky: parallel-execution timing), 18 skipped
Last commit: cd0e4e6 — agent runtime hardening (dead worker recovery + backpressure + immutable audit, P386)
Deadline V1.0.2: 2026-04-20 | V1.0.3: 2026-05-01 | V1.1: 2026-05-15

## NOTES FOR NEXT SESSION
P373 YAML Schema Validation + Docs Pipeline — COMPLETE (commit ccdf8b4)
P374 MCP Client Core — COMPLETE (commit ccdf8b4, 55 new tests)
P375 Tool Calling in Orchestrator — COMPLETE (commit 7905fad, 33 new tests)
P376 Module SDK Light — COMPLETE (36 new tests, uncommitted)
P377 Streaming — LLM SSE Endpoint, Provider Streaming, Tool-Use Events — COMPLETE (15 new tests, uncommitted)

MCP key files:
  src/core/mcp/types.ts — JSON-RPC 2.0, McpTool, McpServerConfig, governance types, risk levels
  src/core/mcp/mcp-client.ts — STDIO + SSE transports, crash recovery (max 3), arg-hash logging only
  src/core/mcp/mcp-registry.ts — YAML parsing, ${secrets:KEY} resolution, tool index, governance filter
    + initializeWithModules(Map<string, McpServerConfig>) — YAML wins on name collision
  src/core/mcp/mcp-governance-hook.ts — 6-stage fail-closed (risk→RBAC→budget→forbidden→ceiling→rate)
  src/core/mcp/mcp-tool-adapter.ts — Anthropic/OpenAI/Ollama format conversion + detectProviderFromModel()
  src/core/mcp/tool-selector.ts — selectRelevantTools() keyword-scored, caps at maxTools
  src/core/mcp/context-budget.ts — estimateTokens() + compressContext() (keeps first+tail, removes middle)
  src/core/mcp/memory-verifier.ts — verifyMemoryReferences() path existence + workDir boundary
  src/core/mcp/tool-executor.ts — McpLlmProvider, createMcpLlmProvider(), executeWithToolLoop()
    MAX_TOOL_ITERATIONS=10, hard ceiling=25, activityEmitter for mcp.tool.{called,success,blocked,error}
  src/core/mcp/tool-executor-streaming.ts — executeWithToolLoopStreaming() AsyncGenerator<LlmStreamEvent>
    same governance/audit as executeWithToolLoop; fallback for non-streaming adapters
    tool_use_input_delta NOT forwarded to caller (security: may contain secrets)
  src/api/routes/mcp-routes.ts — /api/v1/mcp/servers, /tools, /tools/:agentId, /reload, /test/:server
  src/api/routes/stream-routes.ts — GET /api/v1/stream/:agentId?message=<text>
    requireScope("readonly"), max 5 concurrent streams/token, 5-min idle timeout
    builds ProviderAdapter from ConfiguredProvider; uses executeWithToolLoopStreaming when mcpRegistry present
  config/mcp-servers.yaml.default — template copied by sidjua init
  DUAL PATH wired: server-startup.ts + start.ts both create McpRegistry and call shutdown()

Module SDK key files (P376):
  src/core/modules/types.ts — ModuleDefinition, InstalledModule
  src/core/modules/module-scanner.ts — scanModules() reads modules/ dir, validates module.yaml
    NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, path traversal in cmd/args rejected
  src/core/modules/module-installer.ts — installModule() npm --ignore-scripts, removeModule(), deriveModuleName()
    NPM_TIMEOUT_MS=120_000; cleanup on failure catches (_err)
  src/core/modules/module-scaffolder.ts — scaffoldModule() creates module.yaml+package.json+index.js
  src/core/modules/module-registry-bridge.ts — moduleToMcpConfig(), mergeGovernanceOverrides(), buildModuleConfigMap()
    relative stdio command resolved: join(module.path, command)
  DUAL PATH: server-startup.ts + start.ts both call scanModules() + initializeWithModules()
  CLI: sidjua module init/add/remove/test (in src/cli/commands/module.ts)
  sidjua init now creates modules/ directory (src/cli/commands/init.ts)
  i18n: 18 cli.module.* keys in en.json/de.json/_template.json + all 42 other locales

Provider streaming (P377):
  LlmStreamEvent in src/providers/types.ts — text_delta, tool_use_start/end/input_delta, message_done, error
  chatStream?() optional on ProviderAdapter interface
  AnthropicAdapter.chatStream() — SSE: content_block_start/delta/stop, message_delta/stop
  OpenAICompatibleAdapter.chatStream() — SSE: choices[0].delta.content + tool_calls

P375 integration in reasoning-loop.ts:
  ReasoningLoopDeps.mcpRegistry?: McpRegistry | null
  use_tool dispatch: getServerForTool() → callTool() direct (bypasses dispatchTool for MCP tools)
  ToolCall.id now preserved in AnthropicAdapter + OpenAICompatibleAdapter parseToolResponse()
  ActivitySeverity: "warning" (not "warn") — matches activity-types.ts

P385 — LLM Context Document — COMPLETE (3 new tests, commit 302da9f):
  docs/llm/SIDJUA-ARCHITECTURE-CONTEXT.md — 10914 chars, ~2728 tokens (limit 8000)
  Sections: System Identity, Core Concepts, C4 diagram (AUTO-GENERATED markers), File Map, Data Flow (user msg + delegation), Agent Definitions table, Governance config YAML reference, API Surface table (14 endpoints), Technology Stack
  tests: llm-context-validation(3) — file exists, tokens < 8000, all 7 required sections present

P384 — Developer Documentation Content — COMPLETE (3 new tests, commit 5720211):
  docs/dev/ARCHITECTURE.md — C4 L1/L2/L3 diagrams, 15-step flow, key files table
  docs/dev/GOVERNANCE-PIPELINE.md — 6-stage flowchart, per-stage explanation, YAML config guide, FAQ
  docs/dev/MCP-CLIENT.md — architecture diagram, 10-step flow, mcp-servers.yaml reference, FAQ
  docs/dev/AGENT-SYSTEM.md — delegation diagram (T1→T2→T3), definition format, delegation rules table, FAQ
  docs/dev/MODULE-SDK.md — module.yaml format, CLI commands, governance override example, FAQ
  docs/dev/IMPORT-SYSTEM.md — 6-step import flow, skill mapping table, FAQ
  docs/dev/CONTRIBUTING.md — dev setup, testing, code style, PR workflow, architecture rules, Docker (gitignored)
  docs/dev/GLOSSARY.md — 28 terms A-W
  docs/dev/img/.gitkeep — directory for auto-generated SVGs
  AUTO-GENERATED markers in ARCHITECTURE.md, GOVERNANCE-PIPELINE.md, AGENT-SYSTEM.md — all updated by generate-dev-diagrams.ts
  tests: docs-validation(3) — file existence, Mermaid fence balance, no placeholder/secret patterns

P383 — Documentation Generator Scripts — COMPLETE (16 new tests, commit 3ab2e0a):
  .dependency-cruiser.cjs — depcruise config (doNotFollow: node_modules/dist/__tests__, tsConfig)
  scripts/extract-file-map.ts — walks src/, 6 regex export patterns, JSDoc/line-comment descriptions, docs/.build/filemap.json
  scripts/generate-llm-context.ts — ANTHROPIC_API_KEY from env (exits 1 if missing), calls claude-sonnet-4-20250514, writes docs/llm/SIDJUA-ARCHITECTURE-CONTEXT.md
  scripts/generate-dev-diagrams.ts — generateC4Level2()/generateGovernanceDiagram()/generateAgentDelegationDiagram(), updateFileWithDiagram() with AUTO-GENERATED-DIAGRAM markers
  docs/.build/mermaid-config.json — theme: primaryColor #16213e, flowchart curve basis
  .gitignore: docs/.build/deps.json + docs/.build/filemap.json gitignored; docs/api/ gitignored
  package.json: docs:api/deps/filemap/context/diagrams/render/generate scripts; build: dist/api/static + glasscheibe-widget.js
  tests: extract-file-map(7), generate-dev-diagrams(7), dependency-cruiser(2) — all in tests/scripts/

P382 — PDF Report Generator — COMPLETE (18 new tests, commit d4e39fb):
  src/core/reporting/types.ts — ReportData/Section/ChartImage/Table, AgentActivityData, GovernanceEventSummary, SystemHealthData, ReportGenerateRequest
  src/core/reporting/report-data-aggregator.ts — ReportDataAggregator: getAgentActivity()/getGovernanceEvents() queries tasks+audit_events; getSystemHealth() reads MetricsCollector
  src/core/reporting/report-template.ts — renderReportHtml() self-contained HTML + escapeHtml() (& < > " ') + renderSection/Table/Chart helpers
  src/core/reporting/report-builder.ts — buildMonthlyReport() (6 sections) + buildComplianceReport() (5 sections) + buildRecommendationsSection() (3 heuristics)
  src/core/reporting/pdf-renderer.ts — renderReport(): Puppeteer MCP strategy + HTML fallback; PdfMcpRegistry duck-type
  src/core/reporting/index.ts — barrel export
  src/api/routes/report-routes.ts — POST /api/v1/reports/generate (operator scope) + GET /api/v1/reports/:filename (basename path-traversal guard)
  src/core/metrics/metrics-collector.ts — Gauge.getValue(labels) + Gauge.getAllEntries() + Counter.getTotal() (used by aggregator)
  src/api/routes/index.ts — registerReportRoutes() wired with reportMcpRegistry/mcpRegistry fallback

P381 — Agent Definitions + Skills + Templates — COMPLETE (30 new tests):
  agents/definitions/ceo-assistant.yaml — T1 management, can_delegate_to: [hr-manager, it-manager]
  agents/definitions/hr-manager.yaml — T2 hr, budget 5.00/1.00
  agents/definitions/it-manager.yaml — T2 it, budget 5.00/1.00
  agents/skills/ceo-assistant-core.md — delegation table, synthesis workflow, German chat/English docs
  agents/skills/ceo-assistant-reporting.md — monthly/compliance/ad-hoc reports, PDF+Grafana workflow
  agents/skills/hr-core.md — internal tools, workforce analytics
  agents/skills/hr-import-openclaw.md — 5-step import workflow (German), error handling
  agents/skills/hr-agent-onboarding.md — interactive agent creation flow
  agents/skills/it-core.md — available tools, delegation response format
  agents/skills/it-grafana-management.md — MCP tool table, standard metrics, PromQL examples
  agents/skills/it-health-monitoring.md — alert thresholds, anomaly reporting format
  agents/skills/it-mcp-management.md — lifecycle commands, "Add a new tool" workflow, troubleshooting runbook
  src/core/delegation/delegation-protocol.ts — DelegationRequest/DelegationResult, validateDelegationRbac(), DelegationManager, DELEGATE_TASK_TOOL
  src/core/delegation/index.ts — barrel export
  src/core/agents/definition-loader.ts — loadAgentDefinitions() + loadSkillContent() (basename safety)
  config/templates/personal-assistant/ — 1 T3 agent, README, mcp-servers, governance
  config/templates/small-team/ — CEO(T1)+HR(T2)+2×worker(T3), skill MDs, README, mcp-servers, governance
  config/templates/developer-workspace/ — dev-assistant T3 with filesystem+github, README
  config/templates/research-lab/ — research-lead(T2)+3×researcher(T3), web-search, README
  config/templates/governance-demo/ — ceo-demo(T1)+worker-demo(T3), demo-mode.yaml, README
  tests: delegation-protocol(12), definition-loader(8), template-validation(10)

P377a-ADDON — Docs Cleanup + CLI SSE Migration + README Roadmap — COMPLETE (commit b9f109e)
P380 — OpenClaw Import Parser + Mapper — COMPLETE (41 new tests):
  src/core/import/types.ts — OpenClawAgent/Soul/Memory/Heartbeat/Skill/Channel/Installation, SkillMapping, ImportResult
  src/core/import/openclaw-validators.ts — validateOpenClawPath() (~ expansion, directory check, file presence)
  src/core/import/openclaw-parser.ts — parseAgentsMd/parseSoulMd/parseMemoryMd/parseHeartbeatMd/parseConfigYaml/parseClawHub + minimalYamlParse (3-level)
  src/core/import/skill-mapping-table.ts — 18 direct, 1 partial, 5 none; lookupSkillMapping/lookupAllSkills
  src/core/import/openclaw-mappers.ts — mapAgentToYaml/mapSoulToSkillMd/mapMemoriesToJson/mapHeartbeatsToSchedulerYaml/mapChannelsToAdapterYaml/mapSkillsToMcpConfig
  src/core/import/import-executor.ts — analyzeInstallation() (read-only) + executeImport() (write, fail-component-not-all)
  src/core/import/index.ts — barrel export
  agents/skills/knowledge/openclaw-filesystem.md — OpenClaw directory structure for HR agent
  agents/skills/knowledge/openclaw-skill-mapping.md — skill mapping table (direct/partial/none)

P379 — Prometheus Metrics + Grafana Dashboard — COMPLETE (14 new tests):
  src/core/metrics/metrics-collector.ts — Counter/Gauge + MetricsCollector singleton (12 metrics, MAX_ENTRIES=500 cardinality cap)
  src/core/metrics/index.ts — barrel export
  src/api/routes/metrics-routes.ts — GET /api/v1/metrics/prometheus (operator scope, text/plain 0.0.4) + /json
  config/grafana/sidjua-dashboard.json — 8-panel Grafana dashboard template (uid: sidjua-ops-v1)
  Instrumented: state-machine.ts (agentTasksTotal on DONE/FAILED/ESCALATED), tool-executor.ts (llmRequestsTotal+llmTokensTotal+toolCallsTotal+governanceBlocksTotal), webhook-routes.ts (webhookReceivedTotal)

P378 — Webhook Inbound — COMPLETE (commit 88e661a, 28 new tests):
  src/core/webhook/webhook-auth.ts — generateWebhookToken(), hashToken(), validateToken() (SHA-256, timingSafe)
  src/core/webhook/webhook-token-store.ts — WebhookTokenStore SQLite (save/findByAgent/getById/listAll/updateLastUsed/disable/revoke)
  src/core/webhook/webhook-adapter.ts — normalizeWebhookPayload(github/grafana/generic) + extractSafeFields()
  src/core/webhook/webhook-rate-limiter.ts — webhookRateLimitCheck() 60 req/min per agent, in-memory
  src/api/routes/webhook-routes.ts — POST /api/v1/webhook/:agentId (no requireScope, own X-Sidjua-Token auth)
    1MB payload limit, rate check, validateToken loop, normalize, ExecutionBridge.submitTask(), 202 Accepted
    401 generic for ALL auth failures (no enumeration), 413 for oversized, 429 for rate limit
  src/cli/commands/cmd-webhook.ts — sidjua webhook create/list/revoke; token shown ONCE with TTY guard
  src/core/webhook/index.ts — barrel export
  DUAL PATH: server-startup.ts + start.ts both wire WebhookTokenStore
  i18n: 6 cli.webhook.* keys in en.json/de.json/_template.json + all 42 AI locales (English fallback)

Next: continue Block H P358-P360 or start next Opus spec.

