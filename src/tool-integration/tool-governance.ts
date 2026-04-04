// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Tool Governance
 *
 * Pre-pipeline governance layer: evaluates active rules for a tool action
 * and returns blocked/approval flags plus per-rule check results.
 */

import { sep, resolve } from "node:path";
import type { Database } from "../utils/db.js";
import type {
  ToolGovernanceRule,
  GovernanceRuleType,
  GovernanceEnforcement,
  GovernanceCheck,
  ToolAction,
} from "./types.js";
import type { SlidingWindowRateLimiter, RateLimitConfig } from "./rate-limiter.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("tool-governance");


interface DbGovernanceRuleRow {
  id: number;
  tool_id: string;
  rule_type: string;
  pattern: string | null;
  condition: string | null;
  enforcement: string;
  reason: string | null;
  config_json: string;
  active: number;
  created_at: string;
}


/**
 * Match a capability string against a rule pattern.
 * Supports exact match and prefix wildcard: "shell_*" matches "shell_exec".
 */
function matchPattern(pattern: string, value: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return pattern === value;
}

/**
 * Extract a URL string from action params, checking common key names.
 */
function extractUrl(params: Record<string, unknown>): string | undefined {
  for (const key of ["url", "base_url"]) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * Extract the hostname from a URL string; returns undefined on parse failure.
 */
function extractDomain(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname;
  } catch (e: unknown) {
    logger.warn("tool-governance", "Invalid URL — cannot extract domain for governance check", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return undefined;
  }
}

/**
 * Derive write/delete semantics from a capability name.
 * Used to correctly route rate-limit checks to ops_per_min / writes_per_min / deletes_per_hour.
 *
 * Splits on underscores, hyphens, and spaces to handle snake_case and
 * kebab-case capability names (e.g. "write_file" → ["write","file"]).
 */
function inferToolSemantics(capability: string): { isWrite: boolean; isDelete: boolean } {
  const words = capability.toLowerCase().split(/[_\-\s]+/);
  const DELETE_WORDS = new Set(["delete", "remove", "destroy", "clear", "purge", "drop", "wipe", "uninstall"]);
  const WRITE_WORDS  = new Set(["create", "write", "set", "insert", "post", "put", "add", "update",
                                 "edit", "modify", "upload", "push", "patch", "append", "rotate",
                                 "enable", "disable", "install"]);
  const isDelete = words.some((w) => DELETE_WORDS.has(w));
  const isWrite  = isDelete || words.some((w) => WRITE_WORDS.has(w));
  return { isWrite, isDelete };
}

/**
 * Check if a hostname matches a domain pattern.
 * Requires exact match or a proper subdomain (prevents "evil-example.com" matching "example.com").
 */
function domainMatches(hostname: string, pattern: string): boolean {
  return hostname === pattern || hostname.endsWith("." + pattern);
}

/**
 * Extract a file-path string from action params, checking common key names.
 */
function extractPath(params: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "dir"]) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}


export class ToolGovernance {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // check
  // -------------------------------------------------------------------------

  /**
   * Run all active governance rules for a tool action.
   * Returns `blocked`, an array of per-rule `checks`, and `requiresApproval`.
   *
   * - `blocked=true` when any check has `passed=false` AND `enforcement='block'`
   * - `requiresApproval=true` when any `approval_required` rule matches
   */
  async check(
    toolId: string,
    action: ToolAction,
    rateLimiter: SlidingWindowRateLimiter,
    rateConfig: RateLimitConfig,
  ): Promise<{ blocked: boolean; checks: GovernanceCheck[]; requiresApproval: boolean }> {
    const rules = this.getRules(toolId).filter((r) => r.active);

    const checks: GovernanceCheck[] = [];
    let blocked = false;
    let requiresApproval = false;

    for (const rule of rules) {
      const check = await this.evaluateRule(rule, action, rateLimiter, rateConfig);
      checks.push(check);

      if (!check.passed && rule.enforcement === "block") {
        blocked = true;
      }

      if (check.requires_approval === true) {
        requiresApproval = true;
      }
    }

    return { blocked, checks, requiresApproval };
  }

  // -------------------------------------------------------------------------
  // addRule
  // -------------------------------------------------------------------------

