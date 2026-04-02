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
import type { Context } from "hono";
import { generateSecret } from "../core/crypto-utils.js";
import { existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname, extname, resolve as resolvePath } from "node:path";
import { assertWithinDirectory } from "../utils/path-utils.js";
import { redactPii } from "../core/telemetry/pii-redactor.js";
import { createLogger, configureLogger } from "../core/logger.js";
import { loadKeyState, persistKeyState } from "./key-store.js";
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
import { persistRateLimiterState, restoreRateLimiterState } from "./middleware/rate-limiter.js";
import { bootstrapOrchestrator }     from "../orchestrator/bootstrap.js";
import type { OrchestratorProcess }  from "../orchestrator/orchestrator.js";
import { TokenStore }                from "./token-store.js";
import { chmodSync }                 from "node:fs";
import { UploadStore }               from "../uploads/upload-store.js";
import { FileStorage }               from "../uploads/file-storage.js";
import { ExtractionService }         from "../uploads/extraction-service.js";
import { UploadEmbedder }            from "../uploads/upload-embedder.js";
import { createVectorStore }         from "../knowledge-pipeline/vector-store/index.js";

import { SIDJUA_VERSION } from "../version.js";

/** Structured PID file format — replaces plain integer for process identity verification. */
interface PidFileData {
  pid:       number;
  startTime: number;
  command:   string;
  version:   string;
}

/** MIME types for GUI static file serving. */
const MIME_TYPES: Record<string, string> = {
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".ico":   "image/x-icon",
  ".json":  "application/json",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

/** Serve a static file from the GUI dist directory. */
function serveGuiFile(c: Context, dir: string, filename: string): Response {
  const filePath = join(dir, filename);

  // Security: resolve symlinks FIRST, then verify the real path stays within dir.
  // Resolving before checking prevents symlink traversal attacks where a symlink
  // inside the allowed directory points to a file outside it.
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }

  try {
    assertWithinDirectory(realPath, realpathSync(dir));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  const ext  = extname(realPath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(realPath);
  return c.newResponse(body, 200, { "Content-Type": mime });
}

/**
 * Serve index.html with the API key injected server-side (P281).
 *
 * The bootstrap payload is written into `window.__SIDJUA_BOOTSTRAP__` before
 * `</head>` so the GUI can read the key without a separate HTTP round-trip.
 *
 * Security constraints:
 *   - Key is injected ONLY for loopback requests (Host: localhost / 127.0.0.1 / ::1).
 *   - Non-local requests receive an empty payload `{}`.
 *   - Response is always `Cache-Control: no-store, no-cache` to prevent the key
 *     from being stored in browser or proxy caches.
 */
function serveIndexHtmlWithBootstrap(
  c: Context,
  guiDist: string,
  getApiKey: () => string,
): Response {
  const filePath = join(guiDist, "index.html");
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }
  try {
    assertWithinDirectory(realPath, realpathSync(guiDist));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  // Use the TCP peer address set server-side by toWebRequest() — not the Host header,
  // which is client-controlled and trivially spoofable.  Fail-closed: if the peer
  // address header is absent (e.g. test environment), do NOT inject the API key.
  const peerAddr = c.req.header("x-sidjua-peer-address") ?? "";
  const isLocal  = peerAddr === "127.0.0.1" || peerAddr === "::1" || peerAddr === "::ffff:127.0.0.1";

  let serverUrl = "";
  try { serverUrl = new URL(c.req.url).origin; } catch (_err) { /* non-fatal — GUI falls back to window.location.origin */ }

  const payload = (isLocal
    ? JSON.stringify({ api_key: getApiKey(), server_url: serverUrl })
    : JSON.stringify({})
  ).replace(/</g, "\\u003c");

  const script = `<script>window.__SIDJUA_BOOTSTRAP__ = ${payload};</script>`;
  const html   = readFileSync(realPath, "utf-8").replace("</head>", `  ${script}\n  </head>`);

  return c.newResponse(html, 200, {
    "Content-Type":  "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache",
    "Pragma":        "no-cache",
  });
}

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
      // --detach is documented as a V1.1 feature; inform user and continue in foreground.
      if (opts.detach) {
        process.stderr.write("Detached mode (--detach) is not yet implemented. Server runs in foreground.\n");
        process.stderr.write("Use a process manager (pm2, systemd) for background execution.\n");
        // Don't exit — still start in foreground as fallback
      }
      // Load persisted key state from DB (survives restart).
      // A pending key whose expiry is still in the future is honored, allowing
      // clients using the old key to continue working after a restart mid-rotation.
      const dbPath = join(opts.workDir, ".system", "sidjua.db");
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
      const db       = openDatabase(dbPath);
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

      const server = createApiServer(config);
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
      let orchestrator: OrchestratorProcess | null = null;
      try {
        const orcConfigPath = join(opts.workDir, "governance", "orchestrator.yaml");
        orchestrator = await bootstrapOrchestrator({
          db,
          workDir: opts.workDir,
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
        baseDir:      join(opts.workDir, 'data', 'uploads'),
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
        workDir:      opts.workDir,
        registry,
        orchestrator,
        secrets:      null,
        integration:  null,
        tokenStore,
        getApiKey:    getActiveApiKey,
        uploadStore,
        fileStorage,
        extractionService,
      });

      // ── GUI static file serving ───────────────────────────────────────────────
      // Locate sidjua-gui/dist relative to the package root.
      // dist/index.js is the bundle entry; one level up is the package root.
      const pkgRoot = resolvePath(new URL(".", import.meta.url).pathname, "../");
      const guiDist = join(pkgRoot, "sidjua-gui", "dist");
      const hasGui  = existsSync(join(guiDist, "index.html"));

      if (hasGui) {
        const getKey = () => apiKeyState.currentApiKey;
        server.app.get("/",           (c) => serveIndexHtmlWithBootstrap(c, guiDist, getKey));
        server.app.get("/index.html", (c) => serveIndexHtmlWithBootstrap(c, guiDist, getKey));
        server.app.get("/favicon.ico",(c) => serveGuiFile(c, guiDist, "favicon.ico"));
        server.app.get("/assets/*",   (c) => {
          const assetPath = c.req.path.replace(/^\/assets\//, "");
          return serveGuiFile(c, join(guiDist, "assets"), assetPath);
        });
        // SPA fallback — serve index.html for all unmatched non-API routes
        server.app.get("/*", (c) => {
          if (c.req.path.startsWith("/api/")) return c.notFound();
          return serveIndexHtmlWithBootstrap(c, guiDist, getKey);
        });
      }

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
        process.on("uncaughtException",    (err) => { writeErrorLog("uncaughtException", err); });
        process.on("unhandledRejection",   (err) => { writeErrorLog("unhandledRejection", err); });
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
          process.once("SIGTERM", () => { cleanupApiKeyTimers(); resolve(); });
          process.once("SIGINT",  () => { cleanupApiKeyTimers(); resolve(); });
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
          const pidData = JSON.parse(raw) as PidFileData;
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
