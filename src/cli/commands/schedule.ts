// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: `sidjua schedule` commands
 *
 * CLI subcommands for cron schedule management.
 *   sidjua schedule list [--agent <id>] [--division <name>]
 *   sidjua schedule create --agent <id> --cron "<expr>" --task "<desc>" [opts]
 *   sidjua schedule enable <schedule-id>
 *   sidjua schedule disable <schedule-id>
 *   sidjua schedule delete <schedule-id> [--yes]
 *   sidjua schedule show <schedule-id>
 *   sidjua schedule history <schedule-id> [--last <n>]
 */

import { join }        from "node:path";
import type { Command } from "commander";
import { openDatabase } from "../../utils/db.js";
import { validateWorkDir } from "../../utils/path-utils.js";
import { CronScheduler } from "../../scheduler/cron-scheduler.js";
import { TaskStore }     from "../../tasks/store.js";
import { loadSchedulingGovernance } from "../../scheduler/config-loader.js";
import type { ScheduleDefinition } from "../../scheduler/types.js";
import { createLogger } from "../../core/logger.js";
import { BudgetTracker } from "../../agent-lifecycle/budget-tracker.js";
import { auditCliCommand } from "../cli-audit.js";

const logger = createLogger("schedule-cmd");


function openScheduler(workDir: string): { scheduler: CronScheduler; close: () => void } {
  validateWorkDir(workDir);
  const db      = openDatabase(join(workDir, ".system", "sidjua.db"));
  const gov     = loadSchedulingGovernance(workDir);
  const budgetTracker = new BudgetTracker(db);
  const budget = {
    canAfford: (amount: number, division?: string): boolean => {
      try {
        const result = budgetTracker.costTracker.checkBudget(division ?? "general", amount);
        return result.allowed;
      } catch (e: unknown) {
        // Fail closed: budget system unavailable → block scheduling
        logger.error("schedule-cmd", "Budget check failed — blocking schedule (budget system unavailable)", {
          metadata: { amount, division, error: e instanceof Error ? e.message : String(e) },
        });
        return false;
      }
    },
  };
  const scheduler = new CronScheduler(db, budget, gov);
  void scheduler.initialize();
  return { scheduler, close: () => db.close() };
}

function openStore(workDir: string): { store: TaskStore; close: () => void } {
  validateWorkDir(workDir);
  const db    = openDatabase(join(workDir, ".system", "sidjua.db"));
  const store = new TaskStore(db);
  store.initialize();
  return { store, close: () => db.close() };
}

/** Look up agent division from the agents table. Returns null if not found. */
function lookupAgentDivision(workDir: string, agentId: string): string | null {
  try {
    validateWorkDir(workDir);
    const db = openDatabase(join(workDir, ".system", "sidjua.db"));
    const row = db.prepare<[string], { division: string }>(
      "SELECT division FROM agents WHERE id = ?",
    ).get(agentId);
    db.close();
    return row?.division ?? null;
  } catch (_err) {
    return null;
  }
}

/** Pad string to fixed width. */
function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

/** Format ScheduleDefinition as a table row. */
function formatRow(s: ScheduleDefinition): string {
  const id      = pad(s.id.slice(0, 12), 13);
  const agent   = pad(s.agent_id.slice(0, 12), 13);
  const cron    = pad(s.cron_expression, 18);
  const desc    = pad(s.task_template.description.slice(0, 24), 25);
  const enabled = s.enabled ? "enabled " : "disabled";
  const next    = s.next_run_at.slice(0, 19).replace("T", " ");
  const runs    = String(s.total_runs).padStart(5);
  const cost    = `$${s.total_cost_usd.toFixed(4)}`;
  return `${id}${agent}${cron}${desc}${enabled}  ${next}  ${runs}  ${cost}`;
}

function formatHeader(): string {
  return [
    pad("ID", 13),
    pad("AGENT", 13),
    pad("CRON", 18),
    pad("DESCRIPTION", 25),
    "ENABLED   NEXT RUN             RUNS  COST",
  ].join("");
}


