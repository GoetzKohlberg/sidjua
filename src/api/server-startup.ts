// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Server Startup Logic
 *
 * Contains the full startup sequence for `sidjua server start`:
 * database init, migrations, orchestrator bootstrap, route registration,
 * GUI serving, error logging, signal handling, and graceful shutdown.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync, chmodSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { redactPii } from "../core/telemetry/pii-redactor.js";
import { createLogger, configureLogger } from "../core/logger.js";
import { loadKeyState } from "./key-store.js";
import { registerAllRoutes } from "./routes/index.js";
import { openDatabase } from "../utils/db.js";
import { AgentRegistry } from "../agent-lifecycle/agent-registry.js";
import { runMigrations105 }        from "../agent-lifecycle/migration.js";
import { runAuditMigrations }      from "../core/audit/audit-migrations.js";
import { runActivityMigrations }   from "../core/activity/activity-migrations.js";
import { activityEmitter }         from "../core/activity/activity-emitter.js";
import { digestEngine }            from "../core/activity/digest-engine.js";
import { startDigestScheduler }    from "../core/activity/digest-scheduler.js";
// DUAL PATH: start.ts (CLI foreground) runs the same migrations. Changes here MUST be mirrored there.
import {
  createApiServer,
  DEFAULT_SERVER_CONFIG,
  type ApiServerConfig,
} from "./server.js";
import { restoreChatState, persistChatState } from "./routes/chat.js";
import { registerGuiRoutes } from "./gui-server.js";
import { persistRateLimiterState, restoreRateLimiterState } from "./middleware/rate-limiter.js";
import { bootstrapOrchestrator } from "../orchestrator/bootstrap.js";
import { TokenStore }            from "./token-store.js";
import { UploadStore }           from "../uploads/upload-store.js";
import { FileStorage }           from "../uploads/file-storage.js";
import { ExtractionService }     from "../uploads/extraction-service.js";
import { UploadEmbedder }        from "../uploads/upload-embedder.js";
import { createVectorStore }     from "../knowledge-pipeline/vector-store/index.js";
import { SIDJUA_VERSION }        from "../version.js";

const logger = createLogger("api-server-cli");

/** Structured PID file format — replaces plain integer for process identity verification. */
interface PidFileData {
  pid:       number;
  startTime: number;
  command:   string;
  version:   string;
}

/** Options passed to `runServerStart()` from the CLI action. */
export interface StartServerOpts {
  port:    string;
  host:    string;
  apiKey?: string;
  workDir: string;
  dev:     boolean;
  detach:  boolean;
}

/** Slice of the module-level apiKeyState object (passed by reference). */
export interface ApiKeyStateLike {
  currentApiKey: string;
  pendingKey:    string | null;
  pendingTimer:  ReturnType<typeof setTimeout> | null;
}

/**
 * Full startup sequence for `sidjua server start`.
 * Extracted from cli-server.ts to keep registerServerCommands() readable.
 *
 * @param opts           Parsed CLI options from commander
 * @param apiKeyState    Module-level API key state (mutated in place)
 * @param cleanupTimers  Cancels the pending-key rotation timer on shutdown
 * @param getActiveKey   Returns the currently-valid API key (current or pending)
 */
