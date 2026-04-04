#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * Reads docs/.build/deps.json and generates Mermaid diagram blocks.
 * Inserts/updates diagrams between AUTO-GENERATED-DIAGRAM markers in dev docs.
 * If a target file is missing or has no markers, that file is skipped.
 */

import * as fs   from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const buildDir = path.join(repoRoot, "docs", ".build");

// Load deps (non-fatal if missing)
let deps: unknown = { modules: [] };
try {
  const raw = fs.readFileSync(path.join(buildDir, "deps.json"), "utf-8");
  deps = JSON.parse(raw) as unknown;
} catch (_err: unknown) {
  console.warn("deps.json not found — using empty dependency data");
}

// ─── Diagram generators ───────────────────────────────────────────────────────

export function generateC4Level2(): string {
  return `\`\`\`mermaid
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
\`\`\``;
}

export function generateGovernanceDiagram(): string {
  return `\`\`\`mermaid
flowchart TD
  A[Tool Call Request] --> B{Stage 1: RBAC}
  B -->|Pass| C{Stage 2: Budget}
  B -->|Fail| X[BLOCKED: division/tier not allowed]
  C -->|Pass| D{Stage 3: Forbidden Actions}
  C -->|Fail| X2[BLOCKED: budget exceeded]
  D -->|Pass| E{Stage 4: Classification}
  D -->|Fail| X3[BLOCKED: action forbidden]
  E -->|Pass| F{Stage 5: Escalation}
  E -->|Fail| X4[BLOCKED: classification ceiling]
  F -->|Pass| G{Stage 6: Rate Limit}
  F -->|Escalate| X5[PENDING: human approval required]
  G -->|Pass| H[EXECUTE via MCP]
  G -->|Fail| X6[BLOCKED: rate limit exceeded]
  H --> I[Result to LLM]
\`\`\``;
}

export function generateAgentDelegationDiagram(): string {
  return `\`\`\`mermaid
flowchart TD
  CEO[CEO-Assistant T1] -->|delegate| HR[HR-Manager T2]
  CEO -->|delegate| IT[IT-Manager T2]
  HR -->|delegate| W1[Worker T3]
  IT -->|delegate| W2[Worker T3]
  CEO -.->|direct| MCP1[Grafana MCP]
  CEO -.->|direct| MCP2[Puppeteer MCP]
  HR -.->|direct| MCP3[Filesystem MCP]
  IT -.->|direct| MCP4[Grafana MCP]
\`\`\``;
}

// ─── Marker-based file update ─────────────────────────────────────────────────

const START_MARKER = "<!-- AUTO-GENERATED-DIAGRAM-START -->";
const END_MARKER   = "<!-- AUTO-GENERATED-DIAGRAM-END -->";

export function updateFileWithDiagram(filePath: string, diagram: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (_err: unknown) {
    return false;
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx   = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return false;

  const before = content.slice(0, startIdx + START_MARKER.length);
  const after  = content.slice(endIdx);
  const updated = `${before}\n${diagram}\n${after}`;

  fs.writeFileSync(filePath, updated, "utf-8");
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Suppress unused-variable warning on deps (used implicitly — could extend to
// derive module relationships from the dependency graph in future iterations)
void deps;

const devDir = path.join(repoRoot, "docs", "dev");

const updates: Array<{ file: string; diagram: string }> = [
  { file: "ARCHITECTURE.md",       diagram: generateC4Level2() },
  { file: "GOVERNANCE-PIPELINE.md", diagram: generateGovernanceDiagram() },
  { file: "AGENT-SYSTEM.md",       diagram: generateAgentDelegationDiagram() },
];

for (const { file, diagram } of updates) {
  const filePath = path.join(devDir, file);
  const updated  = updateFileWithDiagram(filePath, diagram);
  console.log(`${file}: ${updated ? "UPDATED" : "SKIPPED (no markers or file missing)"}`);
}
