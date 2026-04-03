// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua run` command
 *
 * Submit a task to the orchestrator.
 *   sidjua run <description>              — submit and return immediately
 *   sidjua run --file <task.yaml>         — submit from YAML file
 *   sidjua run ... --wait                 — submit and poll until complete
 *   sidjua run ... --wait --timeout 60   — poll with custom timeout (seconds)
 *
 * ALL execution paths route through the orchestrator governance pipeline.
 * Direct in-process agent execution was removed in P268 because it bypassed
 * governance, budget enforcement, and audit logging.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "../../tasks/store.js";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { TaskManager } from "../../tasks/task-manager.js";
import { getSanitizer } from "../../core/input-sanitizer.js";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import { isProcessAlive } from "../utils/process.js";
import { TaskPriority } from "../../pipeline/types.js";
import { formatJson } from "../formatters/json.js";
import { formatBytes } from "../utils/format.js";
import { parse as parseYaml } from "yaml";
import { runMigrations105 } from "../../agent-lifecycle/index.js";
import { createLogger } from "../../core/logger.js";
import { TaskAdmissionGate } from "../../orchestrator/task-admission-gate.js";

const logger = createLogger("run-cmd");


export interface RunCommandOptions {
  workDir:    string;
  description: string | undefined;
  file:       string | undefined;
  priority:   string;  // "urgent" | "regular" | "low" | "critical" | "background"
  division:   string | undefined;
  budget:     number | undefined;
  costLimit:  number | undefined;
  tier:       number;
  wait:       boolean;
  timeout:    number;
  json:       boolean;
}

interface TaskYaml {
  title:        string;
  description:  string;
  priority?:    string;
  division?:    string;
  budget?: {
    tokens?:   number;
    cost_usd?: number;
  };
  tier?:        number;
  metadata?:    Record<string, unknown>;
}


