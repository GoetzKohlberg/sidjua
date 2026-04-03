// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua agents` command
 *
 * List and inspect agents.
 *   sidjua agents           — list all agents
 *   sidjua agents <id>      — agent detail with active tasks and queue
 */

import { join } from "node:path";
import { TaskStore } from "../../tasks/store.js";
import { withCliDatabase } from "../utils/with-cli-database.js";
import { formatAge } from "../utils/format.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("agents-cmd");
import { formatTable } from "../formatters/table.js";
import { formatJson } from "../formatters/json.js";


export interface AgentsCommandOptions {
  workDir:  string;
  agentId:  string | undefined;
  tier:     number | undefined;
  status:   string | undefined;
  json:     boolean;
}

interface AgentRow {
  agent_id:              string;
  definition_id:         string;
  status:                string;
  pid:                   number | null;
  active_task_count:     number;
  total_tasks_completed: number;
  total_tokens_used:     number;
  total_cost_millicents: number;
  last_heartbeat:        string | null;
  started_at:            string;
  updated_at:            string;
}


export function runAgentsCommand(opts: AgentsCommandOptions): number {
  return withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
    const store = new TaskStore(db);

    let agentRows: AgentRow[] = [];

    try {
      agentRows = db.prepare<[], AgentRow>(
        "SELECT * FROM agent_instances ORDER BY agent_id",
      ).all();
    } catch (e: unknown) {
      logger.debug("agents-cmd", "agent_instances table not found — no agents to list (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      if (opts.json) {
        process.stdout.write(formatJson([]) + "\n");
      } else {
        process.stdout.write("No agent instances found.\n");
      }
      return 0;
    }

    // Apply filters
    if (opts.status !== undefined) {
      agentRows = agentRows.filter((a) => a.status === opts.status);
    }

    // Detail view for single agent
    if (opts.agentId !== undefined) {
      const agent = agentRows.find((a) => a.agent_id === opts.agentId);
      if (agent === undefined) {
        process.stderr.write(`✗ Agent not found: ${opts.agentId}\n`);
        return 1;
      }

      if (opts.json) {
        const activeTasks = store.getByAgent(agent.agent_id);
        process.stdout.write(formatJson({ agent, active_tasks: activeTasks }) + "\n");
        return 0;
      }

      return printAgentDetail(agent, store, db, opts.workDir);
    }

    // List mode
    if (opts.json) {
      process.stdout.write(formatJson(agentRows) + "\n");
      return 0;
    }

    if (agentRows.length === 0) {
      process.stdout.write("No agents found.\n");
      return 0;
    }

    const rows = agentRows.map((a) => ({
      agent:    a.agent_id.padEnd(20).slice(0, 20),
      status:   a.status,
      tasks:    String(a.active_task_count),
      tokens:   a.total_tokens_used.toLocaleString(),
      cost:     `$${(a.total_cost_millicents / 100000).toFixed(2)}`,
    }));

    const out = formatTable(rows, {
      columns: [
        { header: "AGENT",   key: "agent"  },
        { header: "STATUS",  key: "status" },
        { header: "TASKS",   key: "tasks"  },
        { header: "TOKENS",  key: "tokens" },
        { header: "COST",    key: "cost",  align: "right" },
      ],
      maxWidth: 200,
    });

    process.stdout.write(out + "\n\n");

    const busy     = agentRows.filter((a) => a.status === "busy").length;
    const idle     = agentRows.filter((a) => a.status === "idle").length;
    const crashed  = agentRows.filter((a) => a.status === "crashed").length;
    const totalCost = agentRows.reduce((s, a) => s + a.total_cost_millicents / 100000, 0);

    process.stdout.write(
      `${agentRows.length} agents (${busy} busy, ${idle} idle, ${crashed} crashed).` +
      ` Total cost this session: $${totalCost.toFixed(2)}\n`,
    );

    return 0;
  });
}


function printAgentDetail(
  agent: AgentRow,
  store: TaskStore,
  db:    import("../../utils/db.js").Database,
  workDir: string,
): number {
  const now         = Date.now();
  const activeTasks = store.getByAgent(agent.agent_id);
  const uptime      = agent.started_at !== null
    ? formatUptime(Math.floor((now - new Date(agent.started_at).getTime()) / 1000))
    : "unknown";
  const heartbeatAge = agent.last_heartbeat !== null
    ? formatAge(agent.last_heartbeat, now)
    : "never";

  process.stdout.write(`Agent: ${agent.agent_id}\n`);
  process.stdout.write(`Definition: ${agent.definition_id}\n`);
  process.stdout.write(`Status: ${agent.status}\n`);
  process.stdout.write(`Tasks: ${agent.active_task_count} active\n`);
  process.stdout.write(`Uptime: ${uptime}\n`);
  process.stdout.write(`Session totals: ${agent.total_tokens_used.toLocaleString()} tokens | $${(agent.total_cost_millicents / 100000).toFixed(2)}\n`);
  process.stdout.write(`Last heartbeat: ${heartbeatAge}\n`);

  if (activeTasks.length > 0) {
    process.stdout.write("\nActive tasks:\n");
    for (const task of activeTasks) {
      process.stdout.write(
        `  ${task.id.slice(-16).padEnd(18)} ${task.status.padEnd(10)} "${task.title.slice(0, 40)}"\n`,
      );
    }
  }

  // Pipeline queue for this agent
  try {
    const queueRows = db.prepare<[string], { priority: number; count: number }>(
      "SELECT priority, COUNT(*) as count FROM pipeline_queue WHERE consumer_agent_id = ? AND ack_state = 'QUEUED' GROUP BY priority ORDER BY priority",
    ).all(agent.agent_id);

    if (queueRows.length > 0) {
      process.stdout.write("\nPipeline queue for this agent:\n");
      const labels = ["CRITICAL", "URGENT", "REGULAR", "LOW", "BACKGROUND"];
      const counts: Record<number, number> = {};
      for (const r of queueRows) { counts[r.priority] = r.count; }
      process.stdout.write(
        `  ${labels.map((l, i) => `${l}: ${counts[i] ?? 0}`).join("  |  ")}\n`,
      );
    }
  } catch (e: unknown) {
    logger.debug("agents-cmd", "pipeline_queue table not found — queue info unavailable (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  return 0;
}


function formatUptime(s: number): string {
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

