// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Tool RBAC Checker (P340)
 *
 * Enforces tool access control at runtime based on an agent's role YAML
 * tool assignments. Integrates with the Pre-Action Pipeline as Stage 0 (rbac).
 */

import type { RoleToolConfig } from "../defaults/loader.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("tool-rbac");


export interface RbacContext {
  agent_id: string;
  tier:     1 | 2 | 3;
  division: string;
  tools:    RoleToolConfig;
}


export class ToolRbacChecker {
  /**
   * Check if an agent is allowed to use a specific tool.
   * Returns { allowed, reason }.
   *
   * Wildcard: tools.internal = ['*'] or tools.mcp = ['*'] grants all tools of that type.
   */
  check(
    ctx:      RbacContext,
    toolName: string,
    toolType: "internal" | "mcp",
  ): { allowed: boolean; reason?: string } {
    const allowedTools = toolType === "internal" ? ctx.tools.internal : ctx.tools.mcp;

    if (allowedTools.includes("*")) {
      return { allowed: true };
    }

    if (!allowedTools.includes(toolName)) {
      logger.warn("rbac_denied", "Tool access denied", {
        metadata: { agent_id: ctx.agent_id, tool: toolName, type: toolType },
      });
      return {
        allowed: false,
        reason:
          `Agent ${ctx.agent_id} (${ctx.division}) is not authorized to use tool '${toolName}'. ` +
          `Authorized ${toolType} tools: [${allowedTools.join(", ")}]`,
      };
    }

    return { allowed: true };
  }

  /**
   * Filter a list of tool names to only those the agent is allowed to use.
   */
  filterAllowed(
    ctx:       RbacContext,
    toolNames: string[],
    toolType:  "internal" | "mcp",
  ): string[] {
    return toolNames.filter((name) => this.check(ctx, name, toolType).allowed);
  }
}

export const toolRbacChecker = new ToolRbacChecker();
