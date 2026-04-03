// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13c: Task monitor CLI commands
 *
 * sidjua task <id> --watch    — live progress display
 * sidjua task <id> --result   — full result of completed task
 * sidjua task <id> --tree     — delegation tree ASCII
 * sidjua task <id> --cancel   — cancel task + sub-tasks
 *
 * These extend the existing `sidjua task stop <id>` command from Phase 10.
 */

import { join }            from "node:path";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import type Database       from "better-sqlite3";
import { TaskStore }       from "../../tasks/store.js";
import { TaskEventBus }    from "../../tasks/event-bus.js";
import { ExecutionBridge } from "../../orchestrator/execution-bridge.js";
import type { TaskTreeNode } from "../../orchestrator/execution-bridge.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("task-monitor");


export interface TaskMonitorOptions {
  workDir:  string;
  taskId:   string;
  watch:    boolean;
  result:   boolean;
  tree:     boolean;
  cancel:   boolean;
  json:     boolean;
  timeout:  number;
}


export async function runTaskMonitorCommand(opts: TaskMonitorOptions): Promise<number> {
  return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
    const store  = new TaskStore(db);
    const bridge = new ExecutionBridge(db);

    if (opts.cancel) {
      return await handleCancel(opts.taskId, store, bridge, db, opts.json);
    }

    if (opts.tree) {
      return await handleTree(opts.taskId, bridge, opts.json);
    }

    if (opts.result) {
      return handleResult(opts.taskId, store, opts.json);
    }

    if (opts.watch) {
      return await handleWatch(opts.taskId, store, opts.timeout);
    }

    // Default: show current status
    return handleStatus(opts.taskId, store, opts.json);
  });
}


async function handleCancel(
  taskId: string,
  store:  TaskStore,
  bridge: ExecutionBridge,
  db:     InstanceType<typeof Database>,
  json:   boolean,
): Promise<number> {
  const task = store.get(taskId);
  if (task === null) {
    process.stderr.write(`✗ Task not found: ${taskId}\n`);
    return 1;
  }

  const TERMINAL = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);
  if (TERMINAL.has(task.status)) {
    if (json) {
      process.stdout.write(JSON.stringify({ cancelled: false, reason: `already ${task.status}` }) + "\n");
    } else {
      process.stdout.write(`Task ${taskId} is already in terminal state: ${task.status}\n`);
    }
    return 0;
  }

  // Cancel all tasks in the tree
  const allTasks = store.getByRoot(taskId);
  let count = 0;
  for (const t of allTasks) {
    if (!TERMINAL.has(t.status)) {
      store.update(t.id, { status: "CANCELLED" });
      count++;
    }
  }

  const eventBus = new TaskEventBus(db);
  await eventBus.emitTask({
    event_type:     "TASK_FAILED",
    task_id:        taskId,
    parent_task_id: null,
    agent_from:     "cli",
    agent_to:       null,
    division:       task.division,
    data:           { reason: "user_cancelled", cancelled_count: count },
  });

  if (json) {
    process.stdout.write(JSON.stringify({ cancelled: true, tasks_cancelled: count }) + "\n");
  } else {
    process.stdout.write(`✓ Cancelled task ${taskId} (${count} task${count !== 1 ? "s" : ""})\n`);
  }

  return 0;
}


