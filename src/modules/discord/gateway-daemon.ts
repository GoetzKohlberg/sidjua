// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Discord Module — Gateway Daemon
 *
 * Standalone Node.js process. NOT part of the API server.
 *
 * Usage:
 *   node dist/modules/discord/gateway-daemon-bin.js
 *
 * Config sources (in priority order):
 *   SIDJUA_WORK_DIR env var → {workDir}/.system/modules/discord/
 *   Default: {cwd}/.system/modules/discord/
 *
 * Health file: {moduleDir}/gateway.pid
 *   Line 1: PID
 *   Line 2: startup timestamp (ms)
 *
 * Reads SIGTERM/SIGINT for clean shutdown.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve }  from "node:path";
import { createRequire }  from "node:module";
import { parse as parseYaml } from "yaml";
import { assertWithinDirectoryReal } from "../../utils/path-utils.js";
import type { SecretEnvSource } from "../module-loader.js";
import { getModuleSecret }      from "../module-loader.js";
import type { SecretsProvider } from "../../types/apply.js";

import { DiscordGateway }    from "./discord-gateway.js";
import { DiscordClient }     from "./discord-client.js";
import { SupportHandler }    from "./handlers/support-handler.js";
import { DocMatcher }        from "./handlers/doc-matcher.js";
import { RedmineHandler }    from "./handlers/redmine-handler.js";
import type { GatewayMessage, DiscordModuleConfig } from "./discord-types.js";
import type { WsFactory, WsLike }  from "./discord-gateway.js";


/** Write PID + start timestamp to the pid file. */
export function writePidFile(pidFile: string, pid = process.pid): void {
  writeFileSync(pidFile, `${pid}\n${Date.now()}\n`, "utf8");
}

/** Read pid file. Returns null if file does not exist or is invalid. */
export function readPidFile(pidFile: string): { pid: number; startMs: number } | null {
  if (!existsSync(pidFile)) return null;
  const [pidLine, msLine] = readFileSync(pidFile, "utf8").split("\n");
  const pid = parseInt(pidLine ?? "", 10);
  const startMs = parseInt(msLine ?? "", 10);
  if (isNaN(pid) || isNaN(startMs)) return null;
  return { pid, startMs };
}


export interface LoadedConfig {
  token:          string;
  guildId:        string;
  supportChannels: string[];
  bugChannels:     string[];
  redmineApiKey?:  string;
  redmineUrl:      string;
}

/** Parse a .env file into key/value pairs. */
function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key   = trimmed.slice(0, eqIdx).trim();
    const val   = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key.length > 0) result[key] = val;
  }
  return result;
}

/**
 * Load module config from the given install directory.
 *
 * @param secretSource Optional governed secret source. When provided,
 *   the environment fallback for secrets is replaced by this source.
 */
export function loadDaemonConfig(moduleDir: string, secretSource?: SecretEnvSource): LoadedConfig {
  const envSource: SecretEnvSource = secretSource ?? { get: (k) => process.env[k] };
  if (!existsSync(moduleDir)) {
    throw new Error(`Discord module directory not found: ${moduleDir}`);
  }

  // Validate all config file paths are within moduleDir to prevent
  // path traversal if moduleDir is ever derived from user-controllable input.
  const envFile    = join(moduleDir, ".env");
  const configFile = join(moduleDir, "config.yaml");
  assertWithinDirectoryReal(envFile,    moduleDir);
  assertWithinDirectoryReal(configFile, moduleDir);

  // Secrets from .env file first; fall back to envSource (defaults to process.env)
  const env   = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf8")) : {};
  const token = env["DISCORD_BOT_TOKEN"] ?? envSource.get("DISCORD_BOT_TOKEN");

  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN not set — add to .system/modules/discord/.env");
  }

  // Use proper YAML parser instead of regex-based line matching.
  // The previous regex parser silently dropped multi-line values and could
  // misparse values containing colons or quote characters.
  const rawConfig: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf8");
    const parsed  = parseYaml(content) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(rawConfig, parsed as Record<string, unknown>);
    }
  }

  const guildId = typeof rawConfig["guild_id"] === "string" ? rawConfig["guild_id"] : undefined;
  if (guildId === undefined || guildId.length === 0) {
    throw new Error("guild_id not configured — set in .system/modules/discord/config.yaml");
  }

  const supportChannel = typeof rawConfig["support_channel"] === "string"
    ? rawConfig["support_channel"] : "support";
  const bugChannel     = typeof rawConfig["bug_channel"] === "string"
    ? rawConfig["bug_channel"] : "bug-reports";
  const redmineUrl     = typeof rawConfig["redmine_url"] === "string"
    ? rawConfig["redmine_url"] : "http://localhost:8080";
  const redmineApiKey  = env["REDMINE_API_KEY"] ?? envSource.get("REDMINE_API_KEY");

  const result: LoadedConfig = {
    token,
    guildId,
    supportChannels: [supportChannel],
    bugChannels:     [bugChannel],
    redmineUrl,
  };
  if (redmineApiKey !== undefined) result.redmineApiKey = redmineApiKey;
  return result;
}