export async function runServerStart(
  opts:          StartServerOpts,
  apiKeyState:   ApiKeyStateLike,
  cleanupTimers: () => void,
  getActiveKey:  () => string,
): Promise<void> {
  // --detach is documented as a V1.1 feature; inform user and continue in foreground.
  if (opts.detach) {
    process.stderr.write("Detached mode (--detach) is not yet implemented. Server runs in foreground.\n");
    process.stderr.write("Use a process manager (pm2, systemd) for background execution.\n");
    // Don't exit — still start in foreground as fallback
  }

  // Load persisted key state from DB (survives restart).
  // A pending key whose expiry is still in the future is honored, allowing
  // clients using the old key to continue working after a restart mid-rotation.
  const dbPath   = join(opts.workDir, ".system", "sidjua.db");
  const persisted = loadKeyState(dbPath);
  if (persisted !== null) {
    apiKeyState.currentApiKey = persisted.currentKey;
    apiKeyState.pendingKey    = persisted.pendingKey;
    if (persisted.pendingKey !== null && persisted.pendingExpiresAt !== null) {
      const remainingMs = new Date(persisted.pendingExpiresAt).getTime() - Date.now();
      if (remainingMs > 0) {
        if (apiKeyState.pendingTimer !== null) clearTimeout(apiKeyState.pendingTimer);
        apiKeyState.pendingTimer = setTimeout(() => {
          apiKeyState.pendingKey   = null;
          apiKeyState.pendingTimer = null;
          logger.info("api_key_rotated", "Old API key grace period expired (post-restart)", {});
        }, remainingMs);
      } else {
        // Expiry already passed while server was down
        apiKeyState.pendingKey = null;
      }
    }
  }

  const apiKey = opts.apiKey ?? apiKeyState.currentApiKey;

  if (!apiKey) {
    process.stderr.write(
      "Error: API key required. Run `sidjua api-key generate` first, then set SIDJUA_API_KEY or use --api-key.\n",
    );
    process.exit(1);
  }

  // Warn operators that the raw API key now has bootstrap scope only (P311).
  // All non-bootstrap API operations require a scoped token.
  logger.warn(
    "startup_bootstrap_scope",
    "The raw API key is restricted to bootstrap scope (token creation only). " +
    "Create a scoped token for API access: sidjua token create --scope admin",
    {},
  );

  // CORS origins: ENV SIDJUA_CORS_ORIGINS overrides default (comma-separated list)
  const envCorsOrigins = process.env["SIDJUA_CORS_ORIGINS"];
  const corsOrigins    = envCorsOrigins
    ? envCorsOrigins.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SERVER_CONFIG.cors_origins;
  const corsAllowAll   = corsOrigins.includes("*");

  // ── Open database (optional — routes degrade gracefully if absent) ──────
  // Must open BEFORE creating the server so tokenStore can be wired to auth middleware.
  const db = openDatabase(dbPath);
  runMigrations105(db);
  runAuditMigrations(db);
  runActivityMigrations(db);
  activityEmitter.init(db);
  digestEngine.init(db);
  const registry = new AgentRegistry(db);

  // Diagnostic: warn if no agents registered (apply likely not run yet)
  try {
    const countRow = db.prepare<[], { cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM agent_definitions",
    ).get() as { cnt: number } | undefined;
    if (!countRow || countRow.cnt === 0) {
      process.stderr.write(
        "[WARN] No agents registered in database. Run 'sidjua apply' to provision starter agents.\n",
      );
      logger.warn("server_start", "Zero agents in database — apply may not have run", {});
    }
  } catch (_e) {
    // Table may not exist on a brand-new DB — non-fatal
  }

  // Restore persisted chat history and prepare for checkpoint writes
  if (db !== null) {
    restoreChatState(db);
  }

  // P270 B6: Restore rate-limiter state from previous server instance
  if (db !== null) {
    const restored = restoreRateLimiterState(db);
    if (restored > 0) {
      logger.info("server_start", `Rate-limiter state restored (${restored} buckets)`, {});
    }
  }

  // ── P269: Auto-generate admin token on first startup ──────────────────
  // If no admin token exists, create one and write it to .system/admin.token
  // (chmod 0600 — readable only by the process owner).
  const tokenStore = db !== null ? new TokenStore(db) : null;
  if (tokenStore !== null && !tokenStore.hasAdminToken()) {
    const adminTokenFile = join(opts.workDir, ".system", "admin.token");
    try {
      const { id, rawToken } = tokenStore.createToken({
        scope: "admin",
        label: "auto-generated admin token",
      });
      writeFileSync(adminTokenFile, rawToken, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(adminTokenFile, 0o600); } catch (_e) { /* best effort */ }
      logger.info("admin_token_generated", `Admin token created: ${id}`, {
        metadata: { id, file: adminTokenFile },
      });
      process.stderr.write(`[sidjua] Admin token written to: ${adminTokenFile}\n`);
      process.stderr.write(`[sidjua] WARNING: Protect this file — it grants full admin access.\n`);
    } catch (e: unknown) {
      logger.warn("admin_token_failed", "Could not write admin token file", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  const config: ApiServerConfig = {
    ...DEFAULT_SERVER_CONFIG,
    port:             parseInt(opts.port, 10),
    host:             opts.host,
    api_key:          apiKey,
    cors_origins:     corsAllowAll ? [] : corsOrigins,
    cors_allow_all:   corsAllowAll,
    // Wire live apiKeyState so auth checks both current AND pending key during rotation
    getPendingApiKey: () => apiKeyState.pendingKey,
    isDevelopment:    opts.dev,
    // P269: scoped token store wired to auth middleware
    tokenStore,
  };

  const server  = createApiServer(config);
  const pidFile = join(opts.workDir, ".system", "server.pid");

  // ── Stale PID detection — fail fast if another instance is running ───────
  if (existsSync(pidFile)) {
    try {
      const raw = readFileSync(pidFile, "utf-8");
      let existingPid: number | null = null;
      try {
        const existing = JSON.parse(raw) as PidFileData;
        existingPid = existing.pid;
      } catch (_pe) {
        // Legacy plain-integer PID file
        const parsed = parseInt(raw.trim(), 10);
        if (!isNaN(parsed)) existingPid = parsed;
      }
      if (existingPid !== null) {
        try {
          process.kill(existingPid, 0); // throws if process doesn't exist
          process.stderr.write(`SIDJUA already running (PID ${existingPid}). Use 'sidjua server stop' first.\n`);
          process.exit(1);
        } catch (_e) {
          // Process not running — stale PID file; remove and continue
          try { unlinkSync(pidFile); } catch (_ue) { /* ignore */ }
        }
      }
    } catch (_pe) {
      // Malformed PID file — remove and continue
      try { unlinkSync(pidFile); } catch (_ue) { /* ignore */ }
    }
  }

  // ── Start orchestrator (MUST succeed before HTTP server starts) ──────────
  //
  // GOVERNANCE GUARANTEE: Tasks submitted via API are immediately routed
  // through the governance pipeline. Starting the server without an
  // orchestrator would accept tasks but never process or audit them.
  let orchestrator = null as import("../orchestrator/orchestrator.js").OrchestratorProcess | null;
  try {
    const orcConfigPath = join(opts.workDir, "governance", "orchestrator.yaml");
    orchestrator = await bootstrapOrchestrator({
      db,
      workDir:    opts.workDir,
      configPath: orcConfigPath,
    });
  } catch (err: unknown) {
    logger.error("server_start_failed", "Orchestrator startup failed", {
      error: { code: "SYS-001", message: String(err) },
    });
    process.stderr.write(`Error: Failed to start orchestrator: ${String(err)}\n`);
    process.exit(1);
  }

  // ── Register all API routes (agents, tasks, costs, audit, etc.) ──────────
  const uploadStore  = db !== null ? new UploadStore(db) : null;
  const fileStorage  = new FileStorage({
    baseDir:      join(opts.workDir, "data", "uploads"),
    maxSizeBytes: 10 * 1024 * 1024,
  });
  const uploadEmbedder = uploadStore !== null
    ? new UploadEmbedder({ uploadStore, db: db!, embedder: null, vectorStore: createVectorStore(db!) })
    : null;
  const extractionService = uploadStore !== null
    ? new ExtractionService(uploadStore, undefined, uploadEmbedder ?? undefined)
    : null;
  // Re-process any uploads that were pending/processing before last shutdown
  if (extractionService !== null) {
    void extractionService.processPending().catch((_e: unknown) => { /* best effort */ }); // cleanup-ignore: startup re-processing is best-effort
  }
  // Re-embed uploads that were extracted before an embedder was configured
  if (uploadEmbedder !== null) {
    void uploadEmbedder.embedPending().catch((_e: unknown) => { /* best effort */ }); // cleanup-ignore: startup re-embedding is best-effort
  }
  registerAllRoutes(server.app, {
    db,
    workDir:          opts.workDir,
    registry,
    orchestrator,
    secrets:          null,
    integration:      null,
    tokenStore,
    getApiKey:        getActiveKey,
    uploadStore,
    fileStorage,
    extractionService,
    activityEmitter,
  });

  // ── GUI static file serving ───────────────────────────────────────────────
  // Locate sidjua-gui/dist relative to the package root.
  // dist/index.js is the bundle entry; one level up is the package root.
  const pkgRoot = resolvePath(new URL(".", import.meta.url).pathname, "../");
  const guiDist = join(pkgRoot, "sidjua-gui", "dist");
  const hasGui  = registerGuiRoutes(server.app, guiDist, () => apiKeyState.currentApiKey);

  // ── Error log with PII redaction (SIDJUA_ERROR_LOG env var) ─────────────
  const errorLogPath: string | undefined = process.env["SIDJUA_ERROR_LOG"];
  if (errorLogPath !== undefined && errorLogPath !== "") {
    const errorLog: string = errorLogPath; // capture for closure narrowing
    // Route structured logger warn/error output to the error log file so
    // runtime errors from all components appear alongside uncaught exceptions.
    configureLogger({ filePath: errorLog, output: "both" });
    try { mkdirSync(dirname(errorLog), { recursive: true }); } catch (_e) { /* ignore */ }
    // Create the file at startup so operators can verify it exists before any errors occur
    try {
      appendFileSync(errorLog, JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        kind: "startup",
        message: "Error log initialized",
      }) + "\n");
    } catch (_e) { /* ignore — non-fatal */ }
    function writeErrorLog(kind: string, err: unknown): void {
      const msg = err instanceof Error
        ? `${err.message}\n${err.stack ?? ""}`
        : String(err);
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        kind,
        message: redactPii(msg),
      });
      try { appendFileSync(errorLog, entry + "\n"); } catch (_e) { /* ignore — cannot log inside error handler */ }
    }
    process.on("uncaughtException",  (err) => { writeErrorLog("uncaughtException",  err); });
    process.on("unhandledRejection", (err) => { writeErrorLog("unhandledRejection", err); });
  }

  try {
    await server.start();

    // Write structured PID file so `sidjua server stop` can verify process identity
    try {
      mkdirSync(dirname(pidFile), { recursive: true });
      const pidData: PidFileData = {
        pid:       process.pid,
        startTime: Date.now(),
        command:   "sidjua",
        version:   SIDJUA_VERSION,
      };
      writeFileSync(pidFile, JSON.stringify(pidData));
    } catch (pidErr) {
      process.stderr.write(`Warning: could not write PID file (${String(pidErr)})\n`);
    }

    process.stdout.write(
      `SIDJUA API server running on http://${config.host}:${server.boundPort}\n`,
    );
    if (hasGui) {
      process.stdout.write(
        `  Dashboard: http://${config.host}:${server.boundPort}/\n`,
      );
    }
    process.stdout.write("Press Ctrl+C to stop.\n");

    // Periodic chat-state checkpoint — keeps SQLite in sync with in-memory state
    const CHAT_PERSIST_INTERVAL_MS = 60_000;
    const chatPersistTimer = db !== null
      ? setInterval(() => {
          try { persistChatState(db); } catch (e: unknown) {
            logger.warn("server_chat_persist", "Periodic chat checkpoint failed", {
              metadata: { error: e instanceof Error ? e.message : String(e) },
            });
          }
        }, CHAT_PERSIST_INTERVAL_MS)
      : null;
    if (chatPersistTimer !== null) chatPersistTimer.unref();

    // Activity digest scheduler — generates daily/weekly digests automatically
    startDigestScheduler({
      digest_time:     "06:00",
      digest_timezone: "Asia/Manila",
      telegram_digest: false,
    });

    // Keep process alive until signal; clear rotation timer on shutdown
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => { cleanupTimers(); resolve(); });
      process.once("SIGINT",  () => { cleanupTimers(); resolve(); });
    });

    if (chatPersistTimer !== null) clearInterval(chatPersistTimer);
    if (orchestrator !== null) {
      try { await orchestrator.stop(); } catch (_e) { /* cleanup-ignore */ }
    }
    if (db !== null) {
      try { persistChatState(db); } catch (e: unknown) {
        logger.warn("server_chat_persist", "Shutdown chat checkpoint failed", {
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    if (db !== null) {
      try { persistRateLimiterState(db); } catch (e: unknown) {
        logger.warn("server_shutdown", "Rate-limiter state persist failed", {
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    await server.stop();
    try { unlinkSync(pidFile); } catch (e: unknown) { // cleanup-ignore: PID file removal in SIGTERM handler is best-effort — file may already be removed
      void e; // cleanup-ignore
    }
    process.exit(0);
  } catch (err: unknown) {
    logger.error("server_start_failed", "Failed to start API server", {
      error: { code: "SYS-001", message: String(err) },
    });
    process.exit(1);
  }
}