async function handleTree(
  taskId: string,
  bridge: ExecutionBridge,
  json:   boolean,
): Promise<number> {
  let tree: TaskTreeNode;
  try {
    tree = await bridge.getTaskTree(taskId);
  } catch (e: unknown) {
    logger.warn("task-monitor", "Task lookup failed — task may not exist or bridge unavailable", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    process.stderr.write(`✗ Task not found: ${taskId}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
    return 0;
  }

  const lines = renderTree(tree, "", true);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function renderTree(node: TaskTreeNode, prefix: string, isRoot: boolean): string[] {
  const lines: string[] = [];
  const costStr   = node.cost_usd !== undefined ? ` ($${node.cost_usd.toFixed(4)})` : "";
  const agentStr  = node.agent !== undefined ? ` T${node.tier} ${node.agent}` : "";
  const header    = isRoot
    ? `Task: "${node.title}" [${node.status}]${costStr}`
    : `"${node.title}" [${node.status}]${agentStr}${costStr}`;

  lines.push(prefix + header);

  for (let i = 0; i < node.children.length; i++) {
    const child    = node.children[i]!;
    const isLast   = i === node.children.length - 1;
    const branch   = isLast ? "└── " : "├── ";
    const childPfx = isLast ? "    " : "│   ";
    const childLines = renderTree(child, prefix + childPfx, false);
    // Replace first line's prefix with branch
    lines.push(prefix + branch + childLines[0]!.trimStart());
    lines.push(...childLines.slice(1));
  }

  return lines;
}


function handleResult(taskId: string, store: TaskStore, json: boolean): number {
  const task = store.get(taskId);
  if (task === null) {
    process.stderr.write(`✗ Task not found: ${taskId}\n`);
    return 1;
  }

  const TERMINAL = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);

  if (!TERMINAL.has(task.status)) {
    if (json) {
      process.stdout.write(JSON.stringify({ task_id: taskId, status: task.status, message: "still running" }) + "\n");
    } else {
      process.stdout.write(`Task ${taskId} is still running (status: ${task.status})\n`);
      process.stdout.write(`Use 'sidjua task ${taskId} --watch' to monitor progress.\n`);
    }
    return 0;
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      task_id:        taskId,
      status:         task.status,
      result_summary: task.result_summary,
      result_file:    task.result_file,
      confidence:     task.confidence,
      tokens_used:    task.token_used,
      cost_usd:       task.cost_used,
    }) + "\n");
    return 0;
  }

  process.stdout.write(`Task: ${taskId}\n`);
  process.stdout.write(`Status: ${task.status}\n`);
  if (task.confidence !== null) {
    process.stdout.write(`Confidence: ${(task.confidence * 100).toFixed(0)}%\n`);
  }
  process.stdout.write(`Tokens used: ${task.token_used.toLocaleString()}\n`);
  process.stdout.write(`Cost: $${task.cost_used.toFixed(4)}\n`);
  process.stdout.write("\n");

  if (task.result_summary !== null) {
    process.stdout.write("Result:\n");
    process.stdout.write(task.result_summary + "\n");
  } else {
    process.stdout.write("(No result summary available)\n");
  }

  if (task.result_file !== null) {
    process.stdout.write(`\nFull result: ${task.result_file}\n`);
  }

  return 0;
}


async function handleWatch(taskId: string, store: TaskStore, timeout: number): Promise<number> {
  const TERMINAL  = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);
  const deadline  = Date.now() + timeout * 1000;
  const startedAt = Date.now();
  let lastStatus  = "";
  let lastAgent   = "";

  const isTTY = process.stdout.isTTY === true;

  process.stdout.write(`Watching task ${taskId}...\n\n`);

  while (Date.now() < deadline) {
    const task = store.get(taskId);
    if (task === null) {
      process.stderr.write(`✗ Task disappeared from DB.\n`);
      return 1;
    }

    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const elapsed    = formatElapsed(elapsedSec);

    // Print status changes
    if (task.status !== lastStatus || task.assigned_agent !== lastAgent) {
      lastStatus = task.status;
      lastAgent  = task.assigned_agent ?? "";

      const agentStr = task.assigned_agent !== null ? ` [${task.assigned_agent}]` : "";
      const line     = `[${elapsed}] ${task.status}${agentStr}: ${task.title.slice(0, 60)}\n`;
      process.stdout.write(line);
    }

    if (TERMINAL.has(task.status)) {
      process.stdout.write("\n");
      if (task.status === "DONE") {
        process.stdout.write(`✓ Task completed (cost: $${task.cost_used.toFixed(4)}, tokens: ${task.token_used.toLocaleString()})\n`);
        if (task.result_summary !== null) {
          const preview = task.result_summary.slice(0, 500);
          process.stdout.write(`\nResult preview:\n${preview}`);
          if (task.result_summary.length > 500) {
            process.stdout.write(`\n... (use 'sidjua task ${taskId} --result' for full output)`);
          }
          process.stdout.write("\n");
        }
        return 0;
      } else {
        process.stderr.write(`✗ Task ended: ${task.status}\n`);
        return 1;
      }
    }

    // TTY: show spinner
    if (isTTY) {
      process.stdout.write(`  [${elapsed}] ${task.status}...\r`);
    }

    await sleep(2_000);
  }

  process.stderr.write(`✗ Watch timeout after ${timeout}s.\n`);
  return 1;
}


function handleStatus(taskId: string, store: TaskStore, json: boolean): number {
  const task = store.get(taskId);
  if (task === null) {
    process.stderr.write(`✗ Task not found: ${taskId}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      task_id:        taskId,
      status:         task.status,
      title:          task.title,
      assigned_agent: task.assigned_agent,
      tier:           task.tier,
      token_used:     task.token_used,
      cost_used:      task.cost_used,
      created_at:     task.created_at,
      updated_at:     task.updated_at,
    }) + "\n");
    return 0;
  }

  process.stdout.write(`Task: ${taskId}\n`);
  process.stdout.write(`Title: ${task.title}\n`);
  process.stdout.write(`Status: ${task.status}\n`);
  if (task.assigned_agent !== null) {
    process.stdout.write(`Agent: ${task.assigned_agent} (T${task.tier})\n`);
  }
  process.stdout.write(`Tokens used: ${task.token_used.toLocaleString()}\n`);
  process.stdout.write(`Cost: $${task.cost_used.toFixed(4)}\n`);
  process.stdout.write(`Created: ${task.created_at}\n`);

  return 0;
}


function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
