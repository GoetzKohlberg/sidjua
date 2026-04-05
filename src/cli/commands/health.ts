// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua health` command
 *
 * System health overview: orchestrator state, agents, pipeline, tasks, governance.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openSafeDatabase } from "../../core/db/safe-open.js";
import { validateWorkDir } from "../../utils/path-utils.js";
import { hasTable } from "../utils/db-init.js";
import { TaskStore } from "../../tasks/store.js";
import { formatAge } from "../utils/format.js";
import { writeJsonOutput } from "../utils/output.js";
import { isProcessAlive } from "../utils/process.js";
import { createLogger } from "../../core/logger.js";
import { msg }          from "../../i18n/index.js";

const logger = createLogger("health");


export interface HealthCommandOptions {
  workDir: string;
  json:    boolean;
}

interface AgentRow {
  agent_id:       string;
  tier:           number;
  status:         string;
  last_heartbeat: string | null;
}

interface OrchestratorStateRow {
  state:          string;
  started_at:     string | null;
  last_heartbeat: string | null;
}


/**
 * Display system health status.
 *
 * Returns 0 if orchestrator is running, 1 otherwise.
 */
export function runHealthCommand(opts: HealthCommandOptions): number {
  validateWorkDir(opts.workDir);
  const systemDir = join(opts.workDir, ".system");
  const pidFile   = join(systemDir, "orchestrator.pid");
  const dbFile    = join(systemDir, "sidjua.db");

  // ── Orchestrator status ──────────────────────────────────────────────────

  let orchestratorRunning = false;
  let orchestratorPid: number | null = null;
  let uptimeSeconds   = 0;
  let orchestratorState = "NOT RUNNING";

  if (existsSync(pidFile)) {
    const pidText = readFileSync(pidFile, "utf8").trim();
    const pid     = parseInt(pidText, 10);

    if (!isNaN(pid)) {
      if (isProcessAlive(pid)) {
        orchestratorRunning = true;
        orchestratorPid     = pid;
        orchestratorState   = "RUNNING";
      } else {
        // process not found — stale PID file
        orchestratorState = "NOT RUNNING (stale PID file)";
      }
    }
  }

  // ── DB health ────────────────────────────────────────────────────────────

  let dbOk       = false;
  let dbSizeMb   = 0;
  let dbExists   = false;
  let agentRows: AgentRow[]            = [];
  let taskCounts: Record<string, number> = {};
  let queueCount = 0;

  if (existsSync(dbFile)) {
    dbExists = true;
    try {
      const stat = statSync(dbFile);
      dbSizeMb   = Math.round((stat.size / 1_000_000) * 10) / 10;

      // Open a read-only connection — toggling query_only on an existing
      // read-write connection has known reliability issues with WAL.
      const db = openSafeDatabase(dbFile, { readonly: true });

      // Agent rows — guard with hasTable() to avoid "no such table"; inner try/catch handles
      // "no such column: tier" on DBs that predate Phase 10.5 migrations.
      if (hasTable(db, "agent_instances")) {
        try {
          agentRows = db.prepare<[], AgentRow>(
            "SELECT agent_id, tier, status, last_heartbeat FROM agent_instances ORDER BY tier, agent_id",
          ).all();
        } catch (e: unknown) {
          logger.debug("health", "Tier column query failed — pre-Phase-10.5 migration (skipping)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
        }
      }

      // Task counts
      if (hasTable(db, "tasks")) {
        const store = new TaskStore(db);
        taskCounts = store.countByStatus();
      }

      // Pipeline queue count
      if (hasTable(db, "pipeline_queue")) {
        const row = db.prepare<[], { cnt: number }>(
          "SELECT COUNT(*) as cnt FROM pipeline_queue WHERE ack_state = 'QUEUED'",
        ).get();
        queueCount = row?.cnt ?? 0;
      }

      // Read orchestrator state from DB
      if (hasTable(db, "orchestrator_state")) {
        const stateRow = db.prepare<[], OrchestratorStateRow>(
          "SELECT state, started_at, last_heartbeat FROM orchestrator_state WHERE id = 1",
        ).get();
        if (stateRow !== undefined && orchestratorRunning) {
          orchestratorState = stateRow.state;
          if (stateRow.started_at !== null) {
            uptimeSeconds = Math.floor(
              (Date.now() - new Date(stateRow.started_at).getTime()) / 1000,
            );
          }
        }
      }

      db.close();
      dbOk = true;
    } catch (e: unknown) {
      logger.warn("health", "DB health check query failed — reporting unhealthy", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  // ── Format output ────────────────────────────────────────────────────────

  const healthData = {
    orchestrator: {
      state:    orchestratorState,
      running:  orchestratorRunning,
      pid:      orchestratorPid,
      uptime_s: uptimeSeconds,
    },
    database: {
      ok:        dbOk,
      path:      dbFile,
      size_mb:   dbSizeMb,
      exists:    dbExists,
    },
    agents:  agentRows,
    tasks:   taskCounts,
    queue:   { queued: queueCount },
  };

  if (writeJsonOutput(healthData, opts)) {
    return orchestratorRunning ? 0 : 1;
  }

  // Text output
  process.stdout.write(msg("cli.health.header"));

  if (orchestratorRunning) {
    const uptime = formatUptime(uptimeSeconds);
    process.stdout.write(
      `Orchestrator: ${orchestratorState} (uptime: ${uptime}, PID ${orchestratorPid ?? "?"})\n`,
    );
  } else {
    process.stdout.write(`Orchestrator: ${orchestratorState}\n`);
    process.stdout.write(msg("cli.health.start_hint"));
  }

  if (dbOk) {
    process.stdout.write(
      `Database: OK (${dbFile}, ${dbSizeMb} MB)\n`,
    );
  } else if (dbExists) {
    process.stdout.write(`Database: ERROR (cannot read ${dbFile})\n`);
  } else {
    process.stdout.write(`Database: NOT FOUND (${dbFile})\n`);
    process.stdout.write(msg("cli.health.apply_hint"));
  }

  if (agentRows.length > 0) {
    const healthy  = agentRows.filter((a) => a.status !== "crashed").length;
    const crashed  = agentRows.filter((a) => a.status === "crashed").length;
    const idle     = agentRows.filter((a) => a.status === "idle").length;
    process.stdout.write(
      `\nAgents: ${agentRows.length} total | ${healthy} healthy | ${crashed} crashed | ${idle} idle\n`,
    );
    for (const agent of agentRows) {
      const age = agent.last_heartbeat !== null
        ? formatAge(agent.last_heartbeat)
        : "never";
      const statusLabel = agent.status === "crashed" ? "CRASHED" : "healthy" + (agent.status === "idle" ? " (idle)" : "");
      process.stdout.write(`  ${agent.agent_id.padEnd(24)} ♥ ${age.padEnd(8)} ${statusLabel}\n`);
    }
  }

  const activeTasks    = (taskCounts["RUNNING"] ?? 0) + (taskCounts["ASSIGNED"] ?? 0) + (taskCounts["PENDING"] ?? 0);
  const completedTasks = taskCounts["DONE"]      ?? 0;
  const failedTasks    = taskCounts["FAILED"]    ?? 0;
  const escalatedTasks = taskCounts["ESCALATED"] ?? 0;

  if (Object.keys(taskCounts).length > 0) {
    process.stdout.write(
      `\nPipeline: ${queueCount} queued\n`,
    );
    process.stdout.write(
      `Tasks: ${activeTasks} active | ${completedTasks} completed | ${failedTasks} failed | ${escalatedTasks} escalated\n`,
    );
  }

  return orchestratorRunning ? 0 : 1;
}


function formatUptime(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60)         return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

