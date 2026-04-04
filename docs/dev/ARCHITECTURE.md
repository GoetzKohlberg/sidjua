# SIDJUA Architecture

## What It Does

SIDJUA is a governed AI agent platform where every agent action is subject to
multi-stage governance before execution. Agents are organized in a three-tier
hierarchy (T1/T2/T3) and communicate via channel adapters, the REST API, and
the MCP protocol. The architecture is modular: an orchestrator coordinates
agents, a governance pipeline enforces policy, an MCP client bridges external
tools, and an agent runtime manages lifecycle and memory.

---

## System Context (C4 Level 1)

```mermaid
C4Context
  title SIDJUA — System Context

  Person(operator, "Operator", "Configures agents, sets budgets, reviews audit logs")
  Person(enduser, "End User", "Sends messages via Slack, Telegram, Discord, Email, or WebSocket")

  System(sidjua, "SIDJUA", "Multi-agent governance platform")

  System_Ext(llm, "LLM Provider", "Anthropic, OpenAI, Ollama, or compatible")
  System_Ext(mcp_servers, "MCP Servers", "Filesystem, GitHub, Grafana, or custom tools")
  System_Ext(channels, "Messaging Channels", "Slack, Telegram, Discord, Email, WebSocket")
  System_Ext(storage, "Storage", "SQLite database, local filesystem")

  Rel(enduser, channels, "Sends messages")
  Rel(channels, sidjua, "Inbound messages via adapter")
  Rel(operator, sidjua, "REST API / CLI")
  Rel(sidjua, llm, "LLM requests (chat, streaming)")
  Rel(sidjua, mcp_servers, "JSON-RPC tool calls")
  Rel(sidjua, storage, "Persist tasks, agents, audit events")
  Rel(sidjua, channels, "Sends responses")
```

---

## Container Diagram (C4 Level 2)

<!-- AUTO-GENERATED-DIAGRAM-START -->
```mermaid
C4Context
  title SIDJUA - System Architecture (C4 Level 2)

  Person(user, "User", "CEO, Manager, Developer")

  System_Boundary(sidjua, "SIDJUA Platform") {
    Container(api, "REST API", "Hono", "HTTP endpoints, auth, routing")
    Container(orchestrator, "Orchestrator", "TypeScript", "Agent selection, task routing")
    Container(governance, "Governance Pipeline", "TypeScript", "5-stage pre-action checks")
    Container(mcp_client, "MCP Client", "TypeScript", "JSON-RPC 2.0, STDIO/SSE")
    Container(agents, "Agent Runtime", "TypeScript", "T1/T2/T3 execution, delegation")
    Container(reporting, "Reporting", "TypeScript", "PDF generation, templates")
    Container(db, "SQLite", "Database", "Audit, config, state")
  }

  System_Ext(mcp_servers, "MCP Servers", "External tool providers")
  System_Ext(llm, "LLM Providers", "Anthropic, OpenAI, Ollama")
  System_Ext(channels, "Messaging", "Telegram, Discord, Slack, Email")
  System_Ext(grafana, "Grafana", "Dashboards, metrics visualization")

  Rel(user, api, "HTTP/WebSocket")
  Rel(user, channels, "Messages")
  Rel(channels, api, "Webhook/Adapter")
  Rel(api, orchestrator, "Route tasks")
  Rel(orchestrator, agents, "Execute")
  Rel(agents, governance, "Pre-action check")
  Rel(agents, mcp_client, "Tool calls")
  Rel(mcp_client, mcp_servers, "JSON-RPC 2.0")
  Rel(agents, llm, "Chat/Streaming")
  Rel(reporting, grafana, "Query metrics")
  Rel(orchestrator, db, "Audit, state")
```
<!-- AUTO-GENERATED-DIAGRAM-END -->

---

## How It Works

1. **Message received** — a user sends a message via a channel (Slack, Telegram, Discord, Email, or WebSocket) or directly to the REST API.
2. **Channel adapter** — the messaging gateway normalises the inbound message into a standard format and forwards it as an HTTP request to `POST /api/v1/chat/:agentId`.
3. **API layer** — the REST API authenticates the request (scoped API token or Bearer key), applies rate limiting and input sanitisation, then routes to the chat handler.
4. **Task creation** — the chat handler creates a task record in SQLite via `ExecutionBridge.submitTask()` and emits a `TASK_CREATED` event on the internal event bus.
5. **Orchestrator picks up** — the orchestrator's event loop detects the new task and selects the target agent based on the task's `assigned_agent` field.
6. **Budget pre-check** — `TaskAdmissionGate` verifies the agent's division has remaining budget before the agent loop starts.
7. **Agent runtime starts** — the agent runtime loads the agent definition (YAML) and skill files (Markdown), then begins the reasoning loop.
8. **LLM request** — the reasoning loop calls the configured LLM provider (via `ProviderAdapter`) with the conversation history and available tools.
9. **Tool call decision** — the LLM returns a tool-use request; the reasoning loop passes it to the governance pipeline.
10. **Governance pipeline** — the 6-stage pipeline checks RBAC, budget ceiling, forbidden patterns, classification level, escalation threshold, and rate limit. Any stage can block the call.
11. **MCP call** — if governance approves, the MCP client sends a JSON-RPC 2.0 request to the appropriate tool server and returns the result.
12. **Result to LLM** — the tool result is appended to the conversation and sent back to the LLM for synthesis.
13. **Loop repeats** — steps 8–12 repeat until the LLM returns a final text response (no more tool calls) or the iteration ceiling is reached.
14. **Task complete** — the reasoning loop marks the task `DONE` and emits a `TASK_COMPLETED` event.
15. **Response dispatched** — the response router sends the answer back to the originating channel or API caller; audit events are written for every tool call.

