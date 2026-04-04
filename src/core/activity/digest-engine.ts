// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Digest Engine
 *
 * Generates structured summaries (daily, weekly, agent, division) from
 * activity_events. Persists results to activity_digests for later retrieval.
 *
 * Design:
 * - generate*() methods are synchronous — activityEmitter.query() is synchronous
 * - All writes to activity_digests are best-effort (non-fatal on failure)
 * - Never throws to callers — individual errors are logged at WARN level
 *
 * Wired at startup: digestEngine.init(db) after activityEmitter.init(db)
 */

import { randomUUID }               from "node:crypto";
import { activityEmitter }          from "./activity-emitter.js";
import type { ActivityFilters, ActivityRecord } from "./activity-types.js";
import type { Database }            from "../../utils/db.js";
import { createLogger }             from "../logger.js";

const logger = createLogger("digest-engine");


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DigestSummary {
  headline:   string;
  highlights: string[];
  warnings:   string[];
  categories: Record<string, number>;
}

export interface DigestStats {
  total_events:       number;
  by_category:        Record<string, number>;
  by_severity:        Record<string, number>;
  by_agent:           Record<string, number>;
  by_division:        Record<string, number>;
  tasks_completed:    number;
  tasks_failed:       number;
  governance_blocks:  number;
  budget_total_usd:   number;
}

export interface DigestResult {
  id:           string;
  digest_type:  "daily" | "weekly" | "project" | "agent" | "division";
  scope_id:     string | null;
  period_start: string;
  period_end:   string;
  generated_at: string;
  summary:      DigestSummary;
  stats:        DigestStats;
  event_count:  number;
}


// ---------------------------------------------------------------------------
// DigestEngine
// ---------------------------------------------------------------------------

export class DigestEngine {
  private db: Database | null = null;

  /** Must be called once at startup before any generate*() call. */
  init(db: Database): void {
    this.db = db;
  }

  /** Generate a digest for a single calendar day (UTC). */
  generateDaily(date: string, division?: string): DigestResult {
    const periodStart = date + "T00:00:00.000Z";
    const periodEnd   = date + "T23:59:59.999Z";
    return this._generate("daily", periodStart, periodEnd, division ?? null);
  }

  /**
   * Generate a daily digest using explicit UTC range boundaries.
   * Use this when the calendar date is derived from a non-UTC timezone —
   * the UTC boundaries correctly cover the 24-hour window in the target timezone.
   */
  generateDailyRange(periodStart: string, periodEnd: string, division?: string): DigestResult {
    return this._generate("daily", periodStart, periodEnd, division ?? null);
  }

  /** Generate a digest for the 7-day week beginning at weekStart (YYYY-MM-DD). */
  generateWeekly(weekStart: string, division?: string): DigestResult {
    const start = new Date(weekStart);
    const end   = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const periodStart = weekStart + "T00:00:00.000Z";
    const periodEnd   = end.toISOString().split("T")[0] + "T23:59:59.999Z";
    return this._generate("weekly", periodStart, periodEnd, division ?? null);
  }

  /** Generate a drilldown for a single agent within [since, until]. */
  generateAgentDrilldown(agentId: string, since: string, until: string): DigestResult {
    return this._generate("agent", since, until, agentId);
  }

  /** Generate a drilldown for a single division within [since, until]. */
  generateDivisionDrilldown(division: string, since: string, until: string): DigestResult {
    return this._generate("division", since, until, division);
  }

