// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Tool Schema Builder (P342)
 *
 * Converts internal tool definitions and MCP tool capabilities into
 * LLM function-calling format for injection into agent system prompts.
 */

import { ALL_INTERNAL_TOOLS }              from "./internal/index.js";
import { toolRbacChecker, type RbacContext } from "./tool-rbac.js";
import type { ToolManager }                from "./tool-manager.js";
import { createLogger }                    from "../core/logger.js";

const logger = createLogger("tool-schema");

/** Tokens per tool schema (conservative estimate for budget calculation). */
const TOKENS_PER_SCHEMA = 50;


export interface LLMToolSchema {
  type: "function";
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

export interface ToolSchemaResult {
  schemas:       LLMToolSchema[];
  tokenEstimate: number;
  toolCount:     number;
}


export class ToolSchemaBuilder {
  private toolManager: ToolManager | null = null;

  /** Inject a running ToolManager so MCP adapter capabilities can be fetched. */
  setToolManager(tm: ToolManager): void {
    this.toolManager = tm;
  }

  /**
   * Build LLM function-calling schemas for all tools an agent is allowed to use.
   *
   * Priority: internal tools first, then MCP tools.
   * Only tools present in rbacCtx.tools (and passing RBAC check) are included.
   */
  buildForAgent(rbacCtx: RbacContext): ToolSchemaResult {
    const schemas: LLMToolSchema[] = [];

    // 1. Internal tools
    const allowedInternal = toolRbacChecker.filterAllowed(
      rbacCtx,
      rbacCtx.tools.internal,
      "internal",
    );

    for (const name of allowedInternal) {
      const toolDef = ALL_INTERNAL_TOOLS.find((t) => t.name === name);
      if (toolDef === undefined) continue;

      for (const cap of toolDef.capabilities) {
        schemas.push({
          type: "function",
          function: {
            name:        toolDef.name,
            description: cap.description,
            parameters:  cap.input_schema,
          },
        });
      }
    }

    // 2. MCP tools
    const allowedMcp = toolRbacChecker.filterAllowed(
      rbacCtx,
      rbacCtx.tools.mcp,
      "mcp",
    );

    for (const mcpName of allowedMcp) {
      if (this.toolManager === null) continue;

      try {
        const adapter = this.toolManager.getAdapter(mcpName);
        if (adapter === undefined) continue;

        for (const cap of adapter.getCapabilities()) {
          schemas.push({
            type: "function",
            function: {
              name:        `${mcpName}__${cap.name}`,
              description: cap.description,
              parameters:  cap.input_schema,
            },
          });
        }
      } catch (err) {
        logger.warn("tool_schema_mcp_error", "Failed to get MCP tool capabilities", {
          metadata: { server: mcpName, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    const tokenEstimate = schemas.length * TOKENS_PER_SCHEMA;
    return { schemas, tokenEstimate, toolCount: schemas.length };
  }
}

export const toolSchemaBuilder = new ToolSchemaBuilder();
