// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua secret` Commands
 *
 * Subcommands:
 *   sidjua secret set <namespace> <key> [--value <v>]
 *   sidjua secret get <namespace> <key>
 *   sidjua secret list <namespace>
 *   sidjua secret delete <namespace> <key>
 *   sidjua secret info <namespace> <key>
 *   sidjua secret rotate <namespace> <key> [--value <v>]
 *   sidjua secret namespaces
 *
 * Admin-level: CLI bypasses RBAC (uses SqliteSecretsProvider directly).
 * For agent-scoped access, use GovernedSecretsProvider.
 */

import { join }               from "node:path";
import type { Command }       from "commander";
import { openDatabase }       from "../../utils/db.js";
import { runMigrations105 }   from "../../agent-lifecycle/migration.js";
import { SqliteSecretsProvider } from "../../apply/secrets.js";
import { hasTable }           from "../utils/db-init.js";
import { msg }                from "../../i18n/index.js";
import { auditCliCommand }    from "../cli-audit.js";
import { getOsUsername }      from "../cli-governance-gate.js";


async function openProvider(workDir: string): Promise<{
  provider: SqliteSecretsProvider;
  close: () => void;
}> {
  const dbPath      = join(workDir, ".system", "sidjua.db");
  const secretsPath = join(workDir, ".system", "secrets.db");

  const mainDb = openDatabase(dbPath);
  runMigrations105(mainDb);

  const provider = new SqliteSecretsProvider(mainDb);
  await provider.init({ db_path: secretsPath });

  return {
    provider,
    close: () => {
      provider.close();
      mainDb.close();
    },
  };
}


function out(msg: string): void {
  process.stdout.write(msg);
}

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}


/** Maximum secret value size accepted from stdin (1 MiB). */
const MAX_SECRET_SIZE = 1 * 1024 * 1024;

async function resolveValue(flag?: string): Promise<string> {
  if (flag !== undefined) return flag;

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SECRET_SIZE) {
        reject(new Error(`Secret value exceeds maximum allowed size (${MAX_SECRET_SIZE} bytes)`));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8").replace(/\n$/, ""));
    });
    process.stdin.on("error", reject);
  });
}