  /**
   * Retrieve the most recently generated digest of a given type and period_start.
   * Returns null if no matching digest exists or DB is not initialised.
   */
  getDigest(digestType: string, periodStart: string): DigestResult | null {
    if (this.db === null) return null;
    try {
      const row = this.db
        .prepare<[string, string], Record<string, unknown>>(
          "SELECT * FROM activity_digests WHERE digest_type = ? AND period_start = ? ORDER BY generated_at DESC LIMIT 1",
        )
        .get(digestType, periodStart);
      if (row === undefined) return null;
      return {
        id:           row["id"] as string,
        digest_type:  row["digest_type"] as DigestResult["digest_type"],
        scope_id:     (row["scope_id"] as string | null) ?? null,
        period_start: row["period_start"] as string,
        period_end:   row["period_end"] as string,
        generated_at: row["generated_at"] as string,
        event_count:  row["event_count"] as number,
        summary:      JSON.parse((row["summary"] as string) || "{}") as DigestSummary,
        stats:        JSON.parse((row["stats"]   as string) || "{}") as DigestStats,
      };
    } catch (err: unknown) {
      logger.warn("digest_get_failed", "Failed to retrieve digest", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _generate(
    digestType: DigestResult["digest_type"],
    periodStart: string,
    periodEnd:   string,
    scopeId:     string | null,
  ): DigestResult {
    const filters: ActivityFilters = { since: periodStart, until: periodEnd, limit: 10_000 };
    if ((digestType === "division" || digestType === "daily" || digestType === "weekly") && scopeId !== null) filters.division = scopeId;
    if (digestType === "agent"    && scopeId !== null) filters.agent_id = scopeId;

    const events  = activityEmitter.query(filters);
    const stats   = this._computeStats(events);
    const summary = this._buildSummary(events, stats);

    const result: DigestResult = {
      id:           randomUUID(),
      digest_type:  digestType,
      scope_id:     scopeId,
      period_start: periodStart,
      period_end:   periodEnd,
      generated_at: new Date().toISOString(),
      summary,
      stats,
      event_count:  events.length,
    };

    // Persist — best effort, never block the caller
    if (this.db !== null) {
      try {
        this.db.prepare<unknown[], void>(
          `INSERT INTO activity_digests
             (id, digest_type, scope_id, period_start, period_end, generated_at, summary, stats, event_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          result.id,
          result.digest_type,
          result.scope_id,
          result.period_start,
          result.period_end,
          result.generated_at,
          JSON.stringify(result.summary),
          JSON.stringify(result.stats),
          result.event_count,
        );
      } catch (err: unknown) {
        logger.warn("digest_persist_failed", "Failed to persist digest (non-fatal)", {
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return result;
  }

  private _computeStats(events: ActivityRecord[]): DigestStats {
    const stats: DigestStats = {
      total_events:      events.length,
      by_category:       {},
      by_severity:       {},
      by_agent:          {},
      by_division:       {},
      tasks_completed:   0,
      tasks_failed:      0,
      governance_blocks: 0,
      budget_total_usd:  0,
    };

    for (const e of events) {
      stats.by_category[e.category]                       = (stats.by_category[e.category]                       || 0) + 1;
      stats.by_severity[e.severity ?? "info"]             = (stats.by_severity[e.severity ?? "info"]             || 0) + 1;
      stats.by_division[e.division ?? "default"]          = (stats.by_division[e.division ?? "default"]          || 0) + 1;
      if (e.agent_id !== undefined) {
        stats.by_agent[e.agent_id] = (stats.by_agent[e.agent_id] || 0) + 1;
      }

      if (e.event_type === "task.task_completed" || e.event_type === "task.completed") stats.tasks_completed++;
      if (e.event_type === "task.task_failed"    || e.event_type === "task.failed")    stats.tasks_failed++;
      if (e.event_type === "governance.blocked")   stats.governance_blocks++;
      if (e.event_type === "budget.spent" && typeof e.metadata?.["amount_usd"] === "number") {
        stats.budget_total_usd += e.metadata["amount_usd"] as number;
      }
    }

    return stats;
  }

  private _buildSummary(events: ActivityRecord[], stats: DigestStats): DigestSummary {
    const divCount = Object.keys(stats.by_division).length;
    const headline = `${stats.total_events} event${stats.total_events !== 1 ? "s" : ""} across ${divCount} division${divCount !== 1 ? "s" : ""}`;

    // Top highlights: critical/error events first, then task completions/failures
    const highlights: string[] = [];
    const criticals = events.filter((e) => e.severity === "critical" || e.severity === "error");
    for (const c of criticals.slice(0, 3)) {
      highlights.push(`[${(c.severity ?? "error").toUpperCase()}] ${c.title}`);
    }
    if (stats.tasks_completed > 0) {
      highlights.push(`${stats.tasks_completed} task${stats.tasks_completed !== 1 ? "s" : ""} completed`);
    }
    if (stats.tasks_failed > 0) {
      highlights.push(`${stats.tasks_failed} task${stats.tasks_failed !== 1 ? "s" : ""} failed`);
    }

    // Warnings
    const warnings: string[] = [];
    if (stats.governance_blocks > 0) {
      warnings.push(`${stats.governance_blocks} governance block${stats.governance_blocks !== 1 ? "s" : ""}`);
    }
    if (stats.budget_total_usd > 0) {
      warnings.push(`Total spend: $${stats.budget_total_usd.toFixed(2)}`);
    }
    const errorCount = (stats.by_severity["error"] || 0) + (stats.by_severity["critical"] || 0);
    if (errorCount > 0) {
      warnings.push(`${errorCount} error/critical event${errorCount !== 1 ? "s" : ""}`);
    }

    return {
      headline,
      highlights: highlights.slice(0, 5),
      warnings,
      categories: { ...stats.by_category },
    };
  }
}


/** Module-level singleton. Call `digestEngine.init(db)` once at startup. */
export const digestEngine = new DigestEngine();
