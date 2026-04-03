// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Governance Hook
 *
 * 6-stage fail-closed governance for every MCP tool call.
 * CRITICAL: every stage is wrapped in a try/catch that returns { allowed: false }.
 *           NEVER catch and return true — that would turn a bug into a security hole.
 *
 * Stage 0 — Tool risk vs agent tier
 * Stage 1 — RBAC: division + tier allow-list
 * Stage 2 — Budget guard
 * Stage 3 — Forbidden action patterns (name match)
 * Stage 4 — Classification ceiling
 * Stage 5 — Escalation stub (V1.1 Phase 1)
 * Stage 6 — Rate limit (in-memory sliding window)
 */

import { createLogger } from "../logger.js";
import { matchToolPattern } from "./mcp-registry.js";
import type {
  McpGovernanceConfig,
  GovernanceDecision,
  GovernanceContext,
  ToolRiskLevel,
} from "./types.js";
import { RISK_TIER_MAP } from "./types.js";

const logger = createLogger("mcp-governance");

// ---------------------------------------------------------------------------
// Classification ordering (lower index = lower sensitivity)
// ---------------------------------------------------------------------------

const CLASSIFICATION_ORDER: string[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "SECRET",
  "FYEO",
];

function classificationRank(level: string): number {
  const idx = CLASSIFICATION_ORDER.indexOf(level.toUpperCase());
  return idx === -1 ? 99 : idx; // unknown levels treated as maximally sensitive
}

// ---------------------------------------------------------------------------
// Rate limiter — in-memory sliding window per (server, agentId)
// ---------------------------------------------------------------------------

/** Call timestamps per key: `${serverName}::${agentId}` */
const rateLimitWindows = new Map<string, number[]>();

/** Exported for test cleanup only */
export function clearRateLimitState(): void {
  rateLimitWindows.clear();
}

function checkRateLimit(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const cutoff = now - windowMs;

  const timestamps = (rateLimitWindows.get(key) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= maxPerMinute) {
    return false; // rate limit exceeded
  }

  timestamps.push(now);
  rateLimitWindows.set(key, timestamps);
  return true;
}

// ---------------------------------------------------------------------------
// Main governance function
// ---------------------------------------------------------------------------

export async function governToolCall(
  toolName: string,
  _args: Record<string, unknown>,
  serverName: string,
  serverGovernance: McpGovernanceConfig,
  context: GovernanceContext,
  toolRiskLevel?: ToolRiskLevel,
): Promise<GovernanceDecision> {
  try {
    // ── Stage 0: Tool risk vs agent tier ────────────────────────────────────
    if (toolRiskLevel !== undefined) {
      const permittedTiers = RISK_TIER_MAP[toolRiskLevel];
      if (!permittedTiers.includes(context.tier)) {
        logger.info("mcp_gov_risk_denied", "MCP tool call denied: tier below risk level", {
          metadata: { tool: toolName, server: serverName, tier: context.tier, riskLevel: toolRiskLevel },
        });
        return {
          allowed: false,
          reason: `Tool risk level "${toolRiskLevel}" requires tier in [${permittedTiers.join(", ")}] — agent is ${context.tier}`,
          stage: 0,
        };
      }
    }

    // ── Stage 1: RBAC — division + tier allow-list ───────────────────────────
    const allowAllDivisions = serverGovernance.allowed_divisions.includes("*");
    if (!allowAllDivisions && !serverGovernance.allowed_divisions.includes(context.division)) {
      logger.info("mcp_gov_division_denied", "MCP tool call denied: division not allowed", {
        metadata: { tool: toolName, server: serverName, division: context.division },
      });
      return {
        allowed: false,
        reason: `Division "${context.division}" is not permitted for server "${serverName}"`,
        stage: 1,
      };
    }

    if (!serverGovernance.allowed_tiers.includes(context.tier)) {
      logger.info("mcp_gov_tier_denied", "MCP tool call denied: tier not allowed", {
        metadata: { tool: toolName, server: serverName, tier: context.tier },
      });
      return {
        allowed: false,
        reason: `Tier "${context.tier}" is not permitted for server "${serverName}"`,
        stage: 1,
      };
    }

    // ── Stage 2: Budget guard ────────────────────────────────────────────────
    if (context.budgetRemaining < serverGovernance.budget_per_call) {
      logger.info("mcp_gov_budget_denied", "MCP tool call denied: insufficient budget", {
        metadata: {
          tool: toolName, server: serverName,
          budgetRemaining: context.budgetRemaining,
          required: serverGovernance.budget_per_call,
        },
      });
      return {
        allowed: false,
        reason: `Insufficient budget: ${context.budgetRemaining.toFixed(4)} remaining, ${serverGovernance.budget_per_call} required per call`,
        stage: 2,
      };
    }

    // ── Stage 3: Forbidden action patterns ──────────────────────────────────
    for (const pattern of serverGovernance.forbidden_patterns) {
      if (matchToolPattern(toolName, pattern)) {
        logger.info("mcp_gov_forbidden_denied", "MCP tool call denied: forbidden pattern", {
          metadata: { tool: toolName, server: serverName, pattern },
        });
        return {
          allowed: false,
          reason: `Tool "${toolName}" matches forbidden pattern "${pattern}"`,
          stage: 3,
        };
      }
    }

    // ── Stage 4: Classification ceiling ─────────────────────────────────────
    if (context.taskClassification !== undefined) {
      const taskRank = classificationRank(context.taskClassification);
      const ceilingRank = classificationRank(serverGovernance.classification_ceiling);
      if (taskRank > ceilingRank) {
        logger.info("mcp_gov_classification_denied", "MCP tool call denied: classification above ceiling", {
          metadata: {
            tool: toolName, server: serverName,
            taskClassification: context.taskClassification,
            ceiling: serverGovernance.classification_ceiling,
          },
        });
        return {
          allowed: false,
          reason: `Task classification "${context.taskClassification}" exceeds server ceiling "${serverGovernance.classification_ceiling}"`,
          stage: 4,
        };
      }
    }

    // ── Stage 5: Escalation stub (V1.1 Phase 1 placeholder) ─────────────────
    // Future: check if tool requires human approval for this tier/division
    // For V1.0: pass-through

    // ── Stage 6: Rate limit ──────────────────────────────────────────────────
    const rateLimitKey = `${serverName}::${context.agentId}`;
    if (!checkRateLimit(rateLimitKey, serverGovernance.max_calls_per_minute)) {
      logger.info("mcp_gov_ratelimit_denied", "MCP tool call denied: rate limit exceeded", {
        metadata: { tool: toolName, server: serverName, agentId: context.agentId, maxPerMinute: serverGovernance.max_calls_per_minute },
      });
      return {
        allowed: false,
        reason: `Rate limit exceeded: max ${serverGovernance.max_calls_per_minute} calls/minute for server "${serverName}"`,
        stage: 6,
      };
    }

    // ── All stages passed ────────────────────────────────────────────────────
    logger.debug("mcp_gov_allowed", "MCP tool call approved by governance", {
      metadata: { tool: toolName, server: serverName, agentId: context.agentId },
    });
    return { allowed: true };

  } catch (err: unknown) {
    // CRITICAL: fail-closed — any unexpected error denies the call
    logger.warn("mcp_gov_error", "MCP governance error — denying tool call (fail-closed)", {
      metadata: {
        tool: toolName, server: serverName,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return { allowed: false, reason: "Governance check failed (internal error)" };
  }
}
