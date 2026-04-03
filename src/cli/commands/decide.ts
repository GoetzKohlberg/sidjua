// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua decide` command
 *
 * Handle human decisions for escalated tasks.
 *   sidjua decide              — list pending decisions
 *   sidjua decide <id>         — show decision detail
 *   sidjua decide <id> --action retry|cancel|reassign|resolve
 */

import { existsSync, readFileSync } from "node:fs";
import { join }       from "node:path";
import { openDatabase }    from "../../utils/db.js";
import { validateWorkDir } from "../../utils/path-utils.js";
import { openCliDatabase } from "../utils/db-init.js";
import { formatAge } from "../utils/format.js";
import { sendIpc } from "../ipc-client.js";
import { formatTable } from "../formatters/table.js";
import { formatJson } from "../formatters/json.js";
import { createLogger } from "../../core/logger.js";
import { auditCliCommand } from "../cli-audit.js";

const logger = createLogger("decide-cmd");


export interface DecideCommandOptions {
  workDir:     string;
  taskId:      string | undefined;
  action:      string | undefined;
  guidance:    string | undefined;
  agentId:     string | undefined;
  result:      string | undefined;
  resultFile:  string | undefined;
  json:        boolean;
}

interface HumanDecisionRow {
  id:         number;
  task_id:    string;
  reason:     string;
  options:    string;
  decision:   string | null;
  guidance:   string | null;
  decided_at: string | null;
  created_at: string;
  title?:     string; // joined from tasks
}

interface EscalationLogRow {
  task_id:    string;
  from_agent: string;
  from_tier:  number;
  to_tier:    number;
  reason:     string;
  created_at: string;
}


export async function runDecideCommand(opts: DecideCommandOptions): Promise<number> {
  const sockFile = join(opts.workDir, ".system", "orchestrator.sock");

  const db = openCliDatabase({ workDir: opts.workDir });
  if (!db) return 1;

  try {
    // ── List mode ──────────────────────────────────────────────────────────

    if (opts.taskId === undefined) {
      return listPendingDecisions(opts, db);
    }

    // ── Respond to a specific decision ─────────────────────────────────────

    if (opts.action !== undefined) {
      return await respondToDecision(opts, db, sockFile);
    }

    // ── Detail view ────────────────────────────────────────────────────────

    return showDecisionDetail(opts, db);
  } finally {
    db.close();
  }
}


