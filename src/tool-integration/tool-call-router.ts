// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P343: Tool Call Router
 *
 * Central router that implements ToolDispatcher and routes agent tool calls
 * to internal or MCP adapters. Applies RBAC + governance before execution
 * and writes an audit trail entry after every call.
 *
 * Tool name format:
 *   "system_health"            → internal tool
 *   "github-mcp__create_issue" → MCP server "github-mcp", capability "create_issue"
 */

import { randomUUID }                      from "node:crypto";
import type { ToolResult, ToolAction }     from "./types.js";
import type { ToolManager }               from "./tool-manager.js";
import type { ToolGovernance }            from "./tool-governance.js";
import type { McpLifecycleManager }       from "./mcp-lifecycle.js";
import type { SlidingWindowRateLimiter, RateLimitConfig } from "./rate-limiter.js";
import { toolRbacChecker, type RbacContext } from "./tool-rbac.js";
import { ALL_INTERNAL_TOOLS }             from "./internal/index.js";
import type { InternalToolAdapter }       from "./adapters/internal-adapter.js";
import { createLogger }                   from "../core/logger.js";
import type { Database }                  from "../utils/db.js";

const logger = createLogger("tool-router");

/** No-op rate limiter used when none is configured — always allows. */
const NULL_RATE_LIMITER: SlidingWindowRateLimiter = {
  check: () => ({ allowed: true }),
  record: () => {},
} as unknown as SlidingWindowRateLimiter;

const DEFAULT_RATE_CONFIG: RateLimitConfig = {};


export interface ToolCallContext {
  agent_id:      string;
  tier:          1 | 2 | 3;
  division:      string;
  task_id?:      string;
  tools:         { internal: string[]; mcp: string[] };
  /** Caller origin — absent or "agent" is treated as agent context (most restrictive). */
  caller_source?: "agent" | "orchestrator";
}

export interface ToolCallResult {
  success:            boolean;
  data?:              unknown;
  error?:             string;
  tool_name:          string;
  tool_type:          "internal" | "mcp";
  duration_ms:        number;
  governance_blocked?: boolean;
  governance_reason?:  string;
  requires_approval?:  boolean;
}


export class ToolCallRouter {
  private internalAdapters = new Map<string, InternalToolAdapter>();
  private toolManager:   ToolManager | null        = null;
  private governance:    ToolGovernance | null      = null;
  private mcpLifecycle:  McpLifecycleManager | null = null;
  private rateLimiter:   SlidingWindowRateLimiter   = NULL_RATE_LIMITER;
  private rateConfig:    RateLimitConfig             = DEFAULT_RATE_CONFIG;
  private db:            Database | null             = null;

  setToolManager(tm: ToolManager): void          { this.toolManager  = tm; }
  setGovernance(gov: ToolGovernance): void       { this.governance   = gov; }
  setMcpLifecycle(lm: McpLifecycleManager): void { this.mcpLifecycle = lm; }
  setDb(db: Database): void                      { this.db           = db; }

  setRateLimiter(rl: SlidingWindowRateLimiter, cfg: RateLimitConfig = {}): void {
    this.rateLimiter = rl;
    this.rateConfig  = cfg;
  }

  registerInternalAdapter(name: string, adapter: InternalToolAdapter): void {
    this.internalAdapters.set(name, adapter);
  }

  // ---------------------------------------------------------------------------
  // createDispatcher
  // ---------------------------------------------------------------------------

