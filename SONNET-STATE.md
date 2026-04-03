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
Version: 1.0.1 | Build: 82 | Tests: 8159 pass, 0 fail (3 pre-existing flaky: gui-smoke+tls+multi-agent), 18 skipped
Last commit: 7905fad — P375 (tool calling in orchestrator) | P376+P377 uncommitted
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

Next: commit P376+P377, then continue Block H P358-P360 or start next Opus spec.

