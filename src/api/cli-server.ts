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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadKeyState } from "./key-store.js";
import { DEFAULT_SERVER_CONFIG } from "./server.js";
import { runServerStart } from "./server-startup.js";
import { apiKeyState, getActiveApiKey } from "./api-key-state.js";

// Re-export for backward compatibility — tests import these from cli-server.js
export {
  MAX_GRACE_PERIOD_MS,
  _resetApiKeyState,
  getActiveApiKey,
  generateApiKey,
} from "./api-key-state.js";


/** Clear the pending rotation timer. Safe to call multiple times; used on graceful shutdown. */
export function cleanupApiKeyTimers(): void {
  if (apiKeyState.pendingTimer !== null) {
    clearTimeout(apiKeyState.pendingTimer);
    apiKeyState.pendingTimer = null;
  }
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

}
