// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5: AgentTemplate
 *
 * Template expansion from /sidjua/agents/templates/.
 * 9 built-in templates + user-defined custom templates.
 * Templates are YAML files with defaults for new agent definitions.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { SidjuaError } from "../core/error-codes.js";
import { assertWithinDirectory } from "../utils/path-utils.js";
import type { AgentTemplate, AgentLifecycleDefinition } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("agent-template");


/**
 * Resolve a user-supplied skill path relative to workDir and verify that the
 * result stays inside workDir (no `..` traversal, no absolute paths, no symlinks
 * pointing outside).
 *
 * @param workDir    Absolute base directory the path must stay within
 * @param skillPath  User-supplied path, e.g. "skills/my-skill.md"
 * @returns          Absolute resolved path (guaranteed inside workDir)
 * @throws           SidjuaError SEC-010 if the path escapes workDir
 */
export function resolveSkillPath(workDir: string, skillPath: string): string {
  // Reject paths containing null bytes — they confuse OS path functions
  // and indicate a crafted input that should never reach the filesystem.
  if (skillPath.includes("\0")) {
    throw SidjuaError.from(
      "SEC-010",
      `Skill path contains null byte — invalid input`,
    );
  }

  // Reject absolute paths immediately — they bypass workDir entirely
  if (isAbsolute(skillPath)) {
    throw SidjuaError.from(
      "SEC-010",
      `Skill path "${skillPath}" must be relative, not absolute`,
    );
  }

  // Resolve against workDir and validate containment using the shared utility.
  // path.resolve() normalizes ".." components before the check, eliminating the
  // TOCTOU gap that exists when validating raw string patterns.
  const resolved = resolve(workDir, skillPath);
  assertWithinDirectory(resolved, workDir);

  // Resolve symlinks and re-validate containment.
  // A symlink inside workDir can point outside — reject if so.
  // ENOENT is acceptable: the skill file may not exist yet (new agent creation).
  try {
    const realResolved = realpathSync(resolved);
    const realWorkDir  = realpathSync(workDir);
    const realRel      = relative(realWorkDir, realResolved);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      throw SidjuaError.from(
        "SEC-010",
        `Skill path "${skillPath}" resolves via symlink outside work directory`,
      );
    }
    return realResolved;
  } catch (e: unknown) {
    // On ENOENT, return the already-validated `resolved` path — NOT the
    // raw `skillPath` string (which may contain un-normalized ".." sequences that
    // resolve() has already sanitized).  `resolved` is guaranteed within workDir
    // by the assertWithinDirectory() call above.
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // Reject if resolved path itself is a symlink — even with non-existent target.
      // A symlink could later be re-pointed outside the workspace (TOCTOU).
      try {
        const st = lstatSync(resolved);
        if (st.isSymbolicLink()) {
          throw SidjuaError.from(
            "SEC-010",
            `Skill path "${skillPath}" is a dangling symlink — rejected`,
          );
        }
      } catch (lstatErr: unknown) {
        // Re-throw our own SEC-010 (dangling symlink) without wrapping
        if (lstatErr instanceof SidjuaError) throw lstatErr;
        if (!(lstatErr instanceof Error && "code" in lstatErr && (lstatErr as NodeJS.ErrnoException).code === "ENOENT")) {
          throw SidjuaError.from("SEC-010", `Skill path stat failed: ${String(lstatErr)}`);
        }
      }
      return resolved;
    }
    // Re-throw SEC-010 (symlink escape detected above)
    if (e instanceof SidjuaError) throw e;
    // Unexpected OS error — surface as SEC-010 to be safe
    throw SidjuaError.from("SEC-010", `Skill path resolution failed: ${String(e)}`);
  }
}


