// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: CLI Commands
 *
 * sidjua activity [--since] [--until] [--category] [--agent] [--division] [--severity] [--limit]
 * sidjua digest daily   [--date <YYYY-MM-DD>] [--division]
 * sidjua digest weekly  [--week-start <YYYY-MM-DD>] [--division]
 * sidjua digest agent   <agentId> [--since] [--until]
 * sidjua digest division <divisionId> [--since] [--until]
 * sidjua activity-status
 *
 * All commands open the local SQLite database directly (no IPC required).
 */

import type { Command }          from "commander";
import { join }                  from "node:path";
import { openDatabase }          from "../../utils/db.js";
import { runActivityMigrations } from "../../core/activity/activity-migrations.js";
import { ActivityEmitter }       from "../../core/activity/activity-emitter.js";
import { DigestEngine }          from "../../core/activity/digest-engine.js";
import type { ActivityFilters }  from "../../core/activity/activity-types.js";
import type { DigestResult }     from "../../core/activity/digest-engine.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yesterdayStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0] ?? "";
}

function lastMondayStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().split("T")[0] ?? "";
}

function openActivityDb(workDir: string): { emitter: ActivityEmitter; digest: DigestEngine; close: () => void } {
  const systemDir = join(workDir, ".system");
  const db        = openDatabase(join(systemDir, "sidjua.db"));
  runActivityMigrations(db);
  const emitter = new ActivityEmitter();
  emitter.init(db);
  const digest = new DigestEngine();
  digest.init(db);
  return {
    emitter,
    digest,
    close: () => { try { db.close(); } catch (_e) { /* ignore */ } },
  };
}

