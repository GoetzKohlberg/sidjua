// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Checkpoint Persistence
 *
 * Persists agent state to SQLite for cross-version recovery.
 * Used during freeze to save where each agent left off.
 */

import type { Database } from "better-sqlite3";
import { createLogger } from "../logger.js";

const logger = createLogger("checkpoint");

export interface AgentCheckpoint {
  id:          string;
  version:     string;       // MANDATORY: app version that created this checkpoint
  status:      "thinking" | "tool_call" | "idle" | "frozen";
  memory:      unknown;      // serialized agent memory
  currentTask: unknown;      // serialized task state
  lastStep?:   string;
  updatedAt:   string;       // ISO timestamp
}

const DDL = `
  CREATE TABLE IF NOT EXISTS agent_checkpoints (
    id          TEXT PRIMARY KEY,
    version     TEXT NOT NULL,
    status      TEXT NOT NULL,
    memory      TEXT,
    current_task TEXT,
    last_step   TEXT,
    updated_at  TEXT NOT NULL
  )
`;

let _db: Database | null = null;

/** Wire in the database handle (called during app init). */
export function wireCheckpointDb(db: Database): void {
  _db = db;
  db.exec(DDL);
}

/** Persist a checkpoint to SQLite. */
export async function persistCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
  if (_db === null) throw new Error("Checkpoint DB not initialized");

  let memoryJson: string;
  let taskJson:   string;

  try {
    memoryJson = JSON.stringify(checkpoint.memory ?? null);
  } catch (err: unknown) {
    throw new Error(`Failed to serialize memory: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    taskJson = JSON.stringify(checkpoint.currentTask ?? null);
  } catch (err: unknown) {
    throw new Error(`Failed to serialize currentTask: ${err instanceof Error ? err.message : String(err)}`);
  }

  _db.prepare<[string, string, string, string, string, string | null, string], void>(`
    INSERT OR REPLACE INTO agent_checkpoints (id, version, status, memory, current_task, last_step, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.id,
    checkpoint.version,
    checkpoint.status,
    memoryJson,
    taskJson,
    checkpoint.lastStep ?? null,
    checkpoint.updatedAt,
  );
}

/** Load a checkpoint for a specific agent. Returns null if not found. */
export async function loadCheckpoint(agentId: string): Promise<AgentCheckpoint | null> {
  if (_db === null) return null;

  const row = _db.prepare<[string], Record<string, unknown>>(
    "SELECT * FROM agent_checkpoints WHERE id = ?",
  ).get(agentId) as Record<string, unknown> | undefined;

  if (row === undefined) return null;
  return parseCheckpointRow(row);
}

/** Load all checkpoints from the database. */
export async function loadAllCheckpoints(): Promise<AgentCheckpoint[]> {
  if (_db === null) return [];

  const rows = _db.prepare<[], Record<string, unknown>>(
    "SELECT * FROM agent_checkpoints",
  ).all() as Record<string, unknown>[];

  const results: AgentCheckpoint[] = [];
  for (const row of rows) {
    try {
      const cp = parseCheckpointRow(row);
      if (cp !== null) results.push(cp);
    } catch (err: unknown) {
      logger.warn("checkpoint", "Failed to parse checkpoint row", {
        metadata: { id: row["id"], error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return results;
}

/**
 * Attempt to persist a checkpoint with retries on failure.
 * Returns true if successful within maxRetries attempts.
 */
export async function retryCheckpoint(
  checkpoint: AgentCheckpoint,
  opts: { maxRetries: number; backoffMs: number },
): Promise<boolean> {
  for (let i = 0; i < opts.maxRetries; i++) {
    try {
      await persistCheckpoint(checkpoint);
      return true;
    } catch (err: unknown) {
      logger.warn("checkpoint", "Checkpoint persist failed — retrying", {
        metadata: {
          agentId: checkpoint.id,
          attempt: i + 1,
          error:   err instanceof Error ? err.message : String(err),
        },
      });
      if (i < opts.maxRetries - 1) {
        await sleep(opts.backoffMs * (i + 1));
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseCheckpointRow(row: Record<string, unknown>): AgentCheckpoint | null {
  if (typeof row["id"] !== "string") return null;

  let memory: unknown = null;
  let currentTask: unknown = null;

  if (typeof row["memory"] === "string" && row["memory"]) {
    try {
      memory = JSON.parse(row["memory"]);
    } catch (_err) {
      memory = null;
    }
  }

  if (typeof row["current_task"] === "string" && row["current_task"]) {
    try {
      currentTask = JSON.parse(row["current_task"]);
    } catch (_err) {
      currentTask = null;
    }
  }

  return {
    id:          row["id"] as string,
    version:     typeof row["version"] === "string"    ? row["version"]    : "unknown",
    status:      typeof row["status"] === "string"     ? row["status"] as AgentCheckpoint["status"] : "idle",
    memory,
    currentTask,
    ...(typeof row["last_step"] === "string" ? { lastStep: row["last_step"] } : {}),
    updatedAt:   typeof row["updated_at"] === "string" ? row["updated_at"] : new Date().toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset DB handle — for tests only. */
export function _resetCheckpointDb(): void {
  _db = null;
}