export function registerSecretCommands(program: Command): void {
  const secretCmd = program
    .command("secret")
    .description("Manage encrypted secrets (admin access — bypasses RBAC)");

  // ---- set ----------------------------------------------------------------

  secretCmd
    .command("set <namespace> <key>")
    .description("Write a secret value")
    .option("--value <v>", "Secret value (omit to read from stdin)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, key: string, opts: { value?: string; workDir: string }) => {
      auditCliCommand("secret", "set");
      const value = await resolveValue(opts.value);
      if (!value) {
        err("Error: value is required (use --value or pipe via stdin)");
        process.exit(1);
      }
      const { provider, close } = await openProvider(opts.workDir);
      try {
        await provider.set(namespace, key, value);
        out(`✓ Set ${namespace}/${key}\n`);
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- get ----------------------------------------------------------------

  secretCmd
    .command("get <namespace> <key>")
    .description("Read a secret value (masked by default; use --reveal for the full value)")
    .option("--reveal",          "Display the full secret value (creates an audit log entry)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, key: string, opts: { reveal?: boolean; workDir: string }) => {
      const { provider, close } = await openProvider(opts.workDir);
      try {
        const value = await provider.get(namespace, key);
        if (value === null) {
          err(`Secret ${namespace}/${key} not found`);
          process.exit(1);
        }

        if (opts.reveal) {
          auditCliCommand("secret", "reveal");
          if (!process.stdout.isTTY) {
            err("--reveal requires an interactive terminal (stdout is not a TTY)");
            process.exit(1);
          }
          // Fail-closed: write a DB-level audit record before revealing the value.
          // If the audit write fails, deny the reveal rather than leak without a trace.
          const auditDbPath = join(opts.workDir, ".system", "sidjua.db");
          const auditDb = openDatabase(auditDbPath);
          try {
            auditDb.exec(`
              CREATE TABLE IF NOT EXISTS secret_reveal_audit (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ns          TEXT NOT NULL,
                key         TEXT NOT NULL,
                agent_id    TEXT,
                division    TEXT,
                role        TEXT,
                revealed_at TEXT NOT NULL
              )
            `);
            auditDb.prepare(
              `INSERT INTO secret_reveal_audit (ns, key, agent_id, division, role, revealed_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(namespace, key, getOsUsername(), "system", "operator", new Date().toISOString());
          } catch (_auditErr) {
            auditDb.close();
            err("Cannot reveal secret: audit logging unavailable");
            process.exit(1);
          }
          auditDb.close();
          out(msg("secret.get.reveal_audit", { namespace, key }));
          out(value + "\n");
        } else {
          // Mask: reveal only last 4 characters to prevent prefix correlation
          const masked = value.length > 8
            ? `****${value.slice(-4)}`
            : "****";
          out(masked + "\n");
          out(msg("secret.get.masked_hint"));
        }
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- list ---------------------------------------------------------------

  secretCmd
    .command("list <namespace>")
    .description("List secret keys in a namespace")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, opts: { workDir: string }) => {
      const { provider, close } = await openProvider(opts.workDir);
      try {
        const keys = await provider.list(namespace);
        if (keys.length === 0) {
          out(`No secrets in namespace "${namespace}"\n`);
        } else {
          for (const k of keys) out(`${k}\n`);
        }
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- delete -------------------------------------------------------------

  secretCmd
    .command("delete <namespace> <key>")
    .description("Delete a secret")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, key: string, opts: { workDir: string }) => {
      auditCliCommand("secret", "delete");
      const { provider, close } = await openProvider(opts.workDir);
      try {
        const existing = await provider.get(namespace, key);
        if (existing === null) {
          err(`Error: Secret '${namespace}/${key}' not found`);
          process.exit(1);
        }
        await provider.delete(namespace, key);
        out(`✓ Deleted ${namespace}/${key}\n`);
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- info ---------------------------------------------------------------

  secretCmd
    .command("info <namespace> <key>")
    .description("Show metadata for a secret")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, key: string, opts: { workDir: string }) => {
      const { provider, close } = await openProvider(opts.workDir);
      try {
        const meta = await provider.getMetadata(namespace, key);
        if (meta === null) {
          err(`Error: Secret '${namespace}/${key}' not found.\n`);
          process.exit(1);
          return;
        }
        out(`Namespace:        ${namespace}\n`);
        out(`Key:              ${key}\n`);
        out(`Version:          ${meta.version}\n`);
        out(`Created:          ${meta.created_at}\n`);
        out(`Updated:          ${meta.updated_at}\n`);
        out(`Last accessed:    ${meta.last_accessed_at}\n`);
        out(`Last accessed by: ${meta.last_accessed_by}\n`);
        out(`Rotation age:     ${meta.rotation_age_days} day(s)\n`);
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- rotate -------------------------------------------------------------

  secretCmd
    .command("rotate <namespace> <key>")
    .description("Rotate a secret to a new value")
    .option("--value <v>", "New value (omit to read from stdin)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (namespace: string, key: string, opts: { value?: string; workDir: string }) => {
      const value = await resolveValue(opts.value);
      if (!value) {
        err("Error: new value is required (use --value or pipe via stdin)");
        process.exit(1);
      }
      const { provider, close } = await openProvider(opts.workDir);
      try {
        await provider.rotate(namespace, key, value);
        out(`✓ Rotated ${namespace}/${key}\n`);
      } catch (e) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        close();
      }
    });

  // ---- namespaces ---------------------------------------------------------

  secretCmd
    .command("namespaces")
    .description("List all namespaces that have at least one secret")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: { workDir: string }) => {
      const secretsPath = join(opts.workDir, ".system", "secrets.db");
      const secretsDb = openDatabase(secretsPath);
      try {
        if (!hasTable(secretsDb, "secrets")) {
          out("Secrets not yet provisioned. Run `sidjua apply` first.\n");
          return;
        }
        const rows = secretsDb
          .prepare<[], { namespace: string }>(
            "SELECT DISTINCT namespace FROM secrets ORDER BY namespace",
          )
          .all() as { namespace: string }[];

        if (rows.length === 0) {
          out("No namespaces found. Run `sidjua apply` to provision secrets.\n");
        } else {
          for (const r of rows) out(r.namespace + "\n");
        }
      } catch (e: unknown) {
        err(`Error: ${String(e)}`);
        process.exit(1);
      } finally {
        secretsDb.close();
      }
    });
}
