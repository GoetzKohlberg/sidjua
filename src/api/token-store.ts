// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P269: Scoped API Token Store
 *
 * Manages scoped API tokens for fine-grained RBAC.
 * Tokens are stored as SHA-256 hashes — the raw token is shown once.
 *
 * Scope hierarchy (higher includes lower):
 *   admin > operator > agent > readonly
 */

import Database from "better-sqlite3";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256hex, generateSecret } from "../core/crypto-utils.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("token-store");

export type TokenScope = "admin" | "operator" | "agent" | "readonly";

export interface ApiToken {
  id:          string;
  hash:        string;    // SHA-256 of raw token (never stored raw)
  scope:       TokenScope;
  division?:   string;
  agentId?:    string;
  label:       string;
  expiresAt?:  Date;
  createdAt:   Date;
  lastUsedAt?: Date;
  revoked:     boolean;
}

/** SQL schema for the api_tokens table. Applied by openCliDatabase. */
export const TOKEN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS api_tokens (
    id            TEXT PRIMARY KEY,
    hash          TEXT NOT NULL UNIQUE,
    scope         TEXT NOT NULL CHECK(scope IN ('admin','operator','agent','readonly')),
    division      TEXT,
    agent_id      TEXT,
    label         TEXT NOT NULL,
    expires_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at  TEXT,
    revoked       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(hash);
`;

/** Token prefix — makes tokens grep-able and identifiable in logs. */
export const TOKEN_PREFIX = "sidjua_sk_";

/** Prefix stored in the hash column to indicate scrypt hashing (vs legacy SHA-256). */
const SCRYPT_HASH_PREFIX = "$scrypt$";

/** scrypt parameters — N=16384 (2^14), r=8, p=1; 32-byte output. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;

/**
 * Hash a raw token using scrypt (new tokens).
 * Format: "$scrypt$<base64-salt>$<base64-derived-key>"
 */
function scryptHash(raw: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(raw, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${SCRYPT_HASH_PREFIX}${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Verify a raw token against its stored hash.
 * Handles both legacy SHA-256 hashes and new scrypt hashes.
 */
function verifyTokenHash(raw: string, stored: string): boolean {
  if (stored.startsWith(SCRYPT_HASH_PREFIX)) {
    const parts = stored.slice(SCRYPT_HASH_PREFIX.length).split("$");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return false;
    const salt = Buffer.from(parts[0], "base64");
    const expectedDerived = Buffer.from(parts[1], "base64");
    try {
      const actual = scryptSync(raw, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
      if (actual.length !== expectedDerived.length) return false;
      return timingSafeEqual(actual, expectedDerived);
    } catch (_err) {
      return false;
    }
  }
  // Legacy SHA-256 hash — constant-time comparison
  const a = Buffer.from(sha256hex(raw), "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface TokenDbRow {
  id:           string;
  hash:         string;
  scope:        string;
  division:     string | null;
  agent_id:     string | null;
  label:        string;
  expires_at:   string | null;
  created_at:   string;
  last_used_at: string | null;
  revoked:      number;
}

function rowToToken(row: TokenDbRow): ApiToken {
  return {
    id:         row.id,
    hash:       row.hash,
    scope:      row.scope as TokenScope,
    ...(row.division    !== null ? { division:   row.division }           : {}),
    ...(row.agent_id    !== null ? { agentId:    row.agent_id }           : {}),
    label:      row.label,
    ...(row.expires_at  !== null ? { expiresAt:  new Date(row.expires_at) } : {}),
    createdAt:  new Date(row.created_at),
    ...(row.last_used_at !== null ? { lastUsedAt: new Date(row.last_used_at) } : {}),
    revoked:    row.revoked === 1,
  };
}


export class TokenStore {
  constructor(private readonly db: InstanceType<typeof Database>) {
    this.initialize();
  }

  /**
   * Initialize the token table.
   * Idempotent — safe to call on every startup.
   */
  initialize(): void {
    this.db.exec(TOKEN_SCHEMA_SQL);
  }

  /**
   * Create a new scoped API token.
   * Returns the raw token string ONCE — it is never stored and cannot be
   * retrieved again. The caller must display it immediately.
   */
  createToken(opts: {
    scope:      TokenScope;
    division?:  string;
    agentId?:   string;
    label:      string;
    expiresAt?: Date;
  }): { id: string; rawToken: string } {
    const id       = crypto.randomUUID();
    const raw      = TOKEN_PREFIX + generateSecret(32);
    const hash     = scryptHash(raw);
    const now      = new Date().toISOString();

    this.db.prepare<unknown[], void>(`
      INSERT INTO api_tokens (id, hash, scope, division, agent_id, label, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      hash,
      opts.scope,
      opts.division   ?? null,
      opts.agentId    ?? null,
      opts.label,
      opts.expiresAt?.toISOString() ?? null,
      now,
    );

    logger.info("token_created", "API token created", {
      metadata: { id, scope: opts.scope, division: opts.division, label: opts.label },
    });

    // C4: Auto-disable the bootstrap key once an admin-scoped token is created.
    if (opts.scope === "admin") {
      try {
        this.setBootstrapDisabled(true);
      } catch (_err) {
        // workspace_config table may not exist on pre-apply installs; non-fatal.
      }
    }

    return { id, rawToken: raw };
  }

  /**
   * Validate a raw token string.
   * Hashes the provided token and looks it up in the database.
   * Updates last_used_at on success.
   * Returns null when the token is unknown, revoked, or expired.
   */
  validateToken(rawToken: string): ApiToken | null {
    // For legacy SHA-256 tokens: look up by hash directly.
    // For scrypt tokens: we cannot do a DB lookup by hash (scrypt is not deterministic
    // due to random salt), so we fetch all non-revoked tokens matching the token prefix
    // and verify each one. In practice the token prefix makes this set small.
    //
    // Legacy path: fast O(1) DB lookup by SHA-256 hash.
    const legacyHash = sha256hex(rawToken);
    const legacyRow  = this.db
      .prepare<[string], TokenDbRow>(
        "SELECT * FROM api_tokens WHERE hash = ?",
      )
      .get(legacyHash) as TokenDbRow | undefined;

    // If found via legacy hash and not scrypt, use that row.
    // (Legacy SHA-256 hashes do NOT start with "$scrypt$".)
    let row: TokenDbRow | undefined = legacyRow !== undefined && !legacyRow.hash.startsWith(SCRYPT_HASH_PREFIX)
      ? legacyRow
      : undefined;

    // Scrypt path: scan active scrypt tokens (those whose hash starts with the prefix).
    if (row === undefined) {
      const candidates = this.db
        .prepare<[string], TokenDbRow>(
          "SELECT * FROM api_tokens WHERE hash LIKE ? AND revoked = 0",
        )
        .all(SCRYPT_HASH_PREFIX + "%") as TokenDbRow[];

      for (const candidate of candidates) {
        if (verifyTokenHash(rawToken, candidate.hash)) {
          row = candidate;
          break;
        }
      }
    }

    if (row === undefined) return null;

    if (row.revoked === 1) {
      logger.warn("token_revoked", "Revoked token used", {
        metadata: { id: row.id },
      });
      return null;
    }

    if (row.expires_at !== null && new Date(row.expires_at) < new Date()) {
      logger.warn("token_expired", "Expired token used", {
        metadata: { id: row.id },
      });
      return null;
    }

    // Update last_used_at
    this.db.prepare<[string, string], void>(
      "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), row.id);

    return rowToToken(row);
  }

  /**
   * Revoke a token by ID (soft-delete: sets revoked=1, preserves audit trail).
   * Returns true if the token existed, false if not found.
   */
  revokeToken(id: string): boolean {
    const info = this.db
      .prepare<[string], void>("UPDATE api_tokens SET revoked = 1 WHERE id = ? AND revoked = 0")
      .run(id);

    if ((info as unknown as { changes: number }).changes === 0) return false;
    logger.info("token_revoked", "API token revoked", { metadata: { id } });
    return true;
  }

  /**
   * List all tokens (without hashes — hash must never leave the server).
   */
  listTokens(): Omit<ApiToken, "hash">[] {
    const rows = this.db
      .prepare<[], TokenDbRow>("SELECT * FROM api_tokens ORDER BY created_at DESC")
      .all() as TokenDbRow[];
    return rows.map((r) => {
      const t = rowToToken(r);
      const { hash: _hash, ...rest } = t; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest;
    });
  }

  /**
   * Check whether any admin-scoped token exists in the database.
   * Used at startup to decide whether to generate a bootstrap admin token.
   */
  hasAdminToken(): boolean {
    const row = this.db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) as n FROM api_tokens WHERE scope = 'admin' AND revoked = 0",
      )
      .get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  }

  /**
   * Check whether any active scoped token exists (any scope, not revoked).
   * Used to enforce bootstrap key migration: once tokens exist, the bootstrap
   * key should only be used for token management routes.
   */
  hasAnyToken(): boolean {
    try {
      const row = this.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) as n FROM api_tokens WHERE revoked = 0",
        )
        .get() as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } catch (_err) {
      return false; // fail-open: if table missing, allow bootstrap (avoid lockout)
    }
  }

  /**
   * Check whether the bootstrap (legacy raw API key) authentication path
   * has been explicitly disabled by an admin.
   *
   * Reads the `bootstrap_disabled` key from workspace_config.
   * Returns false (allow) if the table does not exist or the key is absent —
   * fail-open to avoid locking out installations that have not run `sidjua apply`.
   */
  isBootstrapDisabled(): boolean {
    try {
      const row = this.db
        .prepare<[string], { value: string }>(
          "SELECT value FROM workspace_config WHERE key = ?",
        )
        .get("bootstrap_disabled") as { value: string } | undefined;
      return row?.value === "true";
    } catch (_err) {
      return false; // fail-open: table may not exist
    }
  }

  /**
   * Set or clear the bootstrap_disabled flag in workspace_config.
   * Idempotent — safe to call multiple times.
   */
  setBootstrapDisabled(disabled: boolean): void {
    this.db.prepare<[string], void>(
      `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
       VALUES ('bootstrap_disabled', ?, datetime('now'))`,
    ).run(disabled ? "true" : "false");
  }

  /**
   * Get a token by ID (without hash), for admin management UI.
   */
  getToken(id: string): Omit<ApiToken, "hash"> | null {
    const row = this.db
      .prepare<[string], TokenDbRow>("SELECT * FROM api_tokens WHERE id = ?")
      .get(id) as TokenDbRow | undefined;
    if (row === undefined) return null;
    const t = rowToToken(row);
    const { hash: _hash, ...rest } = t; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  }
}