  /**
   * Return a ToolDispatcher function bound to a specific agent context.
   * Wire this into `ReasoningLoopDeps.dispatchTool`.
   *
   * On governance block, returns `{ error: "..." }` so the agent can react
   * and retry with different parameters or escalate.
   */
  createDispatcher(
    ctx: ToolCallContext,
  ): (toolName: string, toolInput: Record<string, unknown>) => Promise<unknown> {
    return async (toolName: string, toolInput: Record<string, unknown>): Promise<unknown> => {
      const result = await this.execute(ctx, toolName, toolInput);
      if (!result.success) {
        if (result.governance_blocked === true) {
          return { error: `Tool call blocked by governance: ${result.governance_reason ?? "policy"}` };
        }
        return { error: result.error ?? "Tool execution failed" };
      }
      return result.data;
    };
  }

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  async execute(
    ctx:       ToolCallContext,
    toolName:  string,
    toolInput: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const start = Date.now();

    // 1. Determine tool type and resolve names
    const { type, resolvedName, serverName } = this.resolveToolType(toolName);

    // 2. RBAC check
    const rbacCtx: RbacContext = {
      agent_id: ctx.agent_id,
      tier:     ctx.tier,
      division: ctx.division,
      tools:    ctx.tools,
    };
    const rbacKey    = type === "mcp" ? serverName! : resolvedName;
    const rbacResult = toolRbacChecker.check(rbacCtx, rbacKey, type);

    if (!rbacResult.allowed) {
      logger.warn("tool_router_rbac_blocked", "Tool call blocked by RBAC", {
        metadata: { agent_id: ctx.agent_id, tool: toolName, reason: rbacResult.reason },
      });
      this.writeAuditEntry(ctx, toolName, "blocked", rbacResult.reason);
      return {
        success:            false,
        tool_name:          toolName,
        tool_type:          type,
        duration_ms:        Date.now() - start,
        governance_blocked: true,
        ...(rbacResult.reason !== undefined ? { governance_reason: rbacResult.reason } : {}),
      };
    }

    // 3. Tool governance check (forbidden, approval_required, path_deny, rate_limit)
    if (this.governance !== null) {
      const toolId = type === "mcp" ? serverName! : resolvedName;
      const action: ToolAction = {
        tool_id:    toolId,
        capability: resolvedName,
        params:     toolInput,
        agent_id:   ctx.agent_id,
        ...(ctx.task_id !== undefined ? { task_id: ctx.task_id } : {}),
      };

      try {
        const govResult = await this.governance.check(
          toolId,
          action,
          this.rateLimiter,
          this.rateConfig,
        );

        if (govResult.blocked) {
          const blockedCheck = govResult.checks.find((c) => !c.passed);
          const reason = blockedCheck?.reason ?? "governance policy";
          logger.warn("tool_router_gov_blocked", "Tool call blocked by governance", {
            metadata: { agent_id: ctx.agent_id, tool: toolName, reason },
          });
          this.writeAuditEntry(ctx, toolName, "blocked", reason);
          return {
            success:            false,
            tool_name:          toolName,
            tool_type:          type,
            duration_ms:        Date.now() - start,
            governance_blocked: true,
            governance_reason:  reason,
          };
        }

        if (govResult.requiresApproval) {
          logger.info("tool_router_approval_required", "Tool call requires approval", {
            metadata: { agent_id: ctx.agent_id, tool: toolName },
          });
          this.writeAuditEntry(ctx, toolName, "blocked", "requires_approval");
          return {
            success:            false,
            tool_name:          toolName,
            tool_type:          type,
            duration_ms:        Date.now() - start,
            governance_blocked: true,
            governance_reason:  "Tool requires human approval before execution",
            requires_approval:  true,
          };
        }
      } catch (govErr) {
        const errMsg = govErr instanceof Error ? govErr.message : String(govErr);
        logger.error("tool_router_gov_error", "Governance check failed — blocking execution (fail-closed)", {
          metadata: {
            agent_id: ctx.agent_id,
            tool: toolName,
            error: errMsg,
          },
        });
        this.writeAuditEntry(ctx, toolName, "blocked", `governance_error: ${errMsg}`);
        return {
          success:            false,
          tool_name:          toolName,
          tool_type:          type,
          duration_ms:        Date.now() - start,
          governance_blocked: true,
          governance_reason:  "Governance evaluation failed — execution blocked for safety",
        };
      }
    }

    // 4. Execute
    try {
      let result: ToolResult;

      if (type === "internal") {
        result = await this.executeInternal(ctx, resolvedName, toolInput, start);
      } else {
        result = await this.executeMcp(ctx, toolName, resolvedName, serverName!, toolInput, start);
      }

      const status = result.success ? "allowed" : "allowed"; // errors still reached execution
      this.writeAuditEntry(ctx, toolName, status, result.error);

      return {
        success:    result.success,
        tool_name:  toolName,
        tool_type:  type,
        duration_ms: result.duration_ms,
        ...(result.data  !== undefined ? { data:  result.data  } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn("tool_router_exec_error", `Tool execution threw: ${toolName}`, {
        metadata: { agent_id: ctx.agent_id, error: errMsg },
      });
      this.writeAuditEntry(ctx, toolName, "allowed", errMsg);
      return {
        success:    false,
        error:      errMsg,
        tool_name:  toolName,
        tool_type:  type,
        duration_ms: Date.now() - start,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal tool execution
  // ---------------------------------------------------------------------------

  private async executeInternal(
    ctx:         ToolCallContext,
    toolName:    string,
    toolInput:   Record<string, unknown>,
    startMs:     number,
  ): Promise<ToolResult> {
    const adapter = this.internalAdapters.get(toolName);
    if (adapter === undefined) {
      return {
        success:    false,
        error:      `Internal tool '${toolName}' not registered`,
        duration_ms: Date.now() - startMs,
      };
    }

    // Enforce caller restriction: orchestrator-only tools cannot be called from agent context
    if (
      adapter.callerRestriction === "orchestrator" &&
      ctx.caller_source !== "orchestrator"
    ) {
      return {
        success:    false,
        error:      `Tool '${toolName}' is restricted to orchestrator-level callers`,
        duration_ms: Date.now() - startMs,
      };
    }

    const action: ToolAction = {
      tool_id:    toolName,
      capability: toolName,
      params:     toolInput,
      agent_id:   ctx.agent_id,
      ...(ctx.task_id !== undefined ? { task_id: ctx.task_id } : {}),
    };

    return adapter.execute(action);
  }

  // ---------------------------------------------------------------------------
  // MCP tool execution
  // ---------------------------------------------------------------------------

  private async executeMcp(
    ctx:          ToolCallContext,
    fullToolName: string,
    capabilityName: string,
    serverName:   string,
    toolInput:    Record<string, unknown>,
    startMs:      number,
  ): Promise<ToolResult> {
    if (this.toolManager === null) {
      return {
        success:    false,
        error:      "ToolManager not available for MCP tool dispatch",
        duration_ms: Date.now() - startMs,
      };
    }

    // On-demand start via lifecycle manager
    if (this.mcpLifecycle !== null) {
      try {
        await this.mcpLifecycle.startServer(serverName);
        this.mcpLifecycle.touch(serverName);
      } catch (err) {
        logger.warn("tool_router_mcp_start_failed", `MCP server start failed: ${serverName}`, {
          metadata: {
            agent_id: ctx.agent_id,
            server: serverName,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const adapter = this.toolManager.getAdapter(serverName);
    if (adapter === undefined) {
      return {
        success:    false,
        error:      `MCP server '${serverName}' not available`,
        duration_ms: Date.now() - startMs,
      };
    }

    const action: ToolAction = {
      tool_id:    serverName,
      capability: capabilityName,
      params:     toolInput,
      agent_id:   ctx.agent_id,
      ...(ctx.task_id !== undefined ? { task_id: ctx.task_id } : {}),
    };

    return adapter.execute(action);
  }

  // ---------------------------------------------------------------------------
  // resolveToolType
  // ---------------------------------------------------------------------------

  /**
   * Parse the tool name to determine routing:
   *   - Contains "__" → MCP: split into serverName + capabilityName
   *   - Known internal tool → internal
   *   - Otherwise → attempt as MCP (single-word server name)
   */
  private resolveToolType(toolName: string): {
    type:         "internal" | "mcp";
    resolvedName: string;
    serverName?:  string;
  } {
    if (toolName.includes("__")) {
      const sep = toolName.indexOf("__");
      const server = toolName.slice(0, sep);
      const tool   = toolName.slice(sep + 2);
      return { type: "mcp", resolvedName: tool, serverName: server };
    }

    // Check registered adapters first (fastest path)
    if (this.internalAdapters.has(toolName)) {
      return { type: "internal", resolvedName: toolName };
    }

    // Fall back to static tool list
    if (ALL_INTERNAL_TOOLS.some((t) => t.name === toolName)) {
      return { type: "internal", resolvedName: toolName };
    }

    // Treat as single-word MCP server name
    return { type: "mcp", resolvedName: toolName, serverName: toolName };
  }

  // ---------------------------------------------------------------------------
  // writeAuditEntry
  // ---------------------------------------------------------------------------

  /**
   * Write a row to `audit_events`. Non-fatal — errors are logged and swallowed.
   *
   * `action` column CHECK: 'allowed' | 'blocked' | 'escalated'
   * `severity` column: 'low' | 'medium' | 'high' | 'critical'
   */
  private writeAuditEntry(
    ctx:      ToolCallContext,
    toolName: string,
    action:   "allowed" | "blocked" | "escalated",
    detail?:  string,
  ): void {
    if (this.db === null) return;
    try {
      this.db.prepare(
        `INSERT INTO audit_events
           (id, agent_id, division, event_type, rule_id, action, severity, details, task_id)
         VALUES (?, ?, ?, 'tool_call', '', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        ctx.agent_id,
        ctx.division,
        action,
        action === "blocked" ? "medium" : "low",
        JSON.stringify({ tool: toolName, ...(detail !== undefined ? { detail } : {}) }),
        ctx.task_id ?? null,
      );
    } catch (err) {
      logger.warn("tool_router_audit_error", "Audit write failed (non-fatal)", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}


/** Module-level singleton. Wire with setDb / setToolManager / setGovernance before use. */
export const toolCallRouter = new ToolCallRouter();
