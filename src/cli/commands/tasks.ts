// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua tasks` command
 *
 * List and inspect tasks.
 *   sidjua tasks                — list active tasks
 *   sidjua tasks <id>           — task detail with sub-task summary
 *   sidjua tasks <id> --tree    — ASCII tree of full decomposition
 *   sidjua tasks <id> --summary — result_summary only
 *   sidjua tasks <id> --result  — output result_file to stdout
 */

import { existsSync }    from "node:fs";
import { readFile }      from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { TaskStore } from "../../tasks/store.js";
import { TaskTreeManager } from "../../orchestrator/tree-manager.js";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import { formatAge } from "../utils/format.js";
import { formatTable } from "../formatters/table.js";
import { formatTree } from "../formatters/tree.js";
import { formatJson } from "../formatters/json.js";
import type { Task } from "../../tasks/types.js";
import type { TreeNode } from "../formatters/tree.js";
import type { TaskTreeNode } from "../../orchestrator/types.js";


export interface TasksCommandOptions {
  workDir:  string;
  taskId:   string | undefined;
  status:   string;   // "active" | "all" | "pending" | "running" | "done" | "failed"
  division: string | undefined;
  agent:    string | undefined;
  tier:     number | undefined;
  limit:    number;
  json:     boolean;
  summary:  boolean;
  result:   boolean;
  tree:     boolean;
}

// Active statuses
const ACTIVE_STATUSES = new Set(["CREATED", "PENDING", "ASSIGNED", "RUNNING", "WAITING", "REVIEW"]);
const TERMINAL_STATUSES = new Set(["DONE", "FAILED", "CANCELLED"]);


export async function runTasksCommand(opts: TasksCommandOptions): Promise<number> {
  return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
    const store       = new TaskStore(db);
    const eventBus    = new TaskEventBus(db);
    const treeManager = new TaskTreeManager(db, eventBus);

    if (opts.taskId !== undefined) {
      return await runTaskDetail(opts, store, treeManager);
    }
    return runTaskList(opts, store);
  });
}


function runTaskList(opts: TasksCommandOptions, store: TaskStore): number {
  // Fetch tasks based on status filter
  let tasks: Task[];

  const statusFilter = opts.status.toLowerCase();

  if (statusFilter === "all") {
    // Fetch across all statuses
    const allStatusList: Task["status"][] = [
      "CREATED", "PENDING", "ASSIGNED", "RUNNING", "WAITING",
      "REVIEW", "DONE", "FAILED", "ESCALATED", "CANCELLED",
    ];
    tasks = allStatusList.flatMap((s) => store.getByStatus(s)).slice(0, opts.limit);
  } else if (statusFilter === "active") {
    tasks = [
      ...store.getByStatus("CREATED"),
      ...store.getByStatus("PENDING"),
      ...store.getByStatus("ASSIGNED"),
      ...store.getByStatus("RUNNING"),
      ...store.getByStatus("WAITING"),
      ...store.getByStatus("REVIEW"),
    ].slice(0, opts.limit);
  } else {
    const dbStatus = statusFilter.toUpperCase();
    tasks = store.getByStatus(dbStatus as Task["status"]).slice(0, opts.limit);
  }

  // Apply additional filters
  if (opts.division !== undefined) {
    tasks = tasks.filter((t) => t.division === opts.division);
  }
  if (opts.agent !== undefined) {
    tasks = tasks.filter((t) => t.assigned_agent === opts.agent);
  }
  if (opts.tier !== undefined) {
    tasks = tasks.filter((t) => t.tier === opts.tier);
  }

  if (opts.json) {
    process.stdout.write(formatJson(tasks) + "\n");
    return 0;
  }

  if (tasks.length === 0) {
    process.stdout.write(`No tasks found.\n`);
    return 0;
  }

  const now = Date.now();
  const rows = tasks.map((t) => ({
    id:       t.id.slice(0, 16) + (t.id.length > 16 ? "…" : ""),
    status:   t.status,
    tier:     `T${t.tier}`,
    agent:    t.assigned_agent ?? "(unassigned)",
    priority: priorityLabel(t.priority),
    age:      formatAge(t.created_at, now),
    title:    t.title.slice(0, 40) + (t.title.length > 40 ? "…" : ""),
  }));

  const out = formatTable(rows, {
    columns: [
      { header: "ID",       key: "id"       },
      { header: "STATUS",   key: "status"   },
      { header: "TIER",     key: "tier"     },
      { header: "AGENT",    key: "agent"    },
      { header: "PRIORITY", key: "priority" },
      { header: "AGE",      key: "age"      },
      { header: "TITLE",    key: "title"    },
    ],
    maxWidth: 200,
  });

  process.stdout.write(out + "\n\n");

  const running = tasks.filter((t) => t.status === "RUNNING").length;
  const done    = tasks.filter((t) => t.status === "DONE").length;
  const pending = tasks.filter((t) => ACTIVE_STATUSES.has(t.status) && t.status !== "RUNNING").length;
  process.stdout.write(
    `${tasks.length} tasks shown (${running} running, ${done} done, ${pending} pending).` +
    (opts.status !== "all" ? " Use --status all to see completed.\n" : "\n"),
  );

  return 0;
}


