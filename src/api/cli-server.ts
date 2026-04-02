// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11a: Server & API Key CLI Commands
 *
 * sidjua server start  [--port 3000] [--host 127.0.0.1]
 * sidjua server stop   (no-op in V1 foreground mode — server stops with process)
 * sidjua server status
 *
 * sidjua api-key generate
 * sidjua api-key rotate
 *
 * In V1 the server always runs in foreground (--detach not yet implemented).
 * API keys are printed once to stdout; the operator must save them securely.
 */

import type { Command } from "commander";
import { generateSecret } from "../core/crypto-utils.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../core/logger.js";
import { loadKeyState, persistKeyState } from "./key-store.js";
import { DEFAULT_SERVER_CONFIG } from "./server.js";
import { runServerStart } from "./server-startup.js";

const logger = createLogger("api-server-cli");


// NOTE: Module-level API key state limits deployment to single-process mode.
// Multi-worker/cluster support requires migrating key state to SQLite or shared store.
// Per-client API tokens with RBAC scopes are planned for V1.0.
// For multi-user deployments, place the API behind a reverse proxy with additional auth.

/**
 * Maximum allowed grace period for key rotation.
 * Prevents an operator from accidentally (or maliciously) setting an
 * unbounded grace period that keeps the old key valid indefinitely.
 */
export const MAX_GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000; // 24 hours

const apiKeyState = {
  currentApiKey: process.env["SIDJUA_API_KEY"] ?? "",
  pendingKey:    null as string | null,
  pendingTimer:  null as ReturnType<typeof setTimeout> | null,
};

/** Clear the pending rotation timer. Safe to call multiple times; used on graceful shutdown. */
export function cleanupApiKeyTimers(): void {
  if (apiKeyState.pendingTimer !== null) {
    clearTimeout(apiKeyState.pendingTimer);
    apiKeyState.pendingTimer = null;
  }
}

/** Exposed for tests only — resets module state. */
export function _resetApiKeyState(): void {
  apiKeyState.currentApiKey = "";
  if (apiKeyState.pendingTimer !== null) clearTimeout(apiKeyState.pendingTimer);
  apiKeyState.pendingTimer = null;
  apiKeyState.pendingKey   = null;
}

/** Returns the API key currently valid for authentication. */
export function getActiveApiKey(): string {
  return apiKeyState.pendingKey !== null ? apiKeyState.pendingKey : apiKeyState.currentApiKey;
}

/** Generates a cryptographically-random 32-byte hex API key. */
export function generateApiKey(): string {
  return generateSecret();
}


export function registerServerCommands(program: Command): void {
  // ----------------------------------------------------------------
  // sidjua server
  // ----------------------------------------------------------------
  const serverCmd = program
    .command("server")
    .description("Manage the SIDJUA REST API server");

  serverCmd
    .command("start")
    .description("Start the REST API server (foreground)")
    .option("--port <port>", "Port to listen on", String(DEFAULT_SERVER_CONFIG.port))
    .option("--host <host>", "Host to bind to",   DEFAULT_SERVER_CONFIG.host)
    .option("--api-key <key>", "API key (overrides SIDJUA_API_KEY env var)")
    .option("--work-dir <path>", "Working directory (for PID file)", process.cwd())
    .option("--dev", "Development mode (include error details in responses)", false)
    .option("--detach", "Run server in background (not yet implemented — planned for V1.1)", false)
    .action(async (opts: {
      port:    string;
      host:    string;
      apiKey?: string;
      workDir: string;
      dev:     boolean;
      detach:  boolean;
    }) => {
      await runServerStart(opts, apiKeyState, cleanupApiKeyTimers, getActiveApiKey);
    });

  serverCmd
    .command("stop")
    .description("Stop the REST API server (sends SIGTERM via PID file)")
    .option("--work-dir <path>", "Working directory (for PID file)", process.cwd())
    .action((opts: { workDir: string }) => {
      const pidFile = join(opts.workDir, ".system", "server.pid");
      if (!existsSync(pidFile)) {
        process.stderr.write("No running server found (no PID file).\n");
        process.exit(1);
      }

      // Verify process identity before sending SIGTERM
      let verifiedPid: number | null = null;
      try {
        const raw = readFileSync(pidFile, "utf-8");
        try {
          const pidData = JSON.parse(raw) as { pid: number; command: string };
          // Verify it's a SIDJUA process
          if (pidData.command === "sidjua") {
            verifiedPid = pidData.pid;
          } else {
            process.stderr.write(`PID file does not appear to be a SIDJUA process. Remove ${pidFile} manually.\n`);
            process.exit(1);
          }
        } catch (_e) {
          // Legacy plain-text PID file — parse as plain integer (backward compat)
          const parsed = parseInt(raw.trim(), 10);
          if (!isNaN(parsed)) verifiedPid = parsed;
        }
      } catch (readErr: unknown) {
        process.stderr.write(`Failed to read PID file: ${readErr instanceof Error ? readErr.message : String(readErr)}\n`);
        process.exit(1);
      }

      const pid = verifiedPid;
      if (pid === null || isNaN(pid)) {
        process.stderr.write("PID file contains invalid value.\n");
        process.exit(1);
      }

      try {
        process.kill(pid, "SIGTERM");
        process.stdout.write(`Sent SIGTERM to server (PID ${pid}).\n`);
        try { unlinkSync(pidFile); } catch (e: unknown) { // cleanup-ignore: PID file removal on server stop is best-effort — file may already be removed
          void e; // cleanup-ignore
        }
      } catch (err) {
        process.stderr.write(
          `Failed to stop server: ${err instanceof Error ? err.message : "unknown"}\n`,
        );
        process.exit(1);
      }
    });

  serverCmd
    .command("status")
    .description("Show REST API server status")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const dbPath = join(opts.workDir, ".system", "sidjua.db");
      const keyState = loadKeyState(dbPath);
      const apiKeyConfigured = keyState !== null
        ? keyState.currentKey.length > 0
        : Boolean(process.env["SIDJUA_API_KEY"]);
      const pidFile = join(opts.workDir, ".system", "server.pid");
      let running = false;
      if (existsSync(pidFile)) {
        try {
          const raw = readFileSync(pidFile, "utf-8");
          let pid: number | null = null;
          try { pid = (JSON.parse(raw) as { pid: number }).pid; } catch (_pe) { pid = parseInt(raw, 10); }
          if (pid !== null && !isNaN(pid)) {
            try { process.kill(pid, 0); running = true; } catch (_ke) { /* not running */ }
          }
        } catch (_re) { /* ignore */ }
      }
      process.stdout.write("SIDJUA REST API server\n");
      process.stdout.write(`  Status:             ${running ? "running" : "stopped"}\n`);
      process.stdout.write(`  API key configured: ${apiKeyConfigured ? "yes" : "no"}\n`);
      if (!running) {
        process.stdout.write(`  Start with: sidjua server start --port ${DEFAULT_SERVER_CONFIG.port}\n`);
      }
    });

  // ----------------------------------------------------------------
  // sidjua api-key
  // ----------------------------------------------------------------
  const apiKeyCmd = program
    .command("api-key")
    .description("Manage SIDJUA API keys");

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

  apiKeyCmd
    .command("rotate")
    .description("Rotate the API key (old key valid for 60s grace period)")
    .option("--grace-seconds <sec>", "Grace period in seconds", "60")
    .option("--work-dir <path>", "Working directory (persists key state to DB for restart recovery)", process.cwd())
    .action((opts: { graceSeconds: string; workDir: string }) => {
      const oldKey    = apiKeyState.currentApiKey;

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
}