export function registerScheduleCommands(program: Command): void {
  const scheduleCmd = program
    .command("schedule")
    .description("Manage recurring cron schedules");

  // ── sidjua schedule list ─────────────────────────────────────────────────

  scheduleCmd
    .command("list")
    .description("List all schedules")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--agent <id>", "Filter by agent ID")
    .option("--division <name>", "Filter by division name")
    .option("--json", "Output as JSON", false)
    .action((opts: { workDir: string; agent?: string; division?: string; json: boolean }) => {
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        let schedules = scheduler.listSchedules(opts.agent);
        if (opts.division !== undefined) {
          schedules = schedules.filter((s) => s.division === opts.division);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(schedules, null, 2) + "\n");
        } else if (schedules.length === 0) {
          process.stdout.write("No schedules found.\n");
        } else {
          process.stdout.write(formatHeader() + "\n");
          process.stdout.write("─".repeat(110) + "\n");
          for (const s of schedules) {
            process.stdout.write(formatRow(s) + "\n");
          }
        }
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule create ───────────────────────────────────────────────

  scheduleCmd
    .command("create")
    .description("Create a new recurring schedule")
    .requiredOption("--agent <id>", "Agent ID")
    .requiredOption("--cron <expr>", "Cron expression (e.g. '*/10 * * * *')")
    .requiredOption("--task <desc>", "Task description")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--division <name>", "Division name (auto-detected from agent config if omitted)")
    .option("--budget <usd>", "Max cost per run in USD", parseFloat)
    .option("--priority <n>", "Task priority 1-5 (default: 5)", parseInt)
    .option("--ttl <seconds>", "Task TTL in seconds", parseInt)
    .option("--max-runs-day <n>", "Max runs per day (default: 24)", parseInt)
    .option("--require-approval", "Require approval for first run", false)
    .action((opts: {
      workDir: string; agent: string; cron: string; task: string;
      division?: string; budget?: number; priority?: number; ttl?: number;
      maxRunsDay?: number; requireApproval: boolean;
    }) => {
      const division = opts.division ?? lookupAgentDivision(opts.workDir, opts.agent);
      if (division === null) {
        process.stdout.write(
          `Error: could not determine division for agent '${opts.agent}'. ` +
          "Pass --division <name> explicitly.\n",
        );
        process.exit(1);
      }

      // Pre-creation budget check — fail-closed: if the budget system is
      // unavailable, block schedule creation rather than allowing unbounded spending.
      if (opts.budget !== undefined && opts.budget > 0) {
        const budgetDb = openDatabase(join(opts.workDir, ".system", "sidjua.db"));
        try {
          const bt     = new BudgetTracker(budgetDb);
          const result = bt.costTracker.checkBudget(division, opts.budget);
          if (!result.allowed) {
            process.stdout.write(
              `Error: Budget limit exceeded for division '${division}': ` +
              `${result.reason ?? "daily/monthly limit reached"}\n`,
            );
            process.exit(1);
          }
        } catch (e: unknown) {
          process.stdout.write(
            `Error: Budget check failed — schedule creation blocked (fail-closed). ` +
            `${e instanceof Error ? e.message : String(e)}\n`,
          );
          process.exit(1);
        } finally {
          budgetDb.close();
        }
      }

      auditCliCommand("schedule", "create");
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        const created = scheduler.createSchedule({
          agent_id:        opts.agent,
          division,
          cron_expression: opts.cron,
          task_template: {
            description:  opts.task,
            priority:     opts.priority ?? 5,
            ...(opts.budget !== undefined ? { budget_usd: opts.budget } : {}),
            ...(opts.ttl    !== undefined ? { ttl_seconds: opts.ttl }   : {}),
          },
          governance: {
            max_runs_per_day: opts.maxRunsDay ?? 24,
            require_approval: opts.requireApproval,
          },
        });
        process.stdout.write(`Schedule created: ${created.id}\n`);
        process.stdout.write(`  Agent:    ${created.agent_id}\n`);
        process.stdout.write(`  Division: ${created.division}\n`);
        process.stdout.write(`  Cron:     ${created.cron_expression}\n`);
        process.stdout.write(`  Task:     ${created.task_template.description}\n`);
        process.stdout.write(`  Next run: ${created.next_run_at}\n`);
      } catch (err: unknown) {
        logger.warn("schedule-cmd", "create failed", { metadata: {} });
        process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule enable ───────────────────────────────────────────────

  scheduleCmd
    .command("enable <schedule-id>")
    .description("Enable a disabled schedule")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((scheduleId: string, opts: { workDir: string }) => {
      auditCliCommand("schedule", "enable");
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        scheduler.enableSchedule(scheduleId);
        const updated = scheduler.getSchedule(scheduleId);
        process.stdout.write(`Schedule ${scheduleId} enabled. Next run: ${updated?.next_run_at ?? "unknown"}\n`);
      } catch (err: unknown) {
        process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule disable ──────────────────────────────────────────────

  scheduleCmd
    .command("disable <schedule-id>")
    .description("Disable a schedule (pauses automatic execution)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((scheduleId: string, opts: { workDir: string }) => {
      auditCliCommand("schedule", "disable");
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        scheduler.disableSchedule(scheduleId);
        process.stdout.write(`Schedule ${scheduleId} disabled.\n`);
      } catch (err: unknown) {
        process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule delete ───────────────────────────────────────────────

  scheduleCmd
    .command("delete <schedule-id>")
    .description("Delete a schedule permanently")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--yes", "Skip confirmation prompt", false)
    .action((scheduleId: string, opts: { workDir: string; yes: boolean }) => {
      if (!opts.yes) {
        process.stdout.write(
          `Are you sure you want to delete schedule '${scheduleId}'? Pass --yes to confirm.\n`,
        );
        process.exit(1);
      }
      auditCliCommand("schedule", "delete");
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        scheduler.deleteSchedule(scheduleId);
        process.stdout.write(`Schedule ${scheduleId} deleted.\n`);
      } catch (err: unknown) {
        process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule show ─────────────────────────────────────────────────

  scheduleCmd
    .command("show <schedule-id>")
    .description("Show full details of a schedule")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--json", "Output as JSON", false)
    .action((scheduleId: string, opts: { workDir: string; json: boolean }) => {
      const { scheduler, close } = openScheduler(opts.workDir);
      try {
        const sched = scheduler.getSchedule(scheduleId);
        if (sched === null) {
          process.stdout.write(`Error: schedule '${scheduleId}' not found.\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(sched, null, 2) + "\n");
        } else {
          process.stdout.write(`Schedule:   ${sched.id}\n`);
          process.stdout.write(`Agent:      ${sched.agent_id}\n`);
          process.stdout.write(`Division:   ${sched.division}\n`);
          process.stdout.write(`Cron:       ${sched.cron_expression}\n`);
          process.stdout.write(`Enabled:    ${sched.enabled}\n`);
          process.stdout.write(`Task:       ${sched.task_template.description}\n`);
          process.stdout.write(`Priority:   ${sched.task_template.priority ?? 5}\n`);
          if (sched.task_template.budget_usd !== undefined) {
            process.stdout.write(`Budget USD: $${sched.task_template.budget_usd}\n`);
          }
          if (sched.task_template.ttl_seconds !== undefined) {
            process.stdout.write(`TTL:        ${sched.task_template.ttl_seconds}s\n`);
          }
          process.stdout.write(`Max cost/run:     $${sched.governance.max_cost_per_run}\n`);
          process.stdout.write(`Max runs/day:     ${sched.governance.max_runs_per_day}\n`);
          process.stdout.write(`Require approval: ${sched.governance.require_approval}\n`);
          process.stdout.write(`Last run:   ${sched.last_run_at ?? "never"}\n`);
          process.stdout.write(`Next run:   ${sched.next_run_at}\n`);
          process.stdout.write(`Total runs: ${sched.total_runs}\n`);
          process.stdout.write(`Total cost: $${sched.total_cost_usd.toFixed(4)}\n`);
        }
      } finally {
        close();
      }
      process.exit(0);
    });

  // ── sidjua schedule history ──────────────────────────────────────────────

  scheduleCmd
    .command("history <schedule-id>")
    .description("Show execution history for a schedule")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--last <n>", "Show last N executions (default: 10)", parseInt)
    .option("--json", "Output as JSON", false)
    .action((scheduleId: string, opts: { workDir: string; last?: number; json: boolean }) => {
      const { store, close } = openStore(opts.workDir);
      try {
        const limit   = opts.last ?? 10;
        const tasks   = store.getByScheduleId(scheduleId).slice(0, limit);
        if (opts.json) {
          process.stdout.write(JSON.stringify(tasks, null, 2) + "\n");
          return;
        }
        if (tasks.length === 0) {
          process.stdout.write("No executions found.\n");
          return;
        }
        process.stdout.write(
          pad("TASK ID", 38) + pad("STATUS", 12) + pad("STARTED", 22) + pad("COST", 12) + "DURATION\n",
        );
        process.stdout.write("─".repeat(100) + "\n");
        for (const t of tasks) {
          const duration = (t.started_at && t.completed_at)
            ? `${Math.round((new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 1000)}s`
            : "—";
          process.stdout.write(
            pad(t.id, 38) +
            pad(t.status, 12) +
            pad(t.started_at?.slice(0, 19).replace("T", " ") ?? "—", 22) +
            pad(`$${t.cost_used.toFixed(4)}`, 12) +
            duration + "\n",
          );
        }
      } finally {
        close();
      }
      process.exit(0);
    });
}
