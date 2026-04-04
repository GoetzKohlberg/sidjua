# Glossary

## A

**Agent**
A configured AI worker with a defined tier, division, budget, skill set, and
set of permitted tools. Agents are defined in YAML and execute tasks via the
reasoning loop.

**Audit Event**
A record written to the `audit_events` SQLite table for every governance
decision (allowed, blocked, or escalated). Audit events are immutable once
written.

## B

**Budget**
A per-agent cost limit enforced by the governance pipeline. Defined in USD as
`per_task_usd` and `per_day_usd` in the agent's YAML definition.

**BM25**
A keyword-based ranking algorithm used in the hybrid memory retrieval pipeline.
Implemented as an SQLite FTS5 virtual table over the `knowledge_chunks` table.

## C

**Channel**
An external messaging platform (Slack, Telegram, Discord, Email, WebSocket)
connected to SIDJUA via a messaging adapter.

**Channel Adapter**
A plugin in `src/core/messaging/` that normalises inbound messages from a
specific channel into SIDJUA's internal message format and routes outbound
responses back.

**Classification**
A sensitivity level assigned to data and tools: PUBLIC, INTERNAL, CONFIDENTIAL,
SECRET, or FYEO (For Your Eyes Only). Enforced at Stage 4 of the governance
pipeline.

**Context Budget**
The token limit management system in the MCP client. When the conversation
history plus tool results would exceed the LLM's context window,
`compressContext()` removes middle turns while preserving the first and last.

## D

**Delegation**
The act of a higher-tier agent (T1 or T2) assigning a sub-task to a lower-tier
agent via the `DELEGATE_TASK_TOOL` mechanism. Governed by
`validateDelegationRbac()`.

**Division**
An organisational unit (e.g., `hr`, `engineering`, `ops`). Agents belong to a
division; governance rules can be scoped per division.

## E

**Escalation**
A governance outcome where an action is held pending human review rather than
executed or blocked outright. Triggered by risk level or classification policy.

## F

**Fail-Closed**
A safety principle: if the governance pipeline encounters an unexpected error
or ambiguous condition, it blocks the action rather than allowing it. No
exception path can grant access.

**Forbidden Actions**
Patterns (regular expressions) configured per MCP server that block any tool
call whose name or arguments match. Enforced at Stage 3 of the governance
pipeline.

## G

**Governance**
The system of policies and enforcement mechanisms that determine which agent
actions are permitted, blocked, or escalated. Implemented as a 6-stage
fail-closed pipeline.

**Governance Pipeline**
The 6-stage sequence applied to every tool call: RBAC → Budget → Forbidden
Actions → Classification → Escalation → Rate Limit. See `GOVERNANCE-PIPELINE.md`.

## J

**JSON-RPC 2.0**
The wire protocol used between the SIDJUA MCP client and MCP server processes.
Each tool call is a `tools/call` request; tool discovery uses `tools/list`.

## M

**MCP (Model Context Protocol)**
An open standard for exposing tool capabilities to LLM agents. Defines a
transport-agnostic JSON-RPC protocol for tool discovery and invocation.

**MCP Client**
The SIDJUA component (`src/core/mcp/mcp-client.ts`) that manages the
connection to a single MCP server process, handles transport (STDIO or SSE),
and dispatches JSON-RPC calls.

**MCP Registry**
The central index (`src/core/mcp/mcp-registry.ts`) that loads all MCP server
configurations, starts each client, and provides tool lookup by name.

**MCP Server**
An external process that implements the MCP protocol and exposes a set of
tools. Examples: filesystem server, GitHub server, Grafana server.

**Module**
An MCP server packaged with a `module.yaml` governance manifest for use with
the SIDJUA Module SDK. Installable via `sidjua module add`.

**Module SDK**
The SIDJUA tooling (`src/core/modules/`) for creating, installing, and
managing modules. Provides scaffolding, lifecycle management, and automatic
governance registration.

## O

**Orchestrator**
The core component (`src/core/orchestrator.ts`) that receives task creation
events, selects the appropriate agent, manages the task lifecycle, and
coordinates synthesis of multi-agent results.

## R

**RBAC (Role-Based Access Control)**
Access control based on an agent's tier and division. Enforced at Stage 1 of
the governance pipeline for every tool call, and by `requireScope()` middleware
for every REST API endpoint.

**Reasoning Loop**
The iterative LLM ↔ tool-call cycle within an agent. Each turn: send message +
tools to LLM → receive tool-use or text response → if tool-use, check
governance, call MCP, append result → repeat until text response.

**RRF (Reciprocal Rank Fusion)**
The scoring formula used to merge BM25 and vector search results in the memory
retrieval pipeline: `score = 1 / (60 + rank + 1)`.

## S

**Scope**
An API token permission level. REST endpoints are protected by `requireScope()`
middleware. Scopes: `readonly`, `operator`, `admin`, `bootstrap`.

**Skill**
A Markdown file in `agents/skills/` that contributes to an agent's system
prompt. An agent can have multiple skill files that are concatenated at runtime.

**SSE Transport**
Server-Sent Events — a long-lived HTTP connection used to communicate with
remote MCP servers. The alternative to STDIO for cloud-hosted tool providers.

**STDIO Transport**
A local process communication channel. The MCP client spawns the server
process and communicates via stdin/stdout JSON-RPC. The primary transport for
locally installed MCP servers.

## T

**T1 / T2 / T3**
The three agent tiers. T1 = Executive (CEO-level, orchestration), T2 = Manager
(domain-specific, can delegate to T3), T3 = Worker (task execution only, cannot
delegate).

**Tier**
A numeric rank (1, 2, or 3) indicating an agent's authority level in the
delegation hierarchy. Controls which tools and delegation targets are accessible.

**Tool**
A callable capability exposed by an MCP server. Each tool has a name, input
schema (JSON Schema), and description. Tools are invoked by agents via the MCP
client after governance approval.

**Tool Call**
A request from an agent (via the LLM) to execute a specific tool with given
arguments. Every tool call passes through the 6-stage governance pipeline.

**Tool Result**
The structured output returned by a tool server after executing a tool call.
Appended to the conversation history and passed back to the LLM.

## W

**WAL (Write-Ahead Log)**
A durability mechanism used in both SQLite (for database safety) and the memory
pipeline (for tracking embed operations). The memory WAL (`memory-wal.ts`)
enables recovery of failed chunk embeddings after a crash.