export async function runRunCommand(opts: RunCommandOptions): Promise<number> {
  const pidFile = join(opts.workDir, ".system", "orchestrator.pid");

  // ── Require orchestrator for ALL modes (including --wait) ─────────────────
  // run --wait previously bypassed the orchestrator via inline execution.
  // All task execution now routes through the governance pipeline.

  if (!existsSync(pidFile)) {
    process.stderr.write("✗ Orchestrator not running. Start with: sidjua start\n");
    return 1;
  }

  const pidText = readFileSync(pidFile, "utf8").trim();
  const pid     = parseInt(pidText, 10);
  if (!isNaN(pid) && !isProcessAlive(pid)) {
    process.stderr.write("✗ Orchestrator not running (stale PID file). Start with: sidjua start\n");
    return 1;
  }

  // ── Parse task ────────────────────────────────────────────────────────────

  let title:       string;
  let description: string;
  let priority:    string  = opts.priority;
  let division:    string  = opts.division ?? "general";
  let tokenBudget: number  = opts.budget    ?? 100_000;
  let costBudget:  number  = opts.costLimit ?? 5.0;
  let tier:        1|2|3   = Math.min(3, Math.max(1, opts.tier)) as 1|2|3;

  if (opts.file !== undefined) {
    // Load from YAML file
    if (!existsSync(opts.file)) {
      process.stderr.write(`✗ Task file not found: ${opts.file}\n`);
      return 1;
    }

    const MAX_PROMPT_SIZE = 1 * 1024 * 1024; // 1 MB
    const promptFileStats = statSync(opts.file);
    if (promptFileStats.size > MAX_PROMPT_SIZE) {
      process.stderr.write(`✗ Task file too large: ${formatBytes(promptFileStats.size)} exceeds ${formatBytes(MAX_PROMPT_SIZE)} limit
`);
      return 1;
    }
    const raw = readFileSync(opts.file, "utf8");
    let yaml: TaskYaml;
    try {
      yaml = parseYaml(raw) as TaskYaml;
    } catch (err) {
      process.stderr.write(`✗ Invalid task YAML: ${String(err)}\n`);
      return 1;
    }

    if (yaml === null || typeof yaml !== "object" || Array.isArray(yaml)) {
      process.stderr.write("✗ Task file must be a YAML object (key-value map)\n");
      return 1;
    }

    // Type-check known fields
    if ("title" in yaml && typeof yaml.title !== "string") {
      process.stderr.write(`✗ Invalid task YAML: 'title' must be a string, got ${typeof yaml.title}\n`);
      return 1;
    }
    if ("description" in yaml && typeof yaml.description !== "string") {
      process.stderr.write(`✗ Invalid task YAML: 'description' must be a string, got ${typeof yaml.description}\n`);
      return 1;
    }
    if ("priority" in yaml && yaml.priority !== undefined && typeof yaml.priority !== "number" && typeof yaml.priority !== "string") {
      process.stderr.write(`✗ Invalid task YAML: 'priority' must be a number or string, got ${typeof yaml.priority}\n`);
      return 1;
    }

    // Warn on unknown fields (forward-compat: don't reject)
    const KNOWN_FIELDS = new Set(["title", "description", "priority", "division", "budget", "tier", "metadata"]);
    const unknown = Object.keys(yaml as object).filter((k) => !KNOWN_FIELDS.has(k));
    if (unknown.length > 0) {
      process.stderr.write(`⚠ Unknown field(s) in task YAML (ignored): ${unknown.join(", ")}\n`);
    }

    title       = yaml.title        ?? "Untitled task";
    description = yaml.description  ?? "";
    if (yaml.priority !== undefined)    priority    = yaml.priority;
    if (yaml.division !== undefined)    division    = yaml.division;
    if (yaml.budget?.tokens !== undefined) tokenBudget = yaml.budget.tokens;
    if (yaml.budget?.cost_usd !== undefined) costBudget = yaml.budget.cost_usd;
    if (yaml.tier !== undefined)        tier        = Math.min(3, Math.max(1, yaml.tier)) as 1|2|3;
  } else if (opts.description !== undefined) {
    const MAX_INLINE_BYTES = 100 * 1024; // 100 KB
    if (Buffer.byteLength(opts.description, "utf8") > MAX_INLINE_BYTES) {
      process.stderr.write(
        "✗ Task description exceeds 100KB limit. Use --file for larger tasks.\n",
      );
      return 1;
    }
    title       = opts.description.slice(0, 80);
    description = opts.description;
  } else {
    process.stderr.write("✗ Provide a description or --file <task.yaml>\n");
    return 1;
  }

  // ── Map priority string to enum ───────────────────────────────────────────

  const priorityMap: Record<string, TaskPriority> = {
    critical:   TaskPriority.CRITICAL,
    urgent:     TaskPriority.URGENT,
    regular:    TaskPriority.REGULAR,
    low:        TaskPriority.LOW,
    background: TaskPriority.BACKGROUND,
  };

  const taskPriority = priorityMap[priority.toLowerCase()] ?? TaskPriority.REGULAR;

  // ── Create task ───────────────────────────────────────────────────────────

  return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
    // Run agent-lifecycle migrations so agent_definitions table exists
    try { runMigrations105(db); } catch (e: unknown) {
      logger.debug("run-cmd", "runMigrations105 failed — may already be applied", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }

    const store    = new TaskStore(db);
    store.initialize();
    const eventBus = new TaskEventBus(db);

    // Governance admission gate — must pass before task creation
    const gate = new TaskAdmissionGate(db);
    const admission = gate.admitTask({
      description,
      division,
      budget_usd: costBudget,
      caller:     "cli",
    });
    if (!admission.admitted) {
      process.stderr.write(`✗ Task denied by governance: ${admission.reason}\n`);
      return 1;
    }
    // Consume the single-use admission token before proceeding.
    // verifyAndConsumeToken() atomically removes the token from the in-process
    // store and confirms it has not expired — preventing any replay of the same
    // token if a second task creation is attempted after admission.
    if (!gate.verifyAndConsumeToken(admission.token)) {
      process.stderr.write("✗ Admission token expired or already consumed — please retry.\n");
      return 1;
    }

    // Route task creation through TaskManager to enforce input sanitization
    const manager = new TaskManager(store, getSanitizer());
    const task = manager.createTask({
      title,
      description,
      division,
      type:         "root",
      tier,
      token_budget: tokenBudget,
      cost_budget:  costBudget,
    });

    if (opts.json) {
      process.stdout.write(formatJson({ task_id: task.id, status: "submitted" }) + "\n");
    } else {
      process.stdout.write(`Task submitted: ${task.id}\n`);
      process.stdout.write(`Priority: ${priority}\n`);
      process.stdout.write(`Division: ${division}\n`);
    }

    // Emit TASK_CREATED so the running orchestrator picks it up
    void eventBus.emitTask({
      event_type:     "TASK_CREATED",
      task_id:        task.id,
      parent_task_id: null,
      agent_from:     null,
      agent_to:       null,
      division:       task.division,
      data:           { priority: taskPriority },
    });

    // Keep DB open through the entire pollTaskCompletion lifecycle.
    // withCliDatabaseAsync closes the DB only after this callback fully resolves.
    let exitCode = 0;
    if (opts.wait) {
      exitCode = await pollTaskCompletion(task.id, opts, store);
    } else {
      if (!opts.json) {
        process.stdout.write(`Use 'sidjua tasks ${task.id}' to track progress.\n`);
      }
    }
    return exitCode;
  });
}


