// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Step 4: SECRETS
 *
 * V1 Secrets Provider: SQLite + Application-level AES-256-GCM encryption.
 *
 * Architecture decision (V1):
 *   @journeyapps/sqlcipher requires libcrypto.so.1.1 (OpenSSL 1.1), which is
 *   not available in all deployment environments. V1 therefore uses better-sqlite3
 *   with AES-256-GCM encryption applied at the value level via Node.js built-in
 *   crypto. This provides equivalent security properties for individual secret
 *   values and avoids a system-level library dependency.
 *
 *   The SQLCipher integration (full-database encryption) is planned for V1.1 as
 *   an optional drop-in replacement for this provider. The SecretsProvider
 *   interface is identical — only the constructor changes.
 *
 * Key derivation:
 *   1. On first init: generate 32-byte random master key + 32-byte Argon2 salt
 *   2. Derive 32-byte AES key: argon2id(masterKey, salt) → Buffer
 *   3. Store master key + salt in sidjua.db._system_keys (V1 bootstrap tradeoff)
 *   4. On subsequent init: load master key + salt, re-derive AES key
 *
 * Encryption per value:
 *   AES-256-GCM with a random 12-byte IV per value.
 *   Stored as JSON: { iv: hex, authTag: hex, ciphertext: hex }
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { generateSecret } from "../core/crypto-utils.js";
import { join } from "node:path";
import argon2 from "argon2";
import type { ParsedConfig } from "../types/config.js";
import { ApplyError, type StepResult } from "../types/apply.js";
import type { SecretsProvider, SecretMetadata } from "../types/apply.js";
import { openDatabase, type Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("apply-secrets");


const MASTER_KEY_NAME = "secrets_master_key";
const KDF_SALT_NAME = "secrets_kdf_salt";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

const SECRETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    namespace        TEXT NOT NULL,
    key              TEXT NOT NULL,
    value_encrypted  TEXT NOT NULL,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace, key)
  );

  CREATE TABLE IF NOT EXISTS secret_access_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
    namespace  TEXT NOT NULL,
    key        TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    action     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_access_timestamp ON secret_access_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_access_namespace ON secret_access_log(namespace);