async function runTaskDetail(
  opts:        TasksCommandOptions,
  store:       TaskStore,
  treeManager: TaskTreeManager,
): Promise<number> {
  const taskId = opts.taskId!;
  const task   = store.get(taskId);

  if (task === null) {
    process.stderr.write(`✗ Task not found: ${taskId}\n`);
    return 1;
  }

  // --result: output result file
  if (opts.result) {
    if (task.result_file === null) {
      process.stderr.write("✗ No result file available for this task.\n");
      return 1;
    }
    const resolvedWorkDir = resolve(opts.workDir);
    const resolvedPath    = resolve(opts.workDir, task.result_file);
    if (!resolvedPath.startsWith(resolvedWorkDir + sep)) {
      process.stderr.write("✗ Result file path is outside the workspace directory.\n");
      return 1;
    }
    if (!existsSync(resolvedPath)) {
      process.stderr.write(`✗ Result file not found: ${resolvedPath}\n`);
      return 1;
    }
    process.stdout.write(await readFile(resolvedPath, "utf8"));
    return 0;
  }

  // --summary: output result_summary only
  if (opts.summary) {
    if (task.result_summary === null) {
      process.stderr.write("✗ No summary available for this task.\n");
      return 1;
    }
    process.stdout.write(task.result_summary + "\n");
    return 0;
  }

  // --tree: ASCII tree view
  if (opts.tree) {
    const treeData = treeManager.getTree(taskId);
    if (treeData === null) {
      process.stderr.write(`✗ Task not found: ${taskId}\n`);
      return 1;
    }

    if (opts.json) {
      process.stdout.write(formatJson(treeData) + "\n");
      return 0;
    }

    const treeNode = taskTreeToDisplayNode(treeData);
    process.stdout.write(formatTree(treeNode) + "\n");
    return 0;
  }

  // --json: full JSON output
  if (opts.json) {
    const children = store.getByParent(taskId);
    process.stdout.write(formatJson({ task, children }) + "\n");
    return 0;
  }

  // Default: detail view
  const children = store.getByParent(taskId);
  const now      = Date.now();

  process.stdout.write(`Task: ${task.id}\n`);
  process.stdout.write(`Title: ${task.title}\n`);
  process.stdout.write(`Status: ${task.status}\n`);
  process.stdout.write(`Priority: ${priorityLabel(task.priority)}\n`);
  process.stdout.write(`Tier: T${task.tier}\n`);
  process.stdout.write(`Agent: ${task.assigned_agent ?? "(unassigned)"}\n`);
  process.stdout.write(`Division: ${task.division}\n`);
  process.stdout.write(`Created: ${task.created_at} (${formatAge(task.created_at, now)})\n`);
  process.stdout.write(
    `Budget: ${task.token_used.toLocaleString()} / ${task.token_budget.toLocaleString()} tokens` +
    `  |  $${task.cost_used.toFixed(2)} / $${task.cost_budget.toFixed(2)}\n`,
  );

  if (children.length > 0) {
    const done = children.filter((c) => c.status === "DONE").length;
    process.stdout.write(`Sub-tasks: ${done} of ${children.length} complete\n`);
    if (task.confidence !== null) {
      process.stdout.write(`Confidence: ${task.confidence.toFixed(2)}\n`);
    } else {
      process.stdout.write(`Confidence: — (pending synthesis)\n`);
    }

    process.stdout.write("\nSub-tasks:\n");

    for (let i = 0; i < children.length; i++) {
      const child      = children[i]!;
      const isLast     = i === children.length - 1;
      const connector  = isLast ? "└─" : "├─";
      const statusIcon = child.status === "DONE" ? "✓" : child.status === "RUNNING" ? "●" : "○";
      const conf       = child.confidence !== null ? child.confidence.toFixed(2) : "—";
      process.stdout.write(
        `${connector} ${child.id.slice(-12).padEnd(14)} ${statusIcon} ${child.status.padEnd(8)} ` +
        `${(child.assigned_agent ?? "").padEnd(18)} ${conf}  "${child.title.slice(0, 30)}"\n`,
      );
    }
  }

  return 0;
}


function taskTreeToDisplayNode(node: TaskTreeNode): TreeNode {
  return {
    label:    `${node.task.id.slice(-12)}  ${node.task.title.slice(0, 30)}`,
    status:   node.task.status,
    children: node.children.map(taskTreeToDisplayNode),
  };
}

function priorityLabel(priority: number): string {
  const map: Record<number, string> = {
    0: "critical", 1: "urgent", 2: "regular", 3: "low", 4: "background",
  };
  return map[priority] ?? String(priority);
}

