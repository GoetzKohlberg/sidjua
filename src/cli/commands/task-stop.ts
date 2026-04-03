// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua task stop <id>` command
 *
 * Cancel a task with cascading sub-task cancellation.
 */

import { join } from "node:path";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import { TaskStore } from "../../tasks/store.js";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { TaskTreeManager } from "../../orchestrator/tree-manager.js";
import type { TaskTreeNode } from "../../orchestrator/types.js";
import { formatJson } from "../formatters/json.js";


export interface TaskStopCommandOptions {
  workDir: string;
  taskId:  string;
  force:   boolean;
  reason:  string;
  json:    boolean;
}


export async function runTaskStopCommand(opts: TaskStopCommandOptions): Promise<number> {
  return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
    const store      = new TaskStore(db);
    const eventBus   = new TaskEventBus(db);
    const treeManager = new TaskTreeManager(db, eventBus);

    const task = store.get(opts.taskId);

    if (task === null) {
      process.stderr.write(`✗ Task not found: ${opts.taskId}\n`);
      return 1;
    }

    // Count affected tasks for confirmation
    const tree     = treeManager.getTree(opts.taskId);
    const subCount = tree !== null ? countDescendants(tree) : 0;

    // Confirmation prompt (unless --force)
    if (!opts.force) {
      process.stdout.write(
        `Cancel task ${opts.taskId}${subCount > 0 ? ` and all ${subCount} sub-tasks` : ""}? (y/N) `,
      );

      const answer = await readLine();
      if (answer.trim().toLowerCase() !== "y") {
        process.stdout.write("Cancelled.\n");
        return 0;
      }
    }

    // Perform cascading cancellation
    if (!opts.json) {
      process.stdout.write(`▸ Cancelling ${subCount + 1} tasks...\n`);
    }

    const results = treeManager.cancelTree(opts.taskId, opts.reason || "user_cancelled");

    if (opts.json) {
      process.stdout.write(formatJson(results) + "\n");
      return 0;
    }

    // Display results summary
    for (const taskId of results.tasks_cancelled) {
      process.stdout.write(`  ${taskId.padEnd(32)} CANCELLED\n`);
    }

    if (results.cancelled_count === 0 && results.already_terminal > 0) {
      process.stdout.write(
        `⚠ Task was already stopped/completed (${results.already_terminal} tasks already terminal).\n`,
      );
    } else {
      process.stdout.write(
        `✓ Cancelled ${results.cancelled_count} tasks. ${results.already_terminal} already terminal.\n`,
      );
    }

    return 0;
  });
}


function countDescendants(node: TaskTreeNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const handler = (chunk: Buffer | string) => {
      const s = String(chunk);
      buf += s;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", handler);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", handler);
  });
}
