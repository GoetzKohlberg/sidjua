// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — `sidjua api-key` Commands
 *
 * Subcommands:
 *   sidjua api-key generate           — Generate a new API key
 *   sidjua api-key rotate             — Rotate the API key (60s grace period)
 *   sidjua api-key disable-bootstrap  — Permanently disable legacy API key auth
 *   sidjua api-key enable-bootstrap   — Re-enable legacy API key auth (emergency use)
 *   sidjua api-key status             — Show whether bootstrap key is enabled or disabled
 *
 * Once bootstrap key auth is disabled, only scoped tokens (sidjua token create)
 * are accepted. An admin scoped token MUST exist before disabling, otherwise the
 * server becomes inaccessible.
 */

import type { Command }                          from "commander";
import { join }                                   from "node:path";
import { createLogger }                           from "../../core/logger.js";
import { withCliDatabase }                        from "../utils/with-cli-database.js";
import { TokenStore }                             from "../../api/token-store.js";
import { auditCliCommand }                        from "../cli-audit.js";
import { persistKeyState }                        from "../../api/key-store.js";
import {
  apiKeyState,
  generateApiKey,
  MAX_GRACE_PERIOD_MS,
}                                                 from "../../api/api-key-state.js";

const logger = createLogger("api-key-cli");

function out(msg: string): void {
  process.stdout.write(msg);
}

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}


export function registerApiKeyCommands(program: Command): void {
  const apiKeyCmd = program
    .command("api-key")
    .description("Manage SIDJUA API keys");

  // ── sidjua api-key generate ───────────────────────────────────────────────
  apiKeyCmd
    .command("generate")
    .description("Generate a new API key (prints once — save it securely)")
    .option("--work-dir <path>", "Working directory (persists key to DB for restart recovery)", process.cwd())
    .action((opts: { workDir: string }) => {
      const key = generateApiKey();
      apiKeyState.currentApiKey = key;
      // Persist to DB so server restart picks up the same key
      const dbPath = join(opts.workDir, ".system", "sidjua.db");
      persistKeyState(dbPath, { currentKey: key, pendingKey: null, pendingExpiresAt: null });
      process.stdout.write("Generated API key (save this — it will not be shown again):\n");
      process.stdout.write(`  ${key}\n`);
      process.stdout.write("\nTo use:\n");
      process.stdout.write(`  export SIDJUA_API_KEY="${key}"\n`);
      process.stdout.write(`  sidjua server start\n`);
    });

  // ── sidjua api-key rotate ─────────────────────────────────────────────────
  apiKeyCmd
    .command("rotate")
    .description("Rotate the API key (old key valid for 60s grace period)")
    .option("--grace-seconds <sec>", "Grace period in seconds", "60")
    .option("--work-dir <path>", "Working directory (persists key state to DB for restart recovery)", process.cwd())
    .action((opts: { graceSeconds: string; workDir: string }) => {
      const oldKey = apiKeyState.currentApiKey;

      if (!oldKey) {
        process.stderr.write(
          "Error: No current API key. Run `sidjua api-key generate` first.\n",
        );
        process.exit(1);
      }

      const newKey = generateApiKey();

      // Reject rotation if the generated key is identical to the current key.
      // Extremely unlikely with generateSecret() but guards against PRNG failures.
      if (newKey === oldKey) {
        process.stderr.write(
          "Error: Generated key is identical to the current key. Rotation aborted.\n",
        );
        process.exit(1);
      }

      // Cap grace period at MAX_GRACE_PERIOD_MS (24 hours) regardless of
      // what the operator passes via --grace-seconds, preventing infinite grace periods.
      const rawGraceSec = parseInt(opts.graceSeconds, 10);
      const graceSec    = Math.min(
        isNaN(rawGraceSec) || rawGraceSec < 0 ? 60 : rawGraceSec,
        MAX_GRACE_PERIOD_MS / 1_000,
      );

      // New key becomes active immediately; old key kept as pending during grace period
      apiKeyState.pendingKey    = oldKey;
      apiKeyState.currentApiKey = newKey;

      // Use timestamp so grace period survives server restart
      const expiresAt = new Date(Date.now() + graceSec * 1_000).toISOString();

      // Persist rotated state so a restart mid-grace-period still works.
      // dbPath must be defined before the timer callback captures it.
      const dbPath = join(opts.workDir, ".system", "sidjua.db");

      if (apiKeyState.pendingTimer !== null) clearTimeout(apiKeyState.pendingTimer);
      apiKeyState.pendingTimer = setTimeout(() => {
        apiKeyState.pendingKey   = null;
        apiKeyState.pendingTimer = null;
        logger.info("api_key_rotated", "Old API key grace period expired", {});
        // Persist the cleared pending state so a subsequent restart does not
        // re-honor an already-expired grace period (xAI H1 fix).
        persistKeyState(dbPath, {
          currentKey:       apiKeyState.currentApiKey,
          pendingKey:       null,
          pendingExpiresAt: null,
        });
      }, graceSec * 1_000);
      persistKeyState(dbPath, {
        currentKey:       newKey,
        pendingKey:       oldKey !== "" ? oldKey : null,
        pendingExpiresAt: oldKey !== "" ? expiresAt : null,
      });

      process.stdout.write("API key rotated (save the new key — it will not be shown again):\n");
      process.stdout.write(`  New key: ${newKey}\n`);
      process.stdout.write(`  Old key: valid for ${graceSec} more seconds\n`);
      process.stdout.write("\nTo use:\n");
      process.stdout.write(`  export SIDJUA_API_KEY="${newKey}"\n`);
    });

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
