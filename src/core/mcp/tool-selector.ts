// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Tool Selector
 *
 * Heuristic relevance scoring to reduce the tool list sent to the LLM per turn.
 * Fewer tokens → lower cost + higher attention on the relevant tools.
 *
 * Scoring: count keyword matches between the task description and each
 * tool's name + description. Break ties by name lexicographic order.
 */

import type { McpTool } from "./types.js";

const DEFAULT_MAX_TOOLS = 10;

/** Tokenise a string into lowercase words (alphanumeric only). */
function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Return the subset of `tools` most relevant to `taskDescription`,
 * ranked by keyword overlap, capped at `maxTools`.
 *
 * If `tools.length <= maxTools`, all tools are returned unchanged.
 */
export function selectRelevantTools(
  tools:           McpTool[],
  taskDescription: string,
  maxTools:        number = DEFAULT_MAX_TOOLS,
): McpTool[] {
  if (tools.length <= maxTools) return tools;

  const taskTokens = new Set(tokenise(taskDescription));

  const scored = tools.map((tool) => {
    const haystack = `${tool.name} ${tool.description}`;
    const toolTokens = tokenise(haystack);
    let score = 0;
    for (const tok of toolTokens) {
      if (taskTokens.has(tok)) score++;
    }
    return { tool, score };
  });

  // Sort: descending score, then lexicographic name for stable tie-breaking
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.name.localeCompare(b.tool.name);
  });

  return scored.slice(0, maxTools).map((s) => s.tool);
}
