// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — init workspace scaffold
 *
 * Extracted from init.ts: directory creation, config file generation,
 * database initialization, documentation bundling.
 */

import { mkdir, writeFile, access, readdir, readFile, copyFile } from "node:fs/promises";
import { existsSync }                                             from "node:fs";
import { join, resolve }                                         from "node:path";
import { randomUUID }                                            from "node:crypto";
import { saveTelemetryConfig }                                   from "../../core/telemetry/telemetry-reporter.js";
import { DEFAULT_PRIMARY_ENDPOINT, DEFAULT_FALLBACK_ENDPOINT }   from "../../core/telemetry/telemetry-types.js";
import { openDatabase }                                          from "../../utils/db.js";
import { runMigrations105 }                                      from "../../agent-lifecycle/migration.js";
import { AgentRegistry }                                         from "../../agent-lifecycle/agent-registry.js";
import { createLogger }                                          from "../../core/logger.js";
import { SIDJUA_VERSION }                                        from "../../version.js";
import { getDefaultDivisionsDir }                                from "../../defaults/loader.js";
import {
  CEO_ASSISTANT_AGENT_DEFINITION,
  GUIDE_AGENT_DEFINITION,
  AGENTS_YAML,
  CEO_ASSISTANT_DEFINITION_YAML,
  CEO_ASSISTANT_SKILL_MD,
  GUIDE_DEFINITION_YAML,
  GUIDE_SKILL_MD,
  AGENT_TEMPLATES,
} from "./init-agents.js";

const logger = createLogger("init");


const ORCHESTRATOR_YAML = `# SIDJUA Orchestrator Configuration
max_agents: 10
event_poll_interval_ms: 500
delegation_timeout_ms: 120000
synthesis_timeout_ms: 60000
max_tree_depth: 5
max_tree_breadth: 10
default_division: default
governance_root: governance
api_port: 3000
`;

const CHARTER_MD = `# Workspace Charter — Your AI Team, Your Rules

## Principles

1. **Transparency**: Every AI action is logged and auditable.
2. **Control**: You approve what matters; routine work runs automatically.
3. **Boundaries**: Agents operate within defined limits — no surprises.
4. **Privacy**: Your data stays local. Nothing leaves without your knowledge.

## Your Team

- **Guide** — Your first AI agent. Free, always on, teaches you everything.
- Add more agents with \`sidjua chat guide\` or \`sidjua agent create\`.

## Rules

Agents in this workspace:
- MAY: read files, write to their designated output directories
- MAY: call APIs with configured keys within budget limits
- MAY NOT: delete files without explicit approval
- MAY NOT: communicate externally beyond configured integrations
- MUST: log all significant actions to the audit trail
- MUST: stop and escalate when cost limits are approached

## Getting Started

Run \`sidjua chat guide\` to meet your Guide and get started.
`;

const DEFAULTS_YAML = `# Default Governance Boundaries
# These apply to all agents unless overridden by division-specific rules.

boundaries:
  file_operations:
    read:   allow
    write:  allow_designated_dirs
    delete: require_approval

  network:
    external_calls:   allow_configured_providers
    data_exfiltration: deny

  cost:
    hard_stop_at_budget: true
    alert_at_percent: 80

  actions:
    require_approval_for: []
    auto_approve: [read, write, api_call]
    always_block: [system_commands, fork_processes]
`;

const CLOUDFLARE_PROVIDER_YAML = `# Cloudflare Workers AI — Built-in, no key needed
provider: cloudflare
enabled: true
embedded: true
# The Guide agent uses this automatically.
# To use your own Cloudflare account:
#   api_key: your-cloudflare-token
#   account_id: your-account-id
`;

const GROQ_PROVIDER_YAML = `# Groq — Free tier, fast, recommended for getting started
# Get your free API key at: https://console.groq.com
provider: groq
enabled: false
requires_key: true
# api_key: YOUR_GROQ_API_KEY
# Or add it interactively: sidjua chat guide → /key groq <your-key>
`;