function printDigest(digest: DigestResult): void {
  process.stdout.write(`\n=== ${digest.digest_type.toUpperCase()} DIGEST ===\n`);
  process.stdout.write(`Period:  ${digest.period_start.replace("T", " ").replace("Z", " UTC")} → ${digest.period_end.replace("T", " ").replace("Z", " UTC")}\n`);
  process.stdout.write(`Events:  ${digest.event_count}\n`);
  process.stdout.write(`\n${digest.summary.headline}\n`);

  if (digest.summary.highlights.length > 0) {
    process.stdout.write("\nHighlights:\n");
    for (const h of digest.summary.highlights) {
      process.stdout.write(`  • ${h}\n`);
    }
  }
  if (digest.summary.warnings.length > 0) {
    process.stdout.write("\nWarnings:\n");
    for (const w of digest.summary.warnings) {
      process.stdout.write(`  ⚠ ${w}\n`);
    }
  }
  if (digest.stats.budget_total_usd > 0) {
    process.stdout.write(`\nBudget spent: $${digest.stats.budget_total_usd.toFixed(2)}\n`);
  }
  if (Object.keys(digest.summary.categories).length > 0) {
    process.stdout.write("\nBy category:\n");
    for (const [cat, count] of Object.entries(digest.summary.categories).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${cat.padEnd(14)} ${count}\n`);
    }
  }
  process.stdout.write("\n");
}

function workDirOpt(cmd: Command): string {
  // Walk up the command tree to find --work-dir
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = cmd;
  while (node !== undefined) {
    if (typeof node.opts?.()?.workDir === "string") return node.opts().workDir as string;
    node = node.parent as typeof node | undefined;
  }
  return process.cwd();
}


// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerActivityCommands(program: Command): void {

  // ── sidjua activity ──────────────────────────────────────────────────────
  program
    .command("activity")
    .description("Query the activity stream")
    .option("--since <datetime>",  "Start time (ISO 8601)")
    .option("--until <datetime>",  "End time (ISO 8601)")
    .option("--category <cat>",    "Filter by category (task|agent|chat|governance|...)")
    .option("--agent <id>",        "Filter by agent ID")
    .option("--division <name>",   "Filter by division")
    .option("--severity <level>",  "Filter by severity (debug|info|warning|error|critical)")
    .option("--limit <n>",         "Max results", "20")
    .action((opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { emitter, close } = openActivityDb(workDir);
      try {
        const filters: ActivityFilters = {
          since:     opts.since    || undefined,
          until:     opts.until    || undefined,
          category:  opts.category as ActivityFilters["category"] || undefined,
          agent_id:  opts.agent    || undefined,
          division:  opts.division || undefined,
          severity:  opts.severity as ActivityFilters["severity"] || undefined,
          limit:     Math.min(parseInt(opts.limit as string, 10) || 20, 1000),
        };

        const events = emitter.query(filters);
        if (events.length === 0) {
          process.stdout.write("No activity events found.\n");
          return;
        }

        for (const e of events) {
          const sev = (e.severity === "error" || e.severity === "critical") ? `[${e.severity.toUpperCase()}] ` : "";
          process.stdout.write(`${e.timestamp}  ${sev}${e.category}/${e.event_type}  ${e.title}\n`);
          if (e.agent_id !== undefined) {
            process.stdout.write(`  agent: ${e.agent_id}  division: ${e.division}\n`);
          }
        }
        process.stdout.write(`\n${events.length} event(s) shown.\n`);
      } finally {
        close();
      }
    });


  // ── sidjua digest ────────────────────────────────────────────────────────
  const digestCmd = program
    .command("digest")
    .description("Generate activity digests");

  digestCmd
    .command("daily")
    .description("Daily digest for a given date")
    .option("--date <YYYY-MM-DD>",  "Date (default: yesterday)")
    .option("--division <name>",    "Scope to a single division")
    .action((opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { digest, close } = openActivityDb(workDir);
      try {
        const date     = (opts.date as string | undefined) || yesterdayStr();
        const division = opts.division as string | undefined;
        printDigest(digest.generateDaily(date, division));
      } finally {
        close();
      }
    });

  digestCmd
    .command("weekly")
    .description("Weekly digest for the 7 days starting at week-start")
    .option("--week-start <YYYY-MM-DD>", "Week start (default: last Monday)")
    .option("--division <name>",         "Scope to a single division")
    .action((opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { digest, close } = openActivityDb(workDir);
      try {
        const weekStart = (opts.weekStart as string | undefined) || lastMondayStr();
        const division  = opts.division as string | undefined;
        printDigest(digest.generateWeekly(weekStart, division));
      } finally {
        close();
      }
    });

  digestCmd
    .command("agent <agentId>")
    .description("Drilldown digest for a single agent")
    .option("--since <datetime>",  "Start time (default: yesterday 00:00 UTC)")
    .option("--until <datetime>",  "End time (default: now)")
    .action((agentId: string, opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { digest, close } = openActivityDb(workDir);
      try {
        const since = (opts.since as string | undefined) || yesterdayStr() + "T00:00:00.000Z";
        const until = (opts.until as string | undefined) || new Date().toISOString();
        printDigest(digest.generateAgentDrilldown(agentId, since, until));
      } finally {
        close();
      }
    });

  digestCmd
    .command("division <divisionId>")
    .description("Drilldown digest for a single division")
    .option("--since <datetime>",  "Start time (default: yesterday 00:00 UTC)")
    .option("--until <datetime>",  "End time (default: now)")
    .action((divisionId: string, opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { digest, close } = openActivityDb(workDir);
      try {
        const since = (opts.since as string | undefined) || yesterdayStr() + "T00:00:00.000Z";
        const until = (opts.until as string | undefined) || new Date().toISOString();
        printDigest(digest.generateDivisionDrilldown(divisionId, since, until));
      } finally {
        close();
      }
    });


  // ── sidjua activity-status ───────────────────────────────────────────────
  program
    .command("activity-status")
    .description("Show today's activity summary")
    .action((_opts, cmd) => {
      const workDir = workDirOpt(cmd);
      const { emitter, close } = openActivityDb(workDir);
      try {
        const now        = new Date();
        const todayStart = now.toISOString().split("T")[0] + "T00:00:00.000Z";
        const total      = emitter.count({ since: todayStart });
        const errors     = emitter.count({ since: todayStart, severity: "error"    });
        const criticals  = emitter.count({ since: todayStart, severity: "critical" });
        const recent     = emitter.query({ limit: 5 });

        process.stdout.write(`SIDJUA Activity — ${now.toISOString()}\n`);
        process.stdout.write(`Today: ${total} events`);
        if (errors    > 0) process.stdout.write(`, ${errors} errors`);
        if (criticals > 0) process.stdout.write(`, ${criticals} critical`);
        process.stdout.write("\n");

        if (recent.length > 0) {
          process.stdout.write("\nRecent:\n");
          for (const e of recent) {
            process.stdout.write(`  ${e.timestamp}  ${e.category}/${e.event_type}  ${e.title}\n`);
          }
        }
      } finally {
        close();
      }
    });
}
