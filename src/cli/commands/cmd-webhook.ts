// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua webhook` CLI Commands
 *
 *   sidjua webhook create <agentId> [--source <src>] [--label <label>]
 *     — Create a new webhook token for an agent. Prints the raw token ONCE.
 *
 *   sidjua webhook list [--agent <agentId>]
 *     — List all webhook tokens (or tokens for a specific agent).
 *
 *   sidjua webhook revoke <id>
 *     — Hard-delete a webhook token by ID.
 */

import { randomUUID }          from "node:crypto";
import { resolve }             from "node:path";
import type { Command }        from "commander";
import { withCliDatabase }     from "../utils/with-cli-database.js";
import { WebhookTokenStore }   from "../../core/webhook/webhook-token-store.js";
import { generateWebhookToken, hashToken } from "../../core/webhook/webhook-auth.js";
import { auditCliCommand }     from "../cli-audit.js";


export function registerWebhookCommands(program: Command): void {
  const webhookCmd = program
    .command("webhook")
    .description("Manage inbound webhook tokens");

  // ── webhook create ────────────────────────────────────────────────────────
  webhookCmd
    .command("create <agentId>")
    .description("Create a new webhook token for an agent (raw token shown ONCE)")
    .option("--source <source>", "Source hint (github, grafana, or * for any)", "*")
    .option("--label <label>",   "Human-readable label for this token", "")
    .option("--work-dir <dir>",  "SIDJUA working directory", process.cwd())
    .action((agentId: string, opts: { source: string; label: string; workDir: string }) => {
      auditCliCommand("webhook", "create");
      const exitCode = webhookCreate({
        agentId,
        source:  opts.source,
        label:   opts.label,
        workDir: resolve(opts.workDir),
      });
      process.exit(exitCode);
    });

  // ── webhook list ──────────────────────────────────────────────────────────
  webhookCmd
    .command("list")
    .description("List all webhook tokens")
    .option("--agent <agentId>",  "Filter by agent ID")
    .option("--work-dir <dir>",   "SIDJUA working directory", process.cwd())
    .action((opts: { agent?: string; workDir: string }) => {
      auditCliCommand("webhook", "list");
      const exitCode = webhookList({
        agentId: opts.agent,
        workDir: resolve(opts.workDir),
      });
      process.exit(exitCode);
    });

  // ── webhook revoke ────────────────────────────────────────────────────────
  webhookCmd
    .command("revoke <id>")
    .description("Permanently delete a webhook token by ID")
    .option("--work-dir <dir>", "SIDJUA working directory", process.cwd())
    .action((id: string, opts: { workDir: string }) => {
      auditCliCommand("webhook", "revoke");
      const exitCode = webhookRevoke({ id, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });
}


// ── Command implementations ───────────────────────────────────────────────────

function webhookCreate(opts: {
  agentId: string;
  source:  string;
  label:   string;
  workDir: string;
}): number {
  return withCliDatabase({ workDir: opts.workDir }, (db) => {
    const store   = new WebhookTokenStore(db);
    const rawToken = generateWebhookToken();
    const tokenHash = hashToken(rawToken);
    const id = randomUUID();
    const now = new Date().toISOString();

    store.save({
      id,
      agent_id:   opts.agentId,
      source:     opts.source,
      token_hash: tokenHash,
      label:      opts.label,
      enabled:    true,
      created_at: now,
      expires_at: null,
    });

    process.stdout.write(`Webhook token created.\n`);
    process.stdout.write(`ID:     ${id}\n`);
    process.stdout.write(`Agent:  ${opts.agentId}\n`);
    process.stdout.write(`Source: ${opts.source}\n`);
    if (opts.label !== "") {
      process.stdout.write(`Label:  ${opts.label}\n`);
    }
    process.stdout.write(`\n`);

    if (process.stdout.isTTY) {
      process.stdout.write(`Token (shown ONCE — copy it now):\n`);
      process.stdout.write(`  ${rawToken}\n\n`);
      process.stdout.write(
        `Use as:  X-Sidjua-Token: ${rawToken}\n`,
      );
    } else {
      process.stdout.write(`${rawToken}\n`);
    }

    return 0;
  });
}


function webhookList(opts: { agentId: string | undefined; workDir: string }): number {
  return withCliDatabase({ workDir: opts.workDir }, (db) => {
    const store  = new WebhookTokenStore(db);
    const tokens = opts.agentId !== undefined
      ? store.findByAgent(opts.agentId)
      : store.listAll();

    if (tokens.length === 0) {
      process.stdout.write("No webhook tokens found.\n");
      return 0;
    }

    const header = ["ID (first 8)".padEnd(10), "Agent".padEnd(20), "Source".padEnd(10),
                    "Label".padEnd(20), "Last Used"].join("  ");
    process.stdout.write(`${header}\n`);
    process.stdout.write(`${"-".repeat(header.length)}\n`);

    for (const t of tokens) {
      const lastUsed = t.last_used !== null ? t.last_used.slice(0, 19) : "never";
      const row = [
        t.id.slice(0, 8).padEnd(10),
        t.agent_id.slice(0, 20).padEnd(20),
        t.source.padEnd(10),
        (t.label || "—").slice(0, 20).padEnd(20),
        lastUsed,
      ].join("  ");
      process.stdout.write(`${row}\n`);
    }

    return 0;
  });
}


function webhookRevoke(opts: { id: string; workDir: string }): number {
  return withCliDatabase({ workDir: opts.workDir }, (db) => {
    const store   = new WebhookTokenStore(db);
    const removed = store.revoke(opts.id);

    if (removed) {
      process.stdout.write(`Webhook token ${opts.id} revoked.\n`);
      return 0;
    } else {
      process.stderr.write(`Error: no webhook token found with ID ${opts.id}\n`);
      return 1;
    }
  });
}