const GOOGLE_PROVIDER_YAML = `# Google AI Studio (Gemini) — Free tier with 1M context window
# Get your free API key at: https://aistudio.google.com/apikey
provider: google
enabled: false
requires_key: true
# api_key: YOUR_GOOGLE_AI_API_KEY
# Or add it interactively: sidjua chat guide → /key google <your-key>
`;


const CONCEPTS_MD_FALLBACK = `# SIDJUA Concepts

SIDJUA is an AI agent governance platform that lets you provision and manage
AI agents from a single configuration file.

## Key Concepts

- **Divisions**: Organizational units (like departments) that group agents
- **Agents**: AI workers with defined roles, capabilities, and budgets
- **Governance Pipeline**: Every agent action is checked before execution
- **Skills**: Natural language instructions that define agent behavior

## Getting Started

Run \`sidjua chat guide\` to learn more from your Guide agent.
`;

const CLI_REFERENCE_FALLBACK = `# CLI Reference

## Core Commands

\`\`\`
sidjua init                    Initialize workspace
sidjua chat guide              Talk to your Guide agent
sidjua apply                   Provision from divisions.yaml
sidjua status                  Show workspace status
sidjua agent create            Create a new agent
sidjua agent list              List all agents
sidjua run <task>              Submit a task
sidjua costs                   Show cost summary
\`\`\`

Run \`sidjua --help\` for the full command list.
`;

const QUICK_START_FALLBACK = `# Quick Start

## Step 1: Initialize

\`\`\`bash
mkdir my-workspace && cd my-workspace
sidjua init
\`\`\`

## Step 2: Talk to the Guide

\`\`\`bash
sidjua chat guide
\`\`\`

## Step 3: Add a Free API Key

Inside the Guide chat:
\`\`\`
/key groq gsk_your-groq-api-key
\`\`\`

## Step 4: Create Your First Agent

Ask the Guide:
> "Create a researcher agent that can summarize web content"

## Step 5: Run a Task

\`\`\`bash
sidjua run "Summarize the SIDJUA README" --agent my-researcher --wait
\`\`\`
`;

const TROUBLESHOOTING_MD = `# Troubleshooting

## Guide chat shows "offline mode"

The embedded Cloudflare credentials aren't configured for this build.
Add your own Cloudflare Workers AI credentials:
\`\`\`bash
export SIDJUA_CF_ACCOUNT_ID=your-account-id
export SIDJUA_CF_TOKEN=your-api-token
sidjua chat guide
\`\`\`

Or use another provider: \`/key groq <your-groq-key>\`

## "Workspace not initialized"

Run \`sidjua init\` first.

## Provider key not working

1. Check the key is correct and not expired
2. Verify the provider name matches: groq, google, anthropic, openai
3. Test with: \`sidjua setup --validate\`

## Budget errors

Your configured budget limit was reached. Either:
- Increase the limit: edit \`.system/providers/<provider>.yaml\`
- Wait for the period to reset
- Use a free provider: \`/key groq <key>\`

## "sidjua.db: unable to open"

Ensure the \`.system/\` directory exists and is writable:
\`\`\`bash
mkdir -p .system
sidjua init --force
\`\`\`
`;

const AGENT_TEMPLATES_MD = `# Agent Templates

## Worker (T3)

General-purpose task executor. High volume, low cost.
\`\`\`yaml
tier: 3
capabilities: [text-processing, data-analysis, file-operations]
budget: { per_task_usd: 0.05, per_month_usd: 2.00 }
\`\`\`

## Researcher (T3)

Focused on information gathering and synthesis.
\`\`\`yaml
tier: 3
capabilities: [research, synthesis, summarization]
budget: { per_task_usd: 0.10, per_month_usd: 3.00 }
\`\`\`

## Developer (T3)

Code review, implementation, and testing.
\`\`\`yaml
tier: 3
capabilities: [code-review, implementation, testing, debugging]
budget: { per_task_usd: 0.20, per_month_usd: 5.00 }
\`\`\`

## Manager (T2)

Delegates to T3 agents, reviews results.
\`\`\`yaml
tier: 2
capabilities: [delegation, planning, review]
budget: { per_task_usd: 0.50, per_month_usd: 10.00 }
\`\`\`

## To use a template

\`\`\`bash
sidjua agent create --template worker --id my-worker --name "My Worker"
\`\`\`
`;