const BUILTIN_TEMPLATES: AgentTemplate[] = [
  {
    id: "strategic-lead",
    name: "Strategic Lead",
    description: "CEO/CTO level strategic agent",
    tier: 1,
    defaults: {
      tier: 1,
      max_concurrent_tasks: 3,
      checkpoint_interval_seconds: 60,
      ttl_default_seconds: 7200,
      heartbeat_interval_seconds: 30,
      max_classification: "TOP-SECRET",
      capabilities: ["strategic-planning", "delegation", "review", "escalation"],
      budget: { per_task_usd: 20.00, per_hour_usd: 50.00, per_month_usd: 1000.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a strategic leader working for {organization}.
Your role is to set direction, delegate to your team, and ensure quality outcomes.

## Work Style
- Think strategically before acting tactically
- Delegate execution to appropriate T2/T3 agents
- Review synthesis results critically

## Decision Authority
- You MAY: set priorities, approve large expenditures, make architectural decisions
- You MAY NOT: perform routine work directly — always delegate
- ESCALATE: major policy violations, budget overruns, critical system failures

## Quality Standards
- All decisions must be documented with rationale
- Risk assessment required for decisions over $1,000
- Weekly summaries to human operator

## Supervision Expectations
When completing strategic tasks:
1. Write result to result file with decision rationale
2. Management summary: scope, decisions made, delegation outcomes, cost
`,
  },
  {
    id: "department-head",
    name: "Department Head",
    description: "Division manager, delegates to T3",
    tier: 2,
    defaults: {
      tier: 2,
      max_concurrent_tasks: 5,
      checkpoint_interval_seconds: 60,
      ttl_default_seconds: 3600,
      heartbeat_interval_seconds: 30,
      max_classification: "CONFIDENTIAL",
      capabilities: ["delegation", "review", "planning"],
      budget: { per_task_usd: 8.00, per_hour_usd: 15.00, per_month_usd: 400.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are the department head working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Translate strategic objectives into actionable tasks
- Delegate execution to T3 workers
- Review outputs before forwarding to T1

## Decision Authority
- You MAY: assign tasks, approve routine expenditures, resolve T3 blockers
- You MAY NOT: override T1 strategic decisions, approve large budgets
- ESCALATE: blocking technical issues, resource conflicts, quality failures

## Quality Standards
- All delegated tasks must have clear acceptance criteria
- Review T3 output before marking complete

## Supervision Expectations
1. Write result to result file: tasks delegated, outcomes, issues encountered
2. Management summary: scope, completion rate, cost, confidence score
`,
  },
  {
    id: "code-worker",
    name: "Code Worker",
    description: "Software development worker",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 2,
      checkpoint_interval_seconds: 30,
      ttl_default_seconds: 1800,
      heartbeat_interval_seconds: 15,
      max_classification: "CONFIDENTIAL",
      capabilities: ["coding", "testing", "code-review", "debugging"],
      budget: { per_task_usd: 3.00, per_hour_usd: 5.00, per_month_usd: 150.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a software developer working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Read existing code before making changes
- Write tests before or alongside implementation
- Document your changes clearly

## Decision Authority
- You MAY: write code, run tests, read files, make small refactors
- You MAY NOT: delete production data, push to main branch, deploy
- ESCALATE: architecture questions, security concerns, design decisions

## Quality Standards
- All code must pass existing tests
- New features require unit tests
- No hardcoded secrets or credentials

## Supervision Expectations
1. Write result to result file: files changed, tests run, summary of changes
2. Management summary: task completed, files modified, test results, confidence score
`,
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Web research and analysis",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 2,
      capabilities: ["web-research", "summarization", "analysis", "fact-checking"],
      budget: { per_task_usd: 1.00, per_hour_usd: 3.00, per_month_usd: 80.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a research specialist working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Verify claims against multiple sources
- Note uncertainty and confidence levels
- Cite all sources

## Decision Authority
- You MAY: search web, read documents, compile reports
- You MAY NOT: act on information — research only
- ESCALATE: contradictory sources, sensitive information, unclear scope

## Quality Standards
- Every claim must have a source
- Distinguish verified facts from estimates
- Flag outdated information (>1 year)

## Supervision Expectations
1. Write result to result file: findings with sources, confidence levels
2. Management summary: research questions answered, key findings, caveats
`,
  },
  {
    id: "writer",
    name: "Writer",
    description: "Content writing and editing",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 2,
      capabilities: ["writing", "editing", "proofreading", "content-strategy"],
      budget: { per_task_usd: 2.00, per_hour_usd: 4.00, per_month_usd: 100.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a content writer working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Follow brand voice guidelines
- Research before writing
- Edit ruthlessly for clarity

## Decision Authority
- You MAY: write, edit, restructure content
- You MAY NOT: publish without approval, claim facts without sources
- ESCALATE: sensitive topics, legal concerns, brand voice questions

## Quality Standards
- Match target audience reading level
- Check facts before including
- Proofread before submitting

## Supervision Expectations
1. Write result to result file: completed content, word count, notes
2. Management summary: content produced, key messaging, revision notes
`,
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Data processing and visualization",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 2,
      capabilities: ["data-analysis", "visualization", "statistics", "reporting"],
      budget: { per_task_usd: 2.00, per_hour_usd: 4.00, per_month_usd: 100.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a data analyst working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Validate data quality before analysis
- Document methodology
- Present findings with appropriate uncertainty

## Decision Authority
- You MAY: query data, generate visualizations, write reports
- You MAY NOT: modify source data without approval
- ESCALATE: data quality issues, inconsistent results, out-of-scope queries

## Quality Standards
- State sample sizes and confidence intervals
- Flag outliers and anomalies
- Verify calculations independently

## Supervision Expectations
1. Write result to result file: analysis, charts, methodology
2. Management summary: key findings, data quality notes, recommendations
`,
  },
  {
    id: "customer-support",
    name: "Customer Support",
    description: "Ticket handling and responses",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 5,
      capabilities: ["customer-support", "ticket-handling", "response-drafting"],
      budget: { per_task_usd: 0.50, per_hour_usd: 2.00, per_month_usd: 50.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a customer support agent working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Acknowledge the customer's concern first
- Provide accurate information from knowledge base
- Escalate when uncertain

## Decision Authority
- You MAY: respond to inquiries, provide information, draft responses
- You MAY NOT: make promises, issue refunds, reveal internal info
- ESCALATE: complaints, billing issues, policy questions, angry customers

## Quality Standards
- Respond within tone guidelines
- Accuracy over speed
- Always end with next steps

## Supervision Expectations
1. Write result to result file: draft response, confidence, references used
2. Management summary: ticket category, resolution approach, confidence score
`,
  },
  {
    id: "video-editor",
    name: "Video Editor",
    description: "Video editing with tool integration",
    tier: 3,
    defaults: {
      tier: 3,
      max_concurrent_tasks: 1,
      checkpoint_interval_seconds: 30,
      ttl_default_seconds: 7200,
      capabilities: ["video-editing", "color-grading", "audio-sync", "export-rendering"],
      budget: { per_task_usd: 5.00, per_hour_usd: 10.00, per_month_usd: 200.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a professional video editor working for {organization}.
Your supervisor is {reports_to}.

## Work Style
- Review all raw footage before starting edits
- Create rough cut first, then refine
- Document every editing decision

## Decision Authority
- You MAY: trim clips, adjust color, sync audio, add transitions
- You MAY NOT: delete original footage, publish without approval
- ESCALATE: style changes not in brand guide, footage quality issues

## Quality Standards
- Output resolution: match source unless specified
- Audio: normalize to -14 LUFS for YouTube
- Export format: H.264 MP4 unless specified

## Supervision Expectations
1. Write result to result file: timeline decisions, effects, export settings
2. Management summary: duration, key changes, preview link, confidence score
`,
  },
  {
    id: "custom",
    name: "Custom",
    description: "Blank template — fill in everything",
    tier: 3,
    defaults: {
      tier: 3,
      capabilities: [],
      budget: { per_task_usd: 2.00, per_hour_usd: 5.00, per_month_usd: 100.00 },
    },
    skill_template: `# {agent_name} — Agent Skill Definition

## Identity
You are a specialist working for {organization}.
Your supervisor is {reports_to}.

## Work Style
<!-- Describe how this agent approaches work -->

## Decision Authority
- You MAY: <!-- list allowed actions -->
- You MAY NOT: <!-- list prohibited actions -->
- ESCALATE: <!-- list situations requiring escalation -->

## Quality Standards
<!-- Define what "done" means for this agent -->

## Supervision Expectations
1. Write result to result file: <!-- describe required output -->
2. Management summary: scope, outcome, confidence score
`,
  },
];


export class AgentTemplateLoader {
  constructor(
    /** Path to user-defined templates directory. */
    private readonly templatesDir?: string,
  ) {}

  /**
   * List all available templates (built-in + user-defined).
   */
  async listTemplates(): Promise<AgentTemplate[]> {
    const templates = [...BUILTIN_TEMPLATES];

    if (this.templatesDir !== undefined && existsSync(this.templatesDir)) {
      const userTemplates = await this.loadUserTemplates(this.templatesDir);
      templates.push(...userTemplates);
    }

    return templates;
  }

  /**
   * Get a specific template by ID.
   */
  async getTemplate(id: string): Promise<AgentTemplate | undefined> {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
    if (builtin !== undefined) return builtin;

    if (this.templatesDir !== undefined) {
      return this.loadUserTemplate(this.templatesDir, id);
    }

    return undefined;
  }

  /**
   * Expand a template into an AgentLifecycleDefinition.
   * Merges template defaults with user-provided overrides.
   */
  async expand(
    templateId: string,
    overrides: Partial<AgentLifecycleDefinition>,
  ): Promise<AgentLifecycleDefinition> {
    const template = await this.getTemplate(templateId);
    if (template === undefined) {
      throw new Error(
        `Template "${templateId}" not found. Run: sidjua agent templates`,
      );
    }

    const now = new Date().toISOString();

    const description = overrides.description ?? template.defaults.description;
    const maxClassification = overrides.max_classification ?? template.defaults.max_classification ?? "CONFIDENTIAL";

    const result: AgentLifecycleDefinition = {
      schema_version: "1.0",
      id: overrides.id ?? "",
      name: overrides.name ?? template.name,
      ...(description !== undefined ? { description } : {}),
      tier: overrides.tier ?? template.tier,
      division: overrides.division ?? "",
      provider: overrides.provider ?? "",
      model: overrides.model ?? "",
      skill: overrides.skill ?? `agents/skills/${overrides.id ?? "custom"}.md`,
      capabilities:
        overrides.capabilities ??
        template.defaults.capabilities ??
        [],
      budget: {
        ...template.defaults.budget,
        ...overrides.budget,
      },
      max_concurrent_tasks:
        overrides.max_concurrent_tasks ?? template.defaults.max_concurrent_tasks ?? 1,
      checkpoint_interval_seconds:
        overrides.checkpoint_interval_seconds ?? template.defaults.checkpoint_interval_seconds ?? 60,
      ttl_default_seconds:
        overrides.ttl_default_seconds ?? template.defaults.ttl_default_seconds ?? 3600,
      heartbeat_interval_seconds:
        overrides.heartbeat_interval_seconds ?? template.defaults.heartbeat_interval_seconds ?? 30,
      max_classification: maxClassification,
      created_at: overrides.created_at ?? now,
      created_by: overrides.created_by ?? "user",
      tags: overrides.tags ?? [],
      ...(overrides.reports_to !== undefined ? { reports_to: overrides.reports_to } : {}),
      ...(overrides.fallback_provider !== undefined ? { fallback_provider: overrides.fallback_provider } : {}),
      ...(overrides.fallback_model !== undefined ? { fallback_model: overrides.fallback_model } : {}),
      ...(overrides.knowledge !== undefined ? { knowledge: overrides.knowledge } : {}),
      ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
      ...(overrides.schedule !== undefined ? { schedule: overrides.schedule } : {}),
    };

    return result;
  }

  /**
   * Get the starter skill.md content for a template.
   */
  async getSkillTemplate(templateId: string): Promise<string | undefined> {
    const template = await this.getTemplate(templateId);
    return template?.skill_template;
  }

  // ---------------------------------------------------------------------------
  // User-defined template loading
  // ---------------------------------------------------------------------------

  private async loadUserTemplates(dir: string): Promise<AgentTemplate[]> {
    const templates: AgentTemplate[] = [];

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
        const id = file.replace(/\.(yaml|yml)$/, "");
        const template = await this.loadUserTemplate(dir, id);
        if (template !== undefined) templates.push(template);
      }
    } catch (e: unknown) { logger.debug("agent-template", "Template directory not readable — skipping", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }

    return templates;
  }

  private async loadUserTemplate(
    dir: string,
    id: string,
  ): Promise<AgentTemplate | undefined> {
    for (const ext of [".yaml", ".yml"]) {
      const path = join(dir, `${id}${ext}`);
      try {
        await access(path);
        const raw = await readFile(path, "utf-8");
        const data = parseYaml(raw) as Partial<AgentTemplate>;

        return {
          id,
          name: data.name ?? id,
          description: data.description ?? "User-defined template",
          tier: data.tier ?? 3,
          defaults: data.defaults ?? {},
          ...(data.skill_template !== undefined ? { skill_template: data.skill_template } : {}),
        };
      } catch (e: unknown) { logger.warn("agent-template", "Template file parse failed — trying next extension", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }
    }

    return undefined;
  }
}