/** Load docs from the given directory. Returns entries for DocMatcher. */
export function loadDocEntries(docsDir: string): Array<{ filename: string; content: string }> {
  const targets = [
    "CLI-REFERENCE.md",
    "SIDJUA-CONCEPTS.md",
    "QUICK-START.md",
    "TROUBLESHOOTING.md",
    "USER-MANUAL.md",
    "GOVERNANCE-EXAMPLES.md",
  ];

  const entries: Array<{ filename: string; content: string }> = [];
  for (const name of targets) {
    const path = join(docsDir, name);
    if (existsSync(path)) {
      entries.push({ filename: name, content: readFileSync(path, "utf8") });
    }
  }
  return entries;
}


/**
 * Filter incoming messages to only process configured support/bug channels.
 * Returns true if the message should be handled.
 */
export function shouldHandleMessage(
  msg:               GatewayMessage,
  channelIds:        Set<string>,
): boolean {
  if (msg.author.bot === true) return false;
  if (msg.guild_id === undefined) return false;
  return channelIds.has(msg.channel_id);
}


export interface DaemonOptions {
  workDir:       string;
  moduleDir:     string;
  docsDir:       string;
  pidFile:       string;
  WsFactory?:    WsFactory;
  fetchFn?:      typeof fetch;
  /** Governed secret source; defaults to the process environment when not provided. */
  secretSource?: SecretEnvSource;
}

export interface Daemon {
  gateway:    DiscordGateway;
  stop():     void;
}


/**
 * Start the Gateway daemon.
 *
 * Exported for testing — the main() function at the bottom is the runtime
 * entry point.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const config = loadDaemonConfig(opts.moduleDir, opts.secretSource);
  const docEntries = loadDocEntries(opts.docsDir);

  // Create REST client
  const clientOpts = opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {};
  const client = new DiscordClient(config.token, clientOpts);

  // Resolve support channel IDs via REST
  const supportChannelIds = new Set<string>();
  for (const name of [...config.supportChannels, ...config.bugChannels]) {
    const id = await client.resolveChannelId(config.guildId, name);
    if (id !== undefined) {
      supportChannelIds.add(id);
    } else {
      process.stderr.write(`[gateway-daemon] Warning: channel "${name}" not found in guild\n`);
    }
  }

  // Get bot user ID
  const botUser   = await client.getCurrentUser();
  const botUserId = botUser.id;

  // Create handlers
  const docMatcher = new DocMatcher(docEntries);

  const redmineHandler = config.redmineApiKey !== undefined
    ? new RedmineHandler(
        { apiKey: config.redmineApiKey, baseUrl: config.redmineUrl },
        client,
        opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {},
      )
    : null;

  const handler = new SupportHandler(client, docMatcher, redmineHandler, {
    supportChannelIds,
    botUserId,
  });

  // Create Gateway
  const gatewayOpts: import("./discord-gateway.js").DiscordGatewayOptions = {};
  if (opts.WsFactory !== undefined) gatewayOpts.WsFactory = opts.WsFactory;
  if (opts.fetchFn   !== undefined) gatewayOpts.fetchFn   = opts.fetchFn;
  const gateway = new DiscordGateway(config.token, gatewayOpts);

  gateway.on("message", (msg: GatewayMessage) => {
    void handler.handleMessage(msg);
  });

  gateway.on("ready", () => {
    process.stdout.write(
      `[gateway-daemon] Discord Gateway connected — listening on ${config.supportChannels.concat(config.bugChannels).map((c) => `#${c}`).join(", ")}\n`,
    );
  });

  gateway.on("error", (err: Error) => {
    process.stderr.write(`[gateway-daemon] Gateway error: ${err.message}\n`);
  });

  // Write PID file
  writePidFile(opts.pidFile);

  // Connect
  await gateway.connect();

  return {
    gateway,
    stop(): void {
      gateway.disconnect();
      process.stdout.write("[gateway-daemon] Discord Gateway disconnected\n");
    },
  };
}


/**
 * Retrieve a Discord module secret from the central encrypted secrets store,
 * falling back to the module `.env` file with automatic migration.
 *
 * @param secretName  Secret key (e.g. "DISCORD_BOT_TOKEN")
 * @param installPath Absolute path to the Discord module install directory
 * @param provider    Central secrets provider; optional
 */
export async function getDiscordModuleSecret(
  secretName:  string,
  installPath: string,
  provider?:   SecretsProvider,
): Promise<string | undefined> {
  return getModuleSecret("discord", secretName, installPath, provider);
}


export async function main(): Promise<void> {
  const workDir   = resolve(process.env["SIDJUA_WORK_DIR"] ?? process.cwd());
  const moduleDir = join(workDir, ".system", "modules", "discord");
  const docsDir   = join(workDir, "docs");
  const pidFile   = join(moduleDir, "gateway.pid");

  process.stdout.write("[gateway-daemon] Starting SIDJUA Discord Gateway daemon\n");

  let daemon: Daemon | null = null;

  const shutdown = (): void => {
    process.stdout.write("[gateway-daemon] Shutdown signal received\n");
    if (daemon !== null) {
      daemon.stop();
    }
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT",  shutdown);

  try {
    daemon = await startDaemon({ workDir, moduleDir, docsDir, pidFile });
  } catch (err) {
    process.stderr.write(`[gateway-daemon] Fatal: ${String(err)}\n`);
    process.exit(1);
  }
}