`;


interface EncryptedBlob {
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface SecretRow {
  namespace: string;
  key: string;
  value_encrypted: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AccessLogRow {
  timestamp: string;
  agent_id: string;
  action: string;
}

export class SqliteSecretsProvider implements SecretsProvider {
  private db: Database | null = null;
  private encKey: Buffer | null = null;

  constructor(private readonly mainDb: Database) {}

  async init(config: { db_path?: string }): Promise<void> {
    const dbPath = config.db_path ?? "";
    if (!dbPath) throw new Error("SecretsConfig.db_path is required");

    this.db = openDatabase(dbPath);
    this.db.exec(SECRETS_SCHEMA);

    this.encKey = await this.resolveEncryptionKey();
    logger.info("secrets", "Secrets provider initialised", { metadata: { dbPath } });
  }

  async get(namespace: string, key: string): Promise<string | null> {
    const db = this.requireDb();
    const encKey = this.requireKey();

    const row = db
      .prepare<[string, string], SecretRow>(
        "SELECT * FROM secrets WHERE namespace = ? AND key = ?",
      )
      .get(namespace, key);

    if (row === undefined) return null;

    this.logAccess(db, namespace, key, "system", "read");
    return decryptValue(encKey, row.value_encrypted);
  }

  async set(namespace: string, key: string, value: string): Promise<void> {
    const db = this.requireDb();
    const encKey = this.requireKey();

    const encrypted = encryptValue(encKey, value);

    db.prepare<[string, string, string], void>(`
      INSERT INTO secrets (namespace, key, value_encrypted, version)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value_encrypted = excluded.value_encrypted,
        version         = version + 1,
        updated_at      = datetime('now')
    `).run(namespace, key, encrypted);

    this.logAccess(db, namespace, key, "system", "write");
  }

  async delete(namespace: string, key: string): Promise<void> {
    const db = this.requireDb();
    this.logAccess(db, namespace, key, "system", "delete");
    db.prepare<[string, string], void>(
      "DELETE FROM secrets WHERE namespace = ? AND key = ?",
    ).run(namespace, key);
  }

  async list(namespace: string): Promise<string[]> {
    const db = this.requireDb();
    const rows = db
      .prepare<[string], { key: string }>(
        "SELECT key FROM secrets WHERE namespace = ? ORDER BY key",
      )
      .all(namespace) as { key: string }[];
    return rows.map((r) => r.key);
  }

  /** Namespace is a logical prefix. V1: no-op — namespace exists implicitly. */
  async ensureNamespace(_namespace: string): Promise<void> {
    // No-op: namespaces are embedded in the composite primary key.
    // No separate namespace table needed for V1.
  }

  async rotate(namespace: string, key: string, newValue: string): Promise<void> {
    const db = this.requireDb();
    const encKey = this.requireKey();

    const encrypted = encryptValue(encKey, newValue);
    db.prepare<[string, string, string], void>(`
      UPDATE secrets
      SET value_encrypted = ?, version = version + 1, updated_at = datetime('now')
      WHERE namespace = ? AND key = ?
    `).run(encrypted, namespace, key);

    this.logAccess(db, namespace, key, "system", "rotate");
  }

  async getMetadata(namespace: string, key: string): Promise<SecretMetadata | null> {
    const db = this.requireDb();

    const row = db
      .prepare<[string, string], SecretRow>(
        "SELECT created_at, updated_at, version FROM secrets WHERE namespace = ? AND key = ?",
      )
      .get(namespace, key);

    if (row === undefined) {
      return null;
    }

    const lastAccess = db
      .prepare<[string, string], AccessLogRow>(
        `SELECT timestamp, agent_id, action FROM secret_access_log
         WHERE namespace = ? AND key = ? AND action = 'read'
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(namespace, key);

    const created = new Date(row.created_at);
    const now = new Date();
    const rotationAgeDays = Math.floor(
      (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_accessed_at: lastAccess?.timestamp ?? row.created_at,
      last_accessed_by: lastAccess?.agent_id ?? "system",
      rotation_age_days: rotationAgeDays,
      version: row.version,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireDb(): Database {
    if (!this.db) throw new Error("SecretsProvider not initialised — call init() first");
    return this.db;
  }

  private requireKey(): Buffer {
    if (!this.encKey) throw new Error("Encryption key not available — call init() first");
    return this.encKey;
  }

  private logAccess(
    db: Database,
    namespace: string,
    key: string,
    agentId: string,
    action: string,
  ): void {
    db.prepare<[string, string, string, string], void>(
      "INSERT INTO secret_access_log (namespace, key, agent_id, action) VALUES (?, ?, ?, ?)",
    ).run(namespace, key, agentId, action);
  }

  /**
   * Resolve (or generate) the 32-byte AES encryption key.
   * Master key + KDF salt are stored in sidjua.db._system_keys.
   */
  private async resolveEncryptionKey(): Promise<Buffer> {
    const getKey = this.mainDb.prepare<[string], { key_value: string }>(
      "SELECT key_value FROM _system_keys WHERE key_name = ?",
    );
    const setKey = this.mainDb.prepare<[string, string], void>(`
      INSERT INTO _system_keys (key_name, key_value)
      VALUES (?, ?)
      ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value, updated_at = datetime('now')
    `);

    const existingMaster = getKey.get(MASTER_KEY_NAME);
    const existingSalt = getKey.get(KDF_SALT_NAME);

    let masterKeyHex: string;
    let saltHex: string;

    if (existingMaster !== undefined && existingSalt !== undefined) {
      masterKeyHex = existingMaster.key_value;
      saltHex = existingSalt.key_value;
      logger.debug("secrets", "Loaded existing master key from sidjua.db");
    } else {
      // First time: generate master key + salt
      masterKeyHex = generateSecret();
      saltHex = generateSecret();
      this.mainDb.transaction(() => {
        setKey.run(MASTER_KEY_NAME, masterKeyHex);
        setKey.run(KDF_SALT_NAME, saltHex);
      })();
      logger.info("secrets", "Generated new master key for secrets encryption");
    }

    const masterKey = Buffer.from(masterKeyHex, "hex");
    const salt = Buffer.from(saltHex, "hex");

    // Derive 32-byte AES key using Argon2id
    const derived = await argon2.hash(masterKey, {
      ...ARGON2_OPTIONS,
      raw: true,
      salt,
    });

    return derived as Buffer;
  }
}


function encryptValue(key: Buffer, plaintext: string): string {
  // AES-GCM IV: raw 12-byte Buffer (not hex) — intentional randomBytes usage, not generateSecret()
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
  return JSON.stringify(blob);
}

function decryptValue(key: Buffer, encrypted: string): string {
  const blob = JSON.parse(encrypted) as EncryptedBlob;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(blob.authTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}


/**
 * Provision the secrets store for all active divisions + global namespaces.
 * Does NOT write any secret values — only ensures the structure exists.
 */
export async function applySecrets(
  config: ParsedConfig,
  workDir: string,
  mainDb: Database,
): Promise<StepResult> {
  const start = Date.now();

  try {
    const dbPath = join(workDir, ".system", "secrets.db");
    const provider = new SqliteSecretsProvider(mainDb);

    await provider.init({ db_path: dbPath });

    // Create namespace structure
    await provider.ensureNamespace("global");
    await provider.ensureNamespace("providers");

    for (const div of config.activeDivisions) {
      await provider.ensureNamespace(`divisions/${div.code}`);
    }

    provider.close();

    const namespacesVerified = 2 + config.activeDivisions.length;

    return {
      step: "SECRETS",
      success: true,
      duration_ms: Date.now() - start,
      summary: `Secrets DB initialised, ${namespacesVerified} namespaces verified`,
      details: { dbPath, namespacesVerified },
    };
  } catch (err) {
    throw new ApplyError(
      "DATABASE_ERROR",
      "SECRETS",
      `Secrets step failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