/**
 * Poll task status with exponential backoff until a terminal state or timeout.
 *
 * Terminal states: DONE, FAILED, CANCELLED, ESCALATED
 * Returns 0 on DONE, 1 on failure, timeout, or SIGINT.
 *
 * Backoff: starts at 1s, doubles each iteration, caps at 5s.
 * Ctrl+C is intercepted for a clean exit message instead of a stack trace.
 */
async function pollTaskCompletion(
  taskId:  string,
  opts:    RunCommandOptions,
  store:   TaskStore,
): Promise<number> {
  const INITIAL_INTERVAL_MS = 1_000;
  const MAX_INTERVAL_MS     = 5_000;
  const deadline            = Date.now() + opts.timeout * 1_000;

  if (!opts.json) {
    process.stdout.write(`Waiting for task ${taskId} (timeout: ${opts.timeout}s)…\n`);
  }

  let interrupted = false;
  const onSigint = (): void => { interrupted = true; };
  process.once("SIGINT", onSigint);

  let intervalMs = INITIAL_INTERVAL_MS;

  try {
    while (Date.now() < deadline && !interrupted) {
      const current = store.get(taskId);
      if (current !== null) {
        const { status } = current;

        if (status === "DONE") {
          if (opts.json) {
            process.stdout.write(formatJson({ task_id: taskId, status: "done", result: current.result_summary }) + "\n");
          } else {
            process.stdout.write(`✓ Task complete: ${taskId}\n`);
            if (current.result_summary) {
              process.stdout.write(`  Result: ${current.result_summary}\n`);
            }
          }
          return 0;
        }

        if (status === "FAILED") {
          if (opts.json) {
            process.stdout.write(formatJson({ task_id: taskId, status: "failed", error: current.result_summary }) + "\n");
          } else {
            process.stderr.write(`✗ Task failed: ${taskId}\n`);
            if (current.result_summary) {
              process.stderr.write(`  Error: ${current.result_summary}\n`);
            }
          }
          return 1;
        }

        if (status === "CANCELLED") {
          process.stderr.write(`✗ Task cancelled: ${taskId}\n`);
          return 1;
        }

        if (status === "ESCALATED") {
          process.stderr.write(`✗ Task escalated (requires human review): ${taskId}\n`);
          return 1;
        }
      }

      await sleep(Math.min(intervalMs, deadline - Date.now()));
      // Exponential backoff: double interval each cycle, cap at MAX_INTERVAL_MS
      intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (interrupted) {
    process.stderr.write(`\n✗ Interrupted. Task ${taskId} is still running.\n`);
    process.stderr.write(`  Use 'sidjua tasks ${taskId}' to check current status.\n`);
    return 1;
  }

  process.stderr.write(
    `✗ Task timed out after ${opts.timeout}s. Task ID: ${taskId}\n` +
    `  Use 'sidjua tasks ${taskId}' to check current status.\n`,
  );
  return 1;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