  /**
   * Insert a new governance rule and return the persisted record.
   */
  addRule(
    rule: Omit<ToolGovernanceRule, "id" | "created_at">,
  ): ToolGovernanceRule {
    const now = new Date().toISOString();
    const configJson = rule.config !== undefined ? JSON.stringify(rule.config) : "{}";
    const patternVal: string | null = rule.pattern !== undefined ? rule.pattern : null;
    const conditionVal: string | null = rule.condition !== undefined ? rule.condition : null;
    const reasonVal: string | null = rule.reason !== undefined ? rule.reason : null;

    const result = this.db
      .prepare<
        [string, string, string | null, string | null, string, string | null, string, number, string],
        void
      >(
        `INSERT INTO tool_governance_rules
           (tool_id, rule_type, pattern, condition, enforcement, reason,
            config_json, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.tool_id,
        rule.rule_type,
        patternVal,
        conditionVal,
        rule.enforcement,
        reasonVal,
        configJson,
        rule.active ? 1 : 0,
        now,
      );

    const id = Number((result as { lastInsertRowid: bigint | number }).lastInsertRowid);
    return this.mapRow({ ...this.rawGetById(id) });
  }

  // -------------------------------------------------------------------------
  // getRules
  // -------------------------------------------------------------------------

  /**
   * Get all rules for a tool (both active and inactive).
   */
  getRules(toolId: string): ToolGovernanceRule[] {
    const rows = this.db
      .prepare<[string], DbGovernanceRuleRow>(
        `SELECT id, tool_id, rule_type, pattern, condition, enforcement, reason,
                config_json, active, created_at
         FROM tool_governance_rules WHERE tool_id = ?`,
      )
      .all(toolId);

    return rows.map((r) => this.mapRow(r));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async evaluateRule(
    rule: ToolGovernanceRule,
    action: ToolAction,
    rateLimiter: SlidingWindowRateLimiter,
    rateConfig: RateLimitConfig,
  ): Promise<GovernanceCheck> {
    const pattern = rule.pattern;

    switch (rule.rule_type) {
      case "forbidden": {
        if (pattern !== undefined && matchPattern(pattern, action.capability)) {
          return {
            rule_type: "forbidden",
            passed: false,
            reason: rule.reason ?? "Capability is forbidden",
          };
        }
        return { rule_type: "forbidden", passed: true };
      }

      case "approval_required": {
        if (pattern !== undefined && matchPattern(pattern, action.capability)) {
          return {
            rule_type: "approval_required",
            passed: true,
            requires_approval: true,
            ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
          };
        }
        return { rule_type: "approval_required", passed: true };
      }

      case "path_deny":
      // "path_restriction" stored in existing databases maps to the same logic.
      // Semantics: the pattern specifies a PATH THAT IS DENIED (denylist, not allowlist).
      // Any file path that equals or is nested inside the denied subtree is blocked.
      // eslint-disable-next-line no-fallthrough
      case "path_restriction": {
        if (pattern !== undefined) {
          const filePath = extractPath(action.params);
          if (filePath !== undefined) {
            const resolvedPath = resolve(filePath);
            const deniedBase   = resolve(pattern); // pattern = the ROOT OF THE DENIED SUBTREE
            if (resolvedPath === deniedBase || resolvedPath.startsWith(deniedBase + sep)) {
              return {
                rule_type: rule.rule_type, // preserve stored name for audit trail continuity
                passed: false,
                reason: "Path access denied",
              };
            }
          }
        }
        return { rule_type: rule.rule_type, passed: true };
      }

      case "domain_restriction": {
        if (pattern !== undefined) {
          const rawUrl = extractUrl(action.params);
          if (rawUrl !== undefined) {
            const domain = extractDomain(rawUrl);
            if (domain !== undefined && domainMatches(domain, pattern)) {
              return {
                rule_type: "domain_restriction",
                passed: false,
                reason: "Domain blocked",
              };
            }
          }
        }
        return { rule_type: "domain_restriction", passed: true };
      }

      case "rate_limit": {
        const { isWrite, isDelete } = inferToolSemantics(action.capability);
        const result = rateLimiter.check(
          action.tool_id,
          action.capability,
          isWrite,
          isDelete,
          rateConfig,
        );
        if (!result.allowed) {
          return {
            rule_type: "rate_limit",
            passed: false,
            reason: "Rate limit exceeded",
          };
        }
        return { rule_type: "rate_limit", passed: true };
      }
    }
  }

  private rawGetById(id: number): DbGovernanceRuleRow {
    const row = this.db
      .prepare<[number], DbGovernanceRuleRow>(
        `SELECT id, tool_id, rule_type, pattern, condition, enforcement, reason,
                config_json, active, created_at
         FROM tool_governance_rules WHERE id = ?`,
      )
      .get(id);

    if (row === undefined) {
      throw new Error(`ToolGovernance: rule not found: id=${id}`);
    }

    return row;
  }

  private mapRow(row: DbGovernanceRuleRow): ToolGovernanceRule {
    const rule: ToolGovernanceRule = {
      id: row.id,
      tool_id: row.tool_id,
      rule_type: row.rule_type as GovernanceRuleType,
      enforcement: row.enforcement as GovernanceEnforcement,
      active: row.active !== 0,
      created_at: row.created_at,
    };

    if (row.pattern !== null) {
      rule.pattern = row.pattern;
    }

    if (row.condition !== null) {
      rule.condition = row.condition;
    }

    if (row.reason !== null) {
      rule.reason = row.reason;
    }

    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    if (Object.keys(config).length > 0) {
      rule.config = config;
    }

    return rule;
  }
}
