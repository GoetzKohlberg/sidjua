// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Memory Index Manager
 *
 * Manages the JSON file-based memory index at {workDir}/.system/memory/index.json.
 * The index is a flat list of MemoryEntry records with metadata.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "../logger.js";
import type { MemoryIndex, MemoryEntry } from "./types.js";

const logger = createLogger("memory-index");

const INDEX_VERSION = "1.0";

// ---------------------------------------------------------------------------
// MemoryIndexManager
// ---------------------------------------------------------------------------

export class MemoryIndexManager {
  private readonly _indexPath: string;
  private _index: MemoryIndex | null = null;

  constructor(workDir: string) {
    this._indexPath = join(workDir, ".system", "memory", "index.json");
  }

  /** Load the index from disk (or create an empty one if absent). */
  load(): MemoryIndex {
    if (!existsSync(this._indexPath)) {
      this._index = this._empty();
      return this._index;
    }
    try {
      const raw     = readFileSync(this._indexPath, "utf-8");
      const parsed  = JSON.parse(raw) as MemoryIndex;
      this._index   = parsed;
      logger.info("memory_index_loaded", `Loaded memory index: ${parsed.total_entries} entries`, {
        metadata: { path: this._indexPath, count: parsed.total_entries },
      });
      return this._index;
    } catch (err: unknown) {
      logger.warn("memory_index_load_error", "Failed to load memory index — using empty", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      this._index = this._empty();
      return this._index;
    }
  }

  /** Persist the current index to disk. */
  save(): void {
    if (this._index === null) return;
    try {
      const dir = dirname(this._indexPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this._index.updated_at     = new Date().toISOString();
      this._index.total_entries  = this._index.entries.length;
      writeFileSync(this._indexPath, JSON.stringify(this._index, null, 2), "utf-8");
    } catch (err: unknown) {
      logger.warn("memory_index_save_error", "Failed to persist memory index", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Return the loaded index (loads from disk if not yet loaded). */
  getIndex(): MemoryIndex {
    if (this._index === null) return this.load();
    return this._index;
  }

  /** Return all entries. */
  getEntries(): MemoryEntry[] {
    return this.getIndex().entries;
  }

  /** Add an entry. Does not save — call save() when done. */
  addEntry(entry: MemoryEntry): void {
    const idx = this.getIndex();
    idx.entries.push(entry);
    idx.total_entries = idx.entries.length;
  }

  /** Remove entries by ID. Does not save — call save() when done. */
  removeEntries(ids: string[]): number {
    const idx  = this.getIndex();
    const set  = new Set(ids);
    const before = idx.entries.length;
    idx.entries = idx.entries.filter((e) => !set.has(e.id));
    idx.total_entries = idx.entries.length;
    return before - idx.entries.length;
  }

  /** Replace all entries (used after consolidation apply). */
  replaceAll(entries: MemoryEntry[]): void {
    const idx        = this.getIndex();
    idx.entries      = entries;
    idx.total_entries = entries.length;
    idx.updated_at   = new Date().toISOString();
  }

  /** Stats snapshot. */
  getStats(): { total: number; agents: number; oldest: string | null; newest: string | null } {
    const entries = this.getEntries();
    if (entries.length === 0) {
      return { total: 0, agents: 0, oldest: null, newest: null };
    }
    const agents = new Set(entries.map((e) => e.agent_id)).size;
    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      total:  entries.length,
      agents,
      oldest: sorted[0]?.timestamp ?? null,
      newest: sorted[sorted.length - 1]?.timestamp ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _empty(): MemoryIndex {
    const now = new Date().toISOString();
    return {
      version:       INDEX_VERSION,
      created_at:    now,
      updated_at:    now,
      total_entries: 0,
      entries:       [],
    };
  }
}