---

## Key Files

| Path | Purpose |
|------|---------|
| `src/api/` | REST API server, middleware, all route handlers |
| `src/core/orchestrator.ts` | Task scheduling, agent selection, event bus |
| `src/core/governance/` | Governance types, rollback, CLI commands |
| `src/core/mcp/` | MCP client, registry, governance hook, tool adapters |
| `src/core/agents/` | Agent definition loader, agent runtime |
| `src/core/delegation/` | Delegation protocol, RBAC validation |
| `src/core/reporting/` | PDF/HTML report generation |
| `src/core/messaging/` | Channel adapters, inbound gateway, response router |
| `agents/definitions/` | Agent YAML definitions |
| `agents/skills/` | Agent skill Markdown files |

---

## MCP Client Internals (C4 Level 3)

```mermaid
C4Context
  title MCP Client — Internal Components

  Container_Boundary(mcp, "MCP Client") {
    Component(registry, "McpRegistry", "Loads mcp-servers.yaml, indexes tools by name, resolves secret references")
    Component(client, "McpClient", "Per-server connection: STDIO or SSE transport, crash recovery, JSON-RPC dispatcher")
    Component(gov_hook, "McpGovernanceHook", "6-stage fail-closed pipeline applied to every tool call")
    Component(tool_adapter, "McpToolAdapter", "Converts tool schemas between Anthropic / OpenAI / Ollama formats")
    Component(tool_selector, "ToolSelector", "Keyword scoring to pick relevant tools from large catalogs")
    Component(executor, "ToolExecutor", "Top-level: executeWithToolLoop(), orchestrates LLM ↔ tool cycle")
  }

  System_Ext(yaml, "mcp-servers.yaml", "Server config + governance metadata")
  System_Ext(servers, "MCP Servers", "External processes")
  System_Ext(llm_provider, "LLM Provider")

  Rel(yaml, registry, "Parsed at startup")
  Rel(registry, client, "One McpClient per server")
  Rel(client, servers, "STDIO / SSE JSON-RPC 2.0")
  Rel(executor, gov_hook, "Check every call")
  Rel(executor, tool_adapter, "Format conversion")
  Rel(executor, tool_selector, "Select relevant tools")
  Rel(executor, llm_provider, "LLM inference")
```

---

## Agent Runtime Internals (C4 Level 3)

```mermaid
C4Context
  title Agent Runtime — Internal Components

  Container_Boundary(runtime, "Agent Runtime") {
    Component(loader, "DefinitionLoader", "Loads YAML definitions + skill Markdown files from agents/")
    Component(loop, "ReasoningLoop", "Multi-turn LLM + tool-call loop with iteration ceiling")
    Component(delegation, "DelegationProtocol", "RBAC-gated T1→T2→T3 delegation via DELEGATE_TASK_TOOL")
    Component(memory, "MemoryPipeline", "Embedding, BM25 + vector hybrid retrieval, WAL for durability")
    Component(lifecycle, "AgentLifecycle", "Start / stop / pause / resume with SQLite-backed state machine")
    Component(checkpoint, "CheckpointManager", "Periodic WAL checkpoints for crash recovery")
  }

  Rel(loader, loop, "Provides system prompt + tools")
  Rel(loop, delegation, "Handles DELEGATE_TASK_TOOL calls")
  Rel(loop, memory, "Retrieves context chunks before each LLM call")
  Rel(lifecycle, checkpoint, "Triggers on shutdown")
```

---

## Configuration

Agent definitions live in `agents/definitions/*.yaml`. Governance rules are in
`config/governance.yaml`. MCP server configuration is in `config/mcp-servers.yaml`
(copied from `config/mcp-servers.yaml.default` by `sidjua init`).

Environment variables relevant to the architecture are documented in
`.env.example`.

---

## Testing

```bash
# Full test suite
npm test

# Architecture-related tests
npx vitest run tests/core/
npx vitest run tests/agent-runtime/
npx vitest run tests/orchestrator/
```
