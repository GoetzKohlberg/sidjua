// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13b: PromptBuilder
 *
 * Constructs system prompts, task prompts, and tool result messages for the
 * AgentReasoningLoop. Loads skill.md files via SkillLoader and caches them.
 *
 * Separation of concerns:
 *   - SkillLoader owns file parsing and YAML validation
 *   - PromptBuilder owns composition (skill + tools + task + memory → messages)
 */

import { SkillLoader }       from "./skill-loader.js";
import type { AgentDefinition, SkillDefinition } from "./types.js";
import type { Task }          from "../tasks/types.js";
import type { LLMMessage }    from "../providers/types.js";
import type { LLMToolSchema } from "../tool-integration/tool-schema-builder.js";
import { createLogger }       from "../core/logger.js";

const logger = createLogger("reasoning-loop");


/** Minimal tool description used for injecting tool lists into system prompts. */
export interface ToolDescription {
  name:        string;
  description: string;
}


export class PromptBuilder {
  private readonly _loader      = new SkillLoader();
  private readonly _skillCache  = new Map<string, SkillDefinition>();

  // ---------------------------------------------------------------------------
  // Skill loading
  // ---------------------------------------------------------------------------

  /**
   * Eagerly load and cache a skill.md so buildSystemPrompt() can run sync.
   * Call this once before starting the reasoning loop.
   * Gracefully no-ops if the file does not exist.
   */
  async preloadSkill(skillPath: string): Promise<void> {
    if (this._skillCache.has(skillPath)) return;
    try {
      const skill = await this._loader.load(skillPath);
      this._skillCache.set(skillPath, skill);
    } catch (err) {
      logger.warn(
        "prompt_builder_skill_not_found",
        `Skill file not found or invalid: ${skillPath}`,
        { metadata: { skillPath, error: err instanceof Error ? err.message : String(err) } },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // buildSystemPrompt
  // ---------------------------------------------------------------------------

  /**
   * Build the system prompt for the agent.
   *
   * Composition order:
   *   1. Role + system prompt from skill.md (or generic fallback)
   *   2. Available decision tools list (must call one)
   *   3. Constraints from skill.md
   *   4. Governance preamble
   */
  buildSystemPrompt(agent: AgentDefinition, tools: ToolDescription[], externalTools?: LLMToolSchema[]): string {
    const skill = this._skillCache.get(agent.skill_file);
    const parts: string[] = [];

    // 1. Role + system prompt
    if (skill !== undefined && skill.system_prompt.trim().length > 0) {
      parts.push(`# Role: ${skill.role}\n\n${skill.system_prompt}`);
    } else {
      parts.push(
        `# Role\n\nYou are a Tier ${agent.tier} AI agent (`+
        `${agent.name}) operating in the **${agent.division}** division. ` +
        `Execute assigned tasks with precision and respond using the provided tools.`,
      );
    }

    // 2. Decision tools (mandatory)
    if (tools.length > 0) {
      const toolList = tools
        .map((t) => `- **${t.name}**: ${t.description}`)
        .join("\n");
      parts.push(
        `# Decision Tools\n\n` +
        `You MUST respond by calling one of the following tools. ` +
        `Do NOT reply with plain text — always call a tool.\n\n${toolList}`,
      );
    }

    // 3. Constraints from skill
    if (skill !== undefined && skill.constraints.length > 0) {
      const constraintList = skill.constraints.map((c) => `- ${c}`).join("\n");
      parts.push(`# Constraints\n\n${constraintList}`);
    }

    // 4. Governance preamble
    parts.push(
      `# Governance\n\n` +
      `- Division: **${agent.division}** | Tier: **T${agent.tier}**\n` +
      `- All actions are logged for audit purposes.\n` +
      `- Do not attempt to access resources outside your division without explicit authorization.\n` +
      `- Confidence scores must be honest — do not inflate.`,
    );

    // 5. External tool capabilities (injected from ToolSchemaBuilder)
    if (externalTools !== undefined && externalTools.length > 0) {
      const toolList = externalTools
        .map((t) => `- **${t.function.name}**: ${t.function.description}`)
        .join("\n");
      parts.push(
        `# Available Tools\n\n` +
        `You have access to the following tools. To use a tool, call the \`use_tool\` decision ` +
        `with the tool name and parameters.\n\n${toolList}`,
      );
    }

    return parts.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // buildTaskPrompt
  // ---------------------------------------------------------------------------

  /**
   * Build the initial user message describing the task to execute.
   */
  buildTaskPrompt(task: Task, memoryContext?: string): string {
    const parts: string[] = [
      `# Task: ${task.title}\n\n${task.description}`,
    ];

    // Task metadata
    const metaParts = [
      `Tier: T${task.tier}`,
      `Division: ${task.division}`,
      `Type: ${task.type}`,
    ];
    if (task.token_budget > 0) {
      metaParts.push(`Token budget: ${task.token_budget.toLocaleString()}`);
    }
    parts.push(metaParts.join(" | "));

    // Memory context (if available)
    if (memoryContext !== undefined && memoryContext.trim().length > 0) {
      parts.push(`## Relevant Memory\n\n${memoryContext}`);
    }

    // Instructions
    if (task.type === "consultation") {
      parts.push(
        `**This is a consultation request.** Answer the question thoroughly, ` +
        `then call \`execute_result\` with your expert analysis as the result.`,
      );
    } else {
      parts.push(
        `Analyze the task and call the most appropriate tool:\n` +
        `- **Simple task** you can complete now → call \`execute_result\`\n` +
        `- **Complex task** requiring sub-agents → call \`decompose_task\`\n` +
        `- **Unclear task** needing more reasoning → call \`think_more\`\n` +
        `- **Requires external tool** → call \`use_tool\`\n` +
        `- **Beyond your authority** → call \`escalate_task\``,
      );
    }

    return parts.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // buildToolResultMessage
  // ---------------------------------------------------------------------------

  /**
   * Build the user-role message that returns a tool's result to the agent.
   */
  buildToolResultMessage(toolName: string, result: unknown): LLMMessage {
    const resultStr =
      typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);

    return {
      role:    "user",
      content: (
        `**Tool \`${toolName}\` returned:**\n\`\`\`\n${resultStr}\n\`\`\`\n\n` +
        `Continue with the task. Call another tool when ready.`
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // summarizeConversation
  // ---------------------------------------------------------------------------

  /**
   * Trim an overlong conversation by keeping only the system message and the
   * most recent `keepLastN` messages. A summary placeholder is inserted at
   * the truncation point.
   */
  summarizeConversation(messages: LLMMessage[], keepLastN: number): LLMMessage[] {
    if (messages.length <= keepLastN + 1) return messages;

    const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
    const recent    = messages.slice(-keepLastN);
    const omitted   = messages.length - keepLastN - (systemMsg !== null ? 1 : 0);

    const summary: LLMMessage = {
      role:    "user",
      content: (
        `[Conversation truncated — ${omitted} earlier message(s) omitted to fit ` +
        `context window. Continuing from most recent exchange.]`
      ),
    };

    return systemMsg !== null
      ? [systemMsg, summary, ...recent]
      : [summary, ...recent];
  }
}