function listPendingDecisions(
  opts: DecideCommandOptions,
  db:   import("../../utils/db.js").Database,
): number {
  let rows: HumanDecisionRow[] = [];

  try {
    rows = db.prepare<[], HumanDecisionRow & { title: string }>(
      `SELECT hd.*, t.title
       FROM human_decisions hd
       JOIN tasks t ON hd.task_id = t.id
       WHERE hd.decided_at IS NULL
       ORDER BY hd.created_at ASC`,
    ).all();
  } catch (e: unknown) {
    logger.debug("decide-cmd", "Decision/tasks tables not found — no pending decisions (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    rows = [];
  }

  if (opts.json) {
    process.stdout.write(formatJson(rows) + "\n");
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write("No pending human decisions.\n");
    return 0;
  }

  process.stdout.write(`PENDING HUMAN DECISIONS (${rows.length})\n\n`);

  const now = Date.now();
  const tableRows = rows.map((r) => ({
    id:     r.task_id.slice(-16),
    since:  formatAge(r.created_at, now),
    reason: r.reason.replace(/_/g, " "),
    title:  (r.title ?? "").slice(0, 40),
  }));

  const out = formatTable(tableRows, {
    columns: [
      { header: "ID",     key: "id"     },
      { header: "SINCE",  key: "since"  },
      { header: "REASON", key: "reason" },
      { header: "TASK TITLE", key: "title" },
    ],
    maxWidth: 200,
  });

  process.stdout.write(out + "\n\n");
  process.stdout.write(
    "Use 'sidjua decide <id>' for details, or 'sidjua decide <id> --action retry' to respond.\n",
  );

  return 0;
}


function showDecisionDetail(
  opts: DecideCommandOptions,
  db:   import("../../utils/db.js").Database,
): number {
  const taskId = opts.taskId!;

  let decision: HumanDecisionRow | undefined;
  try {
    decision = db.prepare<[string], HumanDecisionRow>(
      "SELECT * FROM human_decisions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(taskId);
  } catch (e: unknown) {
    logger.debug("decide-cmd", "human_decisions table not found — no decisions to approve (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  if (decision === undefined) {
    process.stderr.write(`✗ No pending decision for task: ${taskId}\n`);
    return 1;
  }

  let escalationLog: EscalationLogRow | undefined;
  try {
    escalationLog = db.prepare<[string], EscalationLogRow>(
      "SELECT * FROM escalation_log WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(taskId);
  } catch (e: unknown) {
    logger.debug("decide-cmd", "escalation_log table not found — no escalations to record (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  // Fetch task title
  let taskTitle = "";
  try {
    const taskRow = db.prepare<[string], { title: string }>(
      "SELECT title FROM tasks WHERE id = ?",
    ).get(taskId);
    taskTitle = taskRow?.title ?? "";
  } catch (e: unknown) {
    logger.debug("decide-cmd", "tasks table not found — could not update task status (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  if (opts.json) {
    process.stdout.write(formatJson({ decision, escalation: escalationLog }) + "\n");
    return 0;
  }

  const now = Date.now();

  process.stdout.write(`ESCALATED TASK: ${taskId}\n`);
  process.stdout.write(`Title: ${taskTitle}\n`);
  process.stdout.write(`Reason: ${decision.reason.replace(/_/g, " ")}\n`);

  if (escalationLog !== undefined) {
    process.stdout.write(`Tier path: T${escalationLog.from_tier} → T${escalationLog.to_tier}\n`);
    process.stdout.write(`From agent: ${escalationLog.from_agent}\n`);
  }

  process.stdout.write(`Escalated: ${formatAge(decision.created_at, now)}\n`);
  process.stdout.write("\nOptions:\n");
  process.stdout.write("  --action retry      Retry with additional guidance\n");
  process.stdout.write("  --action cancel     Cancel this task and sub-tree\n");
  process.stdout.write("  --action reassign   Assign to a different agent\n");
  process.stdout.write("  --action resolve    Provide the result yourself\n");

  return 0;
}


async function respondToDecision(
  opts:     DecideCommandOptions,
  db:       import("../../utils/db.js").Database,
  sockFile: string,
): Promise<number> {
  const taskId = opts.taskId!;
  const action = opts.action!;

  // Validate action
  const validActions = ["retry", "cancel", "reassign", "resolve"];
  if (!validActions.includes(action)) {
    process.stderr.write(`✗ Invalid action: ${action}. Choose from: ${validActions.join(", ")}\n`);
    return 1;
  }
  auditCliCommand("decide", "action");

  // Read result from file if --result-file
  let result = opts.result;
  if (opts.resultFile !== undefined) {
    if (!existsSync(opts.resultFile)) {
      process.stderr.write(`✗ Result file not found: ${opts.resultFile}\n`);
      return 1;
    }
    result = readFileSync(opts.resultFile, "utf8");
  }

  // Try IPC first (orchestrator running)
  if (existsSync(sockFile)) {
    try {
      const resp = await sendIpc(sockFile, {
        command:    "decide",
        payload:    {
          task_id:  taskId,
          action,
          guidance: opts.guidance,
          agent_id: opts.agentId,
          result,
        },
        request_id: crypto.randomUUID(),
      });

      if (!resp.success) {
        process.stderr.write(`✗ Decision failed: ${resp.error ?? "unknown"}\n`);
        return 1;
      }

      process.stdout.write(`✓ Decision recorded. Task ${taskId} requeued with action: ${action}\n`);
      return 0;
    } catch (e: unknown) {
      logger.warn("decide-cmd", "Orchestrator IPC not reachable — falling through to direct DB write", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // Direct DB write (orchestrator not running)
  // Open a dedicated write connection instead of toggling query_only on
  // the shared read connection — toggling a global PRAGMA is not thread-safe
  // and risks opening a write window on the shared read-only handle.
  validateWorkDir(opts.workDir);
  const dbFile = join(opts.workDir, ".system", "sidjua.db");
  const writeDb = openDatabase(dbFile);
  writeDb.pragma("journal_mode = WAL");

  try {
    const now = new Date().toISOString();
    writeDb.prepare<unknown[], void>(
      `UPDATE human_decisions
       SET decision = ?, guidance = ?, decided_at = ?
       WHERE task_id = ? AND decided_at IS NULL`,
    ).run(action, opts.guidance ?? null, now, taskId);

    process.stdout.write(`✓ Decision recorded (offline): task ${taskId}, action: ${action}\n`);
    process.stdout.write("  Decision will take effect when orchestrator starts.\n");
    return 0;
  } catch (err) {
    process.stderr.write(`✗ Failed to record decision: ${String(err)}\n`);
    return 1;
  } finally {
    writeDb.close();
  }
}