const GOVERNANCE_EXAMPLES_MD = `# Governance Examples

## Budget Limits

In \`divisions.yaml\`:
\`\`\`yaml
divisions:
  - code: engineering
    budget:
      monthly_limit_usd: 50.00
      per_agent_limit_usd: 10.00
      alert_threshold_percent: 80
\`\`\`

## Action Boundaries

In \`governance/boundaries/defaults.yaml\`:
\`\`\`yaml
boundaries:
  file_operations:
    delete: require_approval  # Always prompt before deletion
  actions:
    auto_approve: [read, write, api_call]
    always_block: [system_commands]
\`\`\`

## Approval Requirements

Require human approval for expensive operations:
\`\`\`yaml
approval_rules:
  - condition: cost_usd > 1.00
    require: human
  - condition: action_type = delete
    require: human
\`\`\`

## Audit Trail

All agent actions are logged. Query with:
\`\`\`bash
sidjua audit --agent my-researcher --since 24h
\`\`\`
`;


export async function createWorkspace(workDir: string, quiet: boolean): Promise<void> {
  const log = (msg: string): void => {
    if (!quiet) process.stdout.write(`  ${msg}\n`);
  };

  // ── Directories ────────────────────────────────────────────────────────────

  const dirs = [
    ".system/providers",
    "agents/definitions",
    "agents/skills",
    "agents/templates",
    "governance/boundaries",
    "docs",
    "modules",
  ];

  for (const d of dirs) {
    await mkdir(join(workDir, d), { recursive: true });
  }
  log("✓ Directories created");

  // ── governance/divisions/ — per-division YAML files copied from package defaults ──

  const govDivisionsDir    = join(workDir, "governance", "divisions");
  const pkgDivisionsDir    = getDefaultDivisionsDir();
  await mkdir(govDivisionsDir, { recursive: true });
  const divFiles = (await readdir(pkgDivisionsDir)).filter((f) => f.endsWith(".yaml"));
  for (const f of divFiles) {
    const content = await readFile(join(pkgDivisionsDir, f), "utf-8");
    await writeIfAbsent(join(govDivisionsDir, f), content, quiet);
  }
  log(`✓ governance/divisions/ (${divFiles.length} divisions)`);

  // ── governance/ ────────────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, "governance", "CHARTER.md"), CHARTER_MD, quiet);
  await writeIfAbsent(join(workDir, "governance", "boundaries", "defaults.yaml"), DEFAULTS_YAML, quiet);
  await writeIfAbsent(join(workDir, "governance", "orchestrator.yaml"), ORCHESTRATOR_YAML, quiet);
  log("✓ governance/");
  log("✓ governance/orchestrator.yaml");

  // ── agents/ ────────────────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, "agents", "agents.yaml"), AGENTS_YAML, quiet);
  // CEO Assistant (primary default agent — replaces Guide)
  await writeIfAbsent(join(workDir, "agents", "definitions", "ceo-assistant.yaml"), CEO_ASSISTANT_DEFINITION_YAML, quiet);
  await writeIfAbsent(join(workDir, "agents", "skills", "ceo-assistant.md"), CEO_ASSISTANT_SKILL_MD, quiet);
  // Guide (backward compat — still supported with `sidjua chat guide`)
  await writeIfAbsent(join(workDir, "agents", "definitions", "guide.yaml"), GUIDE_DEFINITION_YAML, quiet);
  await writeIfAbsent(join(workDir, "agents", "skills", "guide.md"), GUIDE_SKILL_MD, quiet);

  // Templates
  for (const [name, content] of Object.entries(AGENT_TEMPLATES)) {
    await writeIfAbsent(join(workDir, "agents", "templates", `${name}.yaml`), content, quiet);
  }
  log("✓ agents/ (Guide pre-installed)");

  // ── docs/ ─────────────────────────────────────────────────────────────────

  await bundleDocs(workDir, quiet);
  log("✓ docs/");

  // ── .system/providers/ ────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, ".system", "providers", "cloudflare.yaml"), CLOUDFLARE_PROVIDER_YAML, quiet);
  await writeIfAbsent(join(workDir, ".system", "providers", "groq.yaml"),       GROQ_PROVIDER_YAML, quiet);
  await writeIfAbsent(join(workDir, ".system", "providers", "google.yaml"),     GOOGLE_PROVIDER_YAML, quiet);
  log("✓ .system/providers/");

  // ── config/feature-flags.json ────────────────────────────────────────────
  // P388: Copy default feature flags into workspace so operators can customise them.

  const featureFlagsDir = join(workDir, "config");
  await mkdir(featureFlagsDir, { recursive: true });
  const destFlagsPath = join(featureFlagsDir, "feature-flags.json");
  if (!existsSync(destFlagsPath)) {
    // Try to copy from package installation; fall back to writing built-in defaults
    const { fileURLToPath } = await import("node:url");
    const pkgFlagsPath = join(
      resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "config"),
      "feature-flags.json",
    );
    try {
      await copyFile(pkgFlagsPath, destFlagsPath);
    } catch (_e) {
      // Package copy failed — write built-in defaults
      await writeFile(destFlagsPath, JSON.stringify({
        memory_consolidation_enabled:          false,
        governance_notifications_enabled:      true,
        advanced_cost_tracking_enabled:        false,
        delegation_chain_limits_enabled:       true,
        experimental_reasoning_loop_enabled:   false,
        multi_provider_failover_enabled:       false,
        task_deduplication_enabled:            true,
        audit_verbose_mode_enabled:            false,
      }, null, 2), "utf-8");
    }
    log("✓ config/feature-flags.json");
  }

  // ── Database ───────────────────────────────────────────────────────────────

  const db = openDatabase(join(workDir, ".system", "sidjua.db"));
  db.pragma("foreign_keys = ON");
  runMigrations105(db);

  // Register CEO Assistant (primary) and Guide (backward compat)
  const registry = new AgentRegistry(db);
  try {
    const existing = registry.getById("ceo-assistant");
    if (!existing) {
      registry.create(CEO_ASSISTANT_AGENT_DEFINITION, "init");
    }
  } catch (e: unknown) {
    logger.warn("init", "CEO Assistant registration failed — will load from YAML on next start", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }
  // Also keep guide registered for backward compat (sidjua chat guide still works)
  try {
    const existingGuide = registry.getById("guide");
    if (!existingGuide) {
      registry.create(GUIDE_AGENT_DEFINITION, "init");
    }
  } catch (e: unknown) {
    logger.warn("init", "Guide agent registration failed — will load from YAML on next start", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  db.close();
  log("✓ Database initialized");

  // ── config.json ───────────────────────────────────────────────────────────

  const configJson = JSON.stringify(
    { workDir, version: SIDJUA_VERSION, initialized_at: new Date().toISOString() },
    null,
    2,
  );
  await writeFile(join(workDir, ".system", "config.json"), configJson, "utf-8");

  // Also write to SIDJUA_CONFIG_DIR if set (Docker / multi-volume deployments)
  const configDir = process.env["SIDJUA_CONFIG_DIR"];
  if (configDir) {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), configJson, "utf-8");
  }

  log("✓ config.json written");

  // ── Telemetry — generate installation ID on first init ───────────────────

  try {
    const telPath = join(workDir, ".system", "telemetry.json");
    if (!existsSync(telPath)) {
      await saveTelemetryConfig(workDir, {
        mode:             "ask",
        primaryEndpoint:  DEFAULT_PRIMARY_ENDPOINT,
        fallbackEndpoint: DEFAULT_FALLBACK_ENDPOINT,
        installationId:   randomUUID(),
      });
      log("✓ telemetry.json written (mode: ask — run `sidjua telemetry enable` to opt in)");
    }
  } catch (e: unknown) {
    logger.warn("init", "Telemetry config write failed — non-fatal", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  // ── Lifecycle foundation files  ───────────────────────────────

  await provisionLifecycleFiles(workDir, quiet);
}


export async function provisionLifecycleFiles(workDir: string, quiet: boolean): Promise<void> {
  const log = (s: string): void => { if (!quiet) process.stdout.write(s + "\n"); };

  // config/update.yaml — update provider settings
  await mkdir(join(workDir, "config"), { recursive: true });
  await writeIfAbsent(join(workDir, "config", "update.yaml"),
    "update:\n  provider: npm\n  check_interval_hours: 24\n  auto_check: true\n",
    quiet,
  );

  // backups/retention.json — backup retention policy
  await mkdir(join(workDir, "backups"), { recursive: true });
  await writeIfAbsent(
    join(workDir, "backups", "retention.json"),
    JSON.stringify({ max_backups: 5, max_age_days: 90, min_keep: 2, auto_cleanup: true }, null, 2) + "\n",
    quiet,
  );

  // .migration-state.json — tracks applied agent DB migrations
  await writeIfAbsent(
    join(workDir, ".migration-state.json"),
    JSON.stringify({ schemaVersion: 0, appliedMigrations: [] }, null, 2) + "\n",
    quiet,
  );

  // config/mcp-servers.yaml — MCP server registry (blank template)
  const mcpDefaultSrc = resolve(new URL(".", import.meta.url).pathname, "../../../config/mcp-servers.yaml.default");
  let mcpDefaultContent = "# SIDJUA MCP Servers — edit to add MCP servers\nservers: {}\n";
  try {
    const { readFileSync } = await import("node:fs");
    mcpDefaultContent = readFileSync(mcpDefaultSrc, "utf-8");
  } catch (_e) { /* fallback to inline default */ }
  await writeIfAbsent(join(workDir, "config", "mcp-servers.yaml"), mcpDefaultContent, quiet);

  log("✓ Lifecycle foundation files written (config/update.yaml, config/mcp-servers.yaml, backups/retention.json, .migration-state.json)");
}


export async function writeIfAbsent(filePath: string, content: string, quiet: boolean): Promise<void> {
  try {
    await access(filePath);
    // File exists — skip (preserves user edits)
  } catch (e: unknown) { // cleanup-ignore: access() throws ENOENT when file is absent — that is the expected trigger for writing the file
    void e; // cleanup-ignore
    await writeFile(filePath, content, "utf-8");
  }
  void quiet;
}


export async function bundleDocs(workDir: string, quiet: boolean): Promise<void> {
  const srcDocsDir = resolve(new URL(".", import.meta.url).pathname, "../../../docs");
  const destDocsDir = join(workDir, "docs");

  const docFiles: Array<{ src: string; dest: string; fallback: string }> = [
    { src: "SIDJUA-CONCEPTS.md",    dest: "SIDJUA-CONCEPTS.md",    fallback: CONCEPTS_MD_FALLBACK },
    { src: "CLI-REFERENCE.md",      dest: "CLI-REFERENCE.md",      fallback: CLI_REFERENCE_FALLBACK },
    { src: "QUICK-START.md",        dest: "QUICK-START.md",        fallback: QUICK_START_FALLBACK },
    { src: "TROUBLESHOOTING.md",    dest: "TROUBLESHOOTING.md",    fallback: TROUBLESHOOTING_MD },
    { src: "AGENT-TEMPLATES.md",    dest: "AGENT-TEMPLATES.md",    fallback: AGENT_TEMPLATES_MD },
    { src: "GOVERNANCE-EXAMPLES.md",dest: "GOVERNANCE-EXAMPLES.md",fallback: GOVERNANCE_EXAMPLES_MD },
  ];

  for (const doc of docFiles) {
    const destPath = join(destDocsDir, doc.dest);
    try {
      await access(destPath);
      // Already exists — skip
      continue;
    } catch (e: unknown) { // cleanup-ignore: access() throws ENOENT when file is absent — we then proceed to create it
      void e; // cleanup-ignore
    }

    const srcPath = join(srcDocsDir, doc.src);
    try {
      await copyFile(srcPath, destPath);
    } catch (e: unknown) {
      logger.debug("init", "Source doc not bundled — writing embedded fallback", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      // Source doc not available — write fallback
      await writeFile(destPath, doc.fallback, "utf-8");
    }
  }

  void quiet;
}
