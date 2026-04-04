// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — `sidjua api-key` Commands
 *
 * Subcommands:
 *   sidjua api-key disable-bootstrap  — Permanently disable legacy API key auth
 *   sidjua api-key enable-bootstrap   — Re-enable legacy API key auth (emergency use)
 *   sidjua api-key status             — Show whether bootstrap key is enabled or disabled
 *
 * Once bootstrap key auth is disabled, only scoped tokens (sidjua token create)
 * are accepted. An admin scoped token MUST exist before disabling, otherwise the
 * server becomes inaccessible.
 */

import type { Command }                          from "commander";
import { withCliDatabase }                        from "../utils/with-cli-database.js";
import { TokenStore }                             from "../../api/token-store.js";
import { auditCliCommand }                        from "../cli-audit.js";

function out(msg: string): void {
  process.stdout.write(msg);
}

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}


export function registerApiKeyCommands(program: Command): void {
  const apiKeyCmd = program
    .command("api-key")
    .description("Manage the legacy bootstrap API key");

  // ── sidjua api-key disable-bootstrap ──────────────────────────────────────
  apiKeyCmd
    .command("disable-bootstrap")
    .description("Disable the legacy bootstrap API key (scoped tokens only after this)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--confirm", "Confirm the disable action (required)")
    .action((opts: { workDir: string; confirm?: boolean }) => {
      const code = withCliDatabase({ workDir: opts.workDir }, (db) => {
        auditCliCommand("api-key", "disable-bootstrap", db);

        if (opts.confirm !== true) {
          err(
            "Disabling bootstrap authentication is irreversible until re-enabled.\n" +
            "Once disabled, ONLY scoped tokens (sidjua token create) will be accepted.\n" +
            "Ensure you have an admin scoped token before proceeding.\n" +
            "\nRe-run with --confirm to proceed.",
          );
          return 1;
        }

        const store = new TokenStore(db);

        // Safety: refuse if no admin token exists — would cause a lockout.
        if (!store.hasAdminToken()) {
          err(
            "ABORTED: No active admin token exists.\n" +
            "Create one first: sidjua token create --scope admin --label 'my-admin' --confirm\n" +
            "Disabling bootstrap without an admin token would lock you out.",
          );
          return 1;
        }

        store.setBootstrapDisabled(true);
        out("Bootstrap API key authentication DISABLED.\n");
        out("Only scoped tokens are now accepted for authentication.\n");
        return 0;
      });
      process.exit(code);
    });

  // ── sidjua api-key enable-bootstrap ───────────────────────────────────────
  apiKeyCmd
    .command("enable-bootstrap")
    .description("Re-enable the legacy bootstrap API key (emergency recovery only)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const code = withCliDatabase({ workDir: opts.workDir }, (db) => {
        auditCliCommand("api-key", "enable-bootstrap", db);

        const store = new TokenStore(db);
        store.setBootstrapDisabled(false);
        out("Bootstrap API key authentication ENABLED.\n");
        out("WARNING: Consider disabling it again once your emergency access is resolved.\n");
        return 0;
      });
      process.exit(code);
    });

  // ── sidjua api-key status ──────────────────────────────────────────────────
  apiKeyCmd
    .command("status")
    .description("Show whether bootstrap API key authentication is enabled or disabled")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const code = withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
        auditCliCommand("api-key", "status", db);

        const store = new TokenStore(db);
        const disabled = store.isBootstrapDisabled();
        out(`Bootstrap API key auth: ${disabled ? "DISABLED" : "ENABLED"}\n`);
        if (!disabled) {
          out("Run 'sidjua api-key disable-bootstrap --confirm' to disable it.\n");
        }
        return 0;
      });
      process.exit(code);
    });
}
