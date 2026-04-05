// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P378: Webhook Token Store
 *
 * SQLite-backed storage for webhook tokens.
 * Raw tokens are NEVER stored — only the SHA-256 hex digest.
 */

import type { Database } from "../../utils/db.js";
import { createLogger } from "../logger.js";

const logger = createLogger("webhook-token-store");


/** Default token TTL: 90 days in milliseconds. */
export const WEBHOOK_TOKEN_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface WebhookToken {
  id:          string;  // UUID
  agent_id:    string;  // agent this token grants access to
  source:      string;  // "*" = any source, or named source (github, grafana, etc.)
  token_hash:  string;  // SHA-256 hex digest — NEVER the raw token
  label:       string;  // human-readable name
  enabled:     boolean;
  last_used:   string | null;  // ISO 8601
  created_at:  string;         // ISO 8601
  expires_at:  string | null;  // ISO 8601; null = no expiration (legacy tokens)
}


export class WebhookTokenStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_tokens (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT '*',
        token_hash TEXT NOT NULL UNIQUE,
        label      TEXT NOT NULL DEFAULT '',
        enabled    INTEGER NOT NULL DEFAULT 1,
        last_used  TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_webhook_tokens_agent ON webhook_tokens(agent_id)",
    );
    // Add expires_at column to pre-existing tables (idempotent — ignored if column already exists).
    try {
      this.db.exec("ALTER TABLE webhook_tokens ADD COLUMN expires_at TEXT");
    } catch (_e) {
      // Column already exists — silently ignore the duplicate-column error.
    }
  }

  /** Persist a new webhook token (raw token is NOT stored — pass the hash).
   *  If `expires_at` is omitted a 90-day TTL is applied automatically. */
  save(token: Omit<WebhookToken, "last_used">): void {
    const expiresAt = token.expires_at
      ?? new Date(Date.now() + WEBHOOK_TOKEN_DEFAULT_TTL_MS).toISOString();

    this.db.prepare<[string, string, string, string, string, number, string, string], void>(
      `INSERT INTO webhook_tokens (id, agent_id, source, token_hash, label, enabled, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      token.id,
      token.agent_id,
      token.source,
      token.token_hash,
      token.label,
      token.enabled ? 1 : 0,
      token.created_at,
      expiresAt,
    );
    logger.debug("webhook-token-store", "Webhook token saved", {
      metadata: { id: token.id, agent_id: token.agent_id, source: token.source, expires_at: expiresAt },
    });
  }

  /** Return all active, non-expired tokens for an agent (enabled=1). */
  findByAgent(agentId: string): WebhookToken[] {
    type Row = {
      id: string; agent_id: string; source: string;
      token_hash: string; label: string; enabled: number;
      last_used: string | null; created_at: string; expires_at: string | null;
    };
    const rows: Row[] = this.db
      .prepare<[string], Row>(
        `SELECT * FROM webhook_tokens
         WHERE agent_id = ? AND enabled = 1
           AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now'))
         ORDER BY created_at ASC`,
      )
      .all(agentId);
    return rows.map((r: Row) => ({ ...r, enabled: r.enabled === 1 }));
  }

  /** Return a single token by ID (any enabled state). */
  getById(id: string): WebhookToken | null {
    type Row = {
      id: string; agent_id: string; source: string;
      token_hash: string; label: string; enabled: number;
      last_used: string | null; created_at: string; expires_at: string | null;
    };
    const row = this.db
      .prepare<[string], Row>("SELECT * FROM webhook_tokens WHERE id = ?")
      .get(id);
    if (row === undefined) return null;
    return { ...row, enabled: row.enabled === 1 };
  }

  /** Return all tokens (admin list). */
  listAll(): WebhookToken[] {
    type Row = {
      id: string; agent_id: string; source: string;
      token_hash: string; label: string; enabled: number;
      last_used: string | null; created_at: string; expires_at: string | null;
    };
    const rows: Row[] = this.db
      .prepare<[], Row>("SELECT * FROM webhook_tokens ORDER BY agent_id ASC, created_at ASC")
      .all();
    return rows.map((r: Row) => ({ ...r, enabled: r.enabled === 1 }));
  }

  /** Update last_used timestamp for a token. */
  updateLastUsed(id: string, ts: string): void {
    this.db
      .prepare<[string, string], void>("UPDATE webhook_tokens SET last_used = ? WHERE id = ?")
      .run(ts, id);
  }

  /** Soft-delete a token (sets enabled = 0). */
  disable(id: string): boolean {
    const result = this.db
      .prepare<[string], void>("UPDATE webhook_tokens SET enabled = 0 WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Hard-delete a token by ID. Returns true when a row was removed. */
  revoke(id: string): boolean {
    const result = this.db
      .prepare<[string], void>("DELETE FROM webhook_tokens WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
