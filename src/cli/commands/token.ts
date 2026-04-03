// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P269: `sidjua token` Commands
 *
 * Subcommands:
 *   sidjua token create --scope <scope> --label <label> [--division <div>] [--agent-id <id>] [--expires-at <iso>]
 *   sidjua token list
 *   sidjua token revoke <id>
 *
 * Admin-level: CLI operates directly on the database via TokenStore.
 */

import { join }                                        from "node:path";
import type { Command }                                from "commander";
import { withCliDatabase, withCliDatabaseAsync }       from "../utils/with-cli-database.js";
import { TokenStore }                                  from "../../api/token-store.js";
import type { TokenScope }                             from "../../api/token-store.js";
import { auditCliCommand }                             from "../cli-audit.js";

const VALID_SCOPES: TokenScope[] = ["admin", "operator", "agent", "readonly"];

function out(msg: string): void {
  process.stdout.write(msg);
}

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}


export function registerTokenCommands(program: Command): void {
  const tokenCmd = program
    .command("token")
    .description("Manage scoped API tokens");

  // ── sidjua token create ─────────────────────────────────────────────────
  tokenCmd
    .command("create")
    .description("Create a new scoped API token (printed once — store securely)")
    .requiredOption("--scope <scope>",   `Token scope: ${VALID_SCOPES.join(" | ")}`)
    .requiredOption("--label <label>",   "Human-readable label for this token")
    .option("--work-dir <path>",         "Working directory", process.cwd())
    .option("--division <division>",     "Bind token to a specific division")
    .option("--agent-id <agentId>",      "Bind token to a specific agent")
    .option("--expires-at <iso>",        "Expiry date (ISO-8601 string, e.g. 2027-01-01T00:00:00Z)")
    .action((opts: {
      scope:     string;
      label:     string;
      workDir:   string;
      division?: string;
      agentId?:  string;
      expiresAt?: string;
    }) => {
      if (!VALID_SCOPES.includes(opts.scope as TokenScope)) {
        err(`Invalid scope: "${opts.scope}". Valid scopes: ${VALID_SCOPES.join(", ")}`);
        process.exit(1);
      }

      let expiresAt: Date | undefined;
      if (opts.expiresAt !== undefined) {
        expiresAt = new Date(opts.expiresAt);
        if (isNaN(expiresAt.getTime())) {
          err(`Invalid --expires-at: "${opts.expiresAt}". Use ISO-8601 format (e.g. 2027-01-01T00:00:00Z).`);
          process.exit(1);
        }
      }

      const code = withCliDatabase({ workDir: opts.workDir }, (db) => {
        auditCliCommand("token", "create", db);

        const store = new TokenStore(db);
        const { id, rawToken } = store.createToken({
          scope:    opts.scope as TokenScope,
          label:    opts.label.trim(),
          ...(opts.division !== undefined ? { division: opts.division } : {}),
          ...(opts.agentId  !== undefined ? { agentId:  opts.agentId  } : {}),
          ...(expiresAt     !== undefined ? { expiresAt }               : {}),
        });

        if (!process.stdout.isTTY) {
          // Non-interactive (piped): print ONLY the raw token so callers like
          // TOKEN=$(sidjua token create ...) capture a clean value.
          // Metadata goes to stderr — visible in the terminal but not captured.
          out(rawToken + "\n");
          process.stderr.write(`  Scope:  ${opts.scope}\n`);
          process.stderr.write(`  Label:  ${opts.label.trim()}\n`);
          if (opts.division !== undefined) process.stderr.write(`  Division: ${opts.division}\n`);
          if (opts.agentId  !== undefined) process.stderr.write(`  Agent ID: ${opts.agentId}\n`);
          if (expiresAt     !== undefined) process.stderr.write(`  Expires:  ${expiresAt.toISOString()}\n`);
        } else {
          out(`Token created: ${id}\n`);
          out(`\n`);
          out(`  Token: ${rawToken}\n`);
          out(`\n`);
          out(`WARNING: This token will not be shown again. Store it securely.\n`);
          out(`\n`);
          out(`  Scope:  ${opts.scope}\n`);
          out(`  Label:  ${opts.label.trim()}\n`);
          if (opts.division !== undefined) out(`  Division: ${opts.division}\n`);
          if (opts.agentId  !== undefined) out(`  Agent ID: ${opts.agentId}\n`);
          if (expiresAt     !== undefined) out(`  Expires:  ${expiresAt.toISOString()}\n`);
        }
        return 0;
      });
      process.exit(code);
    });

  // ── sidjua token list ───────────────────────────────────────────────────
  tokenCmd
    .command("list")
    .description("List all API tokens (no raw token values shown)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const code = withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
        auditCliCommand("token", "list", db);

        const store  = new TokenStore(db);
        const tokens = store.listTokens();

        if (tokens.length === 0) {
          out("No tokens found.\n");
          return 0;
        }

        out(`${"ID".padEnd(36)}  ${"SCOPE".padEnd(10)}  ${"LABEL".padEnd(30)}  DIVISION         REVOKED  LAST USED\n`);
        out(`${"-".repeat(36)}  ${"-".repeat(10)}  ${"-".repeat(30)}  ${"-".repeat(16)}  -------  ---------\n`);

        for (const t of tokens) {
          const division = (t.division ?? "").padEnd(16);
          const revoked  = t.revoked ? "yes" : "no ";
          const lastUsed = t.lastUsedAt?.toISOString().slice(0, 10) ?? "never";
          out(`${t.id.padEnd(36)}  ${t.scope.padEnd(10)}  ${t.label.padEnd(30)}  ${division}  ${revoked}      ${lastUsed}\n`);
        }
        out(`\n${tokens.length} token(s) total.\n`);
        return 0;
      });
      process.exit(code);
    });

  // ── sidjua token revoke ─────────────────────────────────────────────────
  tokenCmd
    .command("revoke <id>")
    .description("Revoke a token by ID (soft-delete — kept for audit trail)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((id: string, opts: { workDir: string }) => {
      const code = withCliDatabase({ workDir: opts.workDir }, (db) => {
        auditCliCommand("token", "revoke", db);

        const store   = new TokenStore(db);
        const revoked = store.revokeToken(id);
        if (!revoked) {
          err(`Token not found or already revoked: ${id}`);
          return 1;
        }
        out(`Token ${id} revoked.\n`);
        return 0;
      });
      process.exit(code);
    });
}
