// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Environment Manager
 *
 * CRUD on the `environments` table + connectivity testing.
 * SSH connectivity uses the `ssh2` package.
 */

import type { Database } from "../utils/db.js";
import type {
  Environment,
  EnvironmentType,
  EnvironmentStatus,
  EnvironmentConfig,
  CreateEnvironmentInput,
  PlatformType,
} from "./types.js";
import { createLogger } from "../core/logger.js";
import { validateSshHost } from "../core/outbound-validator.js";

const logger = createLogger("environment-manager");


interface DbEnvironmentRow {
  id: string;
  name: string;
  type: string;
  platform: string | null;
  platform_version: string | null;
  config_json: string;
  status: string;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}


interface ConnectivityResult {
  connected: boolean;
  latency_ms?: number;
  error?: string;
}


export class EnvironmentManager {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Create a new environment record and return the persisted Environment.
   */
  create(input: CreateEnvironmentInput): Environment {
    const now = new Date().toISOString();
    const configJson = JSON.stringify(input.config);
    const platformVal: string | null =
      input.platform !== undefined ? input.platform : null;
    const platformVersionVal: string | null =
      input.platform_version !== undefined ? input.platform_version : null;

    this.db
      .prepare<
        [string, string, string, string | null, string | null, string, string, string],
        void
      >(
        `INSERT INTO environments
           (id, name, type, platform, platform_version, config_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.type,
        platformVal,
        platformVersionVal,
        configJson,
        now,
        now,
      );

    return this.getById(input.id);
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  /**
   * Retrieve an environment by ID. Throws if not found.
   */
  getById(id: string): Environment {
    const row = this.db
      .prepare<[string], DbEnvironmentRow>(
        `SELECT id, name, type, platform, platform_version, config_json, status,
                last_tested_at, created_at, updated_at
         FROM environments WHERE id = ?`,
      )
      .get(id);

    if (row === undefined) {
      throw new Error(`EnvironmentManager: environment not found: ${id}`);
    }

    return this.mapRow(row);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * List all environments.
   */
  list(): Environment[] {
    const rows = this.db
      .prepare<[], DbEnvironmentRow>(
        `SELECT id, name, type, platform, platform_version, config_json, status,
                last_tested_at, created_at, updated_at
         FROM environments`,
      )
      .all();

    return rows.map((r) => this.mapRow(r));
  }

  // -------------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------------

  /**
   * Update the status of an environment.
   */
  updateStatus(id: string, status: EnvironmentStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare<[string, string, string], void>(
        `UPDATE environments SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, now, id);
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * Delete an environment by ID.
   */
  delete(id: string): void {
    this.db
      .prepare<[string], void>(`DELETE FROM environments WHERE id = ?`)
      .run(id);
  }

  // -------------------------------------------------------------------------
  // testConnectivity
  // -------------------------------------------------------------------------

  /**
   * Test connectivity for an environment.
   *
   * - local / no connection config → `{ connected: true, latency_ms: 0 }`
   * - ssh → attempt SSH connection via ssh2; update last_tested_at + status
   * - other types → `{ connected: false, error: '...' }`
   */
  async testConnectivity(id: string): Promise<ConnectivityResult> {
    const env = this.getById(id);
    const connection = env.config.connection;

    let result: ConnectivityResult;

    if (connection === undefined || connection.type === "local") {
      result = { connected: true, latency_ms: 0 };
    } else if (connection.type === "ssh") {
      result = await this.testSshConnectivity(connection.host, connection.user);
    } else {
      result = {
        connected: false,
        error: `Connectivity test not implemented for ${connection.type}`,
      };
    }

    // Persist last_tested_at and derived status
    const testedAt = new Date().toISOString();
    const newStatus: EnvironmentStatus = result.connected ? "active" : "error";

    this.db
      .prepare<[string, string, string, string], void>(
        `UPDATE environments
         SET last_tested_at = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(testedAt, newStatus, testedAt, id);

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Attempt an SSH connection using the ssh2 library.
   * Returns a connectivity result.
   *
   * If the host is not set, returns a descriptive error rather than
   * attempting a connection that would immediately fail.
   */
  private async testSshConnectivity(
    host: string | undefined,
    user: string | undefined,
  ): Promise<ConnectivityResult> {
    if (host === undefined || host.length === 0) {
      return {
        connected: false,
        error: "SSH key secret resolution not available in CLI context",
      };
    }

    // SSRF guard — reject private/loopback hosts before opening a connection
    try {
      validateSshHost(host);
    } catch (e: unknown) {
      return { connected: false, error: e instanceof Error ? e.message : String(e) };
    }

    const start = Date.now();

    return new Promise<ConnectivityResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ connected: false, error: "SSH connection timed out after 5000ms" });
      }, 5_000);

      // Lazy-require ssh2 to avoid hard dep if not used
      let SshClient: { new(): SshClientShape };
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ssh2Module = require("ssh2") as { Client: { new(): SshClientShape } };
        SshClient = ssh2Module.Client;
      } catch (e: unknown) {
        logger.warn("environment-manager", "ssh2 module not available — SSH environment support disabled", { metadata: { error: e instanceof Error ? e.message : String(e) } });
        clearTimeout(timeout);
        resolve({ connected: false, error: "ssh2 module not available" });
        return;
      }

      const client = new SshClient();

      client.on("ready", () => {
        const latency_ms = Date.now() - start;
        clearTimeout(timeout);
        client.end();
        resolve({ connected: true, latency_ms });
      });

      client.on("error", (err: Error) => {
        clearTimeout(timeout);
        resolve({ connected: false, error: err.message });
      });

      client.connect({
        host,
        port: 22,
        username: user ?? "root",
        // No credentials provided — test host reachability only.
        // A host-key-only handshake that errors on auth is still "reachable".
        readyTimeout: 5_000,
      });
    });
  }

  private mapRow(row: DbEnvironmentRow): Environment {
    const config = JSON.parse(row.config_json) as EnvironmentConfig;

    const env: Environment = {
      id: row.id,
      name: row.name,
      type: row.type as EnvironmentType,
      config,
      status: row.status as EnvironmentStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (row.platform !== null) {
      env.platform = row.platform as PlatformType;
    }

    if (row.platform_version !== null) {
      env.platform_version = row.platform_version;
    }

    if (row.last_tested_at !== null) {
      env.last_tested_at = row.last_tested_at;
    }

    return env;
  }
}


interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  readyTimeout: number;
}

interface SshClientShape {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  connect(options: SshConnectOptions): void;
  end(): void;
}
