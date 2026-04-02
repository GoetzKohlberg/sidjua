// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Module Loader
 *
 * Handles install / uninstall / list operations for agent modules.
 * Module code ships compiled with SIDJUA; data (secrets, config, templates)
 * lives in `workDir/.system/modules/<moduleId>/`.
 *
 * Static imports ensure modules are bundled correctly by tsup.
 *
 * SECURITY NOTE: Modules run with full Node.js privileges.
 * There is no sandboxing or code signing in V1.
 * Only install modules from trusted sources.
 * All module installations are logged to the audit trail.
 * See docs/security-limitations-v1.md for details.
 */

import { mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { existsSync }                              from "node:fs";
import { join, resolve }                           from "node:path";
import * as registry                               from "./module-registry.js";
import { SidjuaError }                             from "../core/error-codes.js";
import { createLogger }                            from "../core/logger.js";
import { assertWithinDirectoryReal }                from "../utils/path-utils.js";

// Static imports (not dynamic) for correct bundling
import {
  DISCORD_MODULE_MANIFEST,
  DISCORD_TEMPLATES,
} from "./discord/index.js";

import type { ModuleManifest, ModuleStatus } from "./module-types.js";
import type { SecretsProvider }              from "../types/apply.js";

const logger = createLogger("module-loader");

/**
 * Abstraction over secret sources.
 *
 * Allows module installation to pull secrets from the central SecretsProvider
 * instead of the process environment directly, enabling governed secret access.
 * When not provided, `injectEnvSecrets` falls back to `process.env` when not provided.
 */
export interface SecretEnvSource {
  /** Return the value for the given key, or undefined if not set. */
  get(key: string): string | undefined;
}


/** All modules that ship with SIDJUA */
export const AVAILABLE_MODULES: string[] = ["discord"];

/**
 * First-party (built-in) module identifiers.
 * V1.0 only loads modules from this set. Third-party module loading is
 * blocked until module-signing infrastructure exists (planned post-V1).
 */
export const FIRST_PARTY_MODULES = new Set<string>(["discord"]);

const MANIFESTS: Record<string, ModuleManifest> = {
  discord: DISCORD_MODULE_MANIFEST,
};

const TEMPLATES: Record<string, Record<string, string>> = {
  discord: DISCORD_TEMPLATES,
};

// ---------------------------------------------------------------------------
// In-memory audit log for module lifecycle events
//
// Exposed for testing via getModuleAuditLog() / clearModuleAuditLog().
// In production the events are also written to the structured logger.
// ---------------------------------------------------------------------------

export interface ModuleAuditEvent {
  eventType: "module_install" | "module_uninstall" | "module_load" | "module_install_blocked";
  moduleId:  string;
  version?:  string;
  timestamp: string;
}

/** @internal — exported for test inspection only */
export const _moduleAuditEvents: ModuleAuditEvent[] = [];

/** Return all logged module lifecycle events (for testing). */
export function getModuleAuditLog(): ModuleAuditEvent[] {
  return [..._moduleAuditEvents];
}

/** Clear the in-memory audit log (call in test beforeEach). */
export function clearModuleAuditLog(): void {
  _moduleAuditEvents.length = 0;
}

const MAX_MODULE_AUDIT_EVENTS = 1000;

function logModuleEvent(event: ModuleAuditEvent): void {
  _moduleAuditEvents.push(event);
  if (_moduleAuditEvents.length > MAX_MODULE_AUDIT_EVENTS) {
    _moduleAuditEvents.splice(0, _moduleAuditEvents.length - MAX_MODULE_AUDIT_EVENTS);
  }
  const level = event.eventType === "module_load" ? "info" : "warn";
  logger[level](
    event.eventType,
    `Module ${event.eventType.replace("module_", "")}: ${event.moduleId}`,
    { metadata: { moduleId: event.moduleId, version: event.version } },
  );
}


/**
 * Capability categories that module tools are permitted to declare in V1.
 * Any tool claiming a capability outside this set is rejected at install time
 * so a malicious module cannot silently claim write_secrets or admin privileges.
 */
export const ALLOWED_MODULE_CAPABILITIES = new Set<string>([
  "messaging",   // Send/receive external messages (Discord, Slack, etc.)
  "read",        // Read-only access to external data sources
  "search",      // Query external search APIs
  "notify",      // Send push/webhook notifications
  "webhook",     // Receive inbound webhook events
  "summarize",   // Text summarisation (no external calls)
]);

/**
 * Validate all tool capabilities declared in a module manifest.
 *
 * Throws SEC-013 if any tool claims a capability outside the allowed set.
 * Call before writing module files to disk so a bad manifest is rejected early.
 *
 * Async to support future integration with signed-manifest verification services.
 */
export async function validateModuleCapabilities(manifest: ModuleManifest): Promise<void> {
  const tools = manifest.tools ?? [];
  for (const tool of tools) {
    for (const cap of tool.capabilities) {
      if (!ALLOWED_MODULE_CAPABILITIES.has(cap)) {
        throw SidjuaError.from(
          "SEC-013",
          `Module "${manifest.id}" declares tool "${tool.name}" with disallowed capability "${cap}". ` +
          `Allowed: ${[...ALLOWED_MODULE_CAPABILITIES].join(", ")}`,
        );
      }
    }
  }
}


/**
 * Safe module ID regex:
 *   - 2-64 characters
 *   - Lowercase alphanumeric and hyphens only
 *   - Must start and end with an alphanumeric character
 */
const MODULE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a module ID string.
 * Throws SEC-011 if the ID does not match the safe charset.
 *
 * Module IDs from user input passed without validation could
 * contain path traversal chars or shell metacharacters. Validate at every
 * entry point that accepts a module identifier.
 */
export function validateModuleId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw SidjuaError.from(
      "SEC-011",
      `Invalid module ID "${id}": must be 1-64 characters`,
    );
  }
  if (!MODULE_ID_REGEX.test(id)) {
    throw SidjuaError.from(
      "SEC-011",
      `Invalid module ID "${id}": must be lowercase alphanumeric and hyphens, ` +
      "starting and ending with alphanumeric",
    );
  }
  return id;
}

/**
 * Validate that a module-related path stays within baseDir.
 * Blocks `..` regardless of whether validateModuleId was called first.
 *
 * Extra defense-in-depth guard for all module file-system paths.
 */
function validateModulePath(modulePath: string, baseDir: string): string {
  if (modulePath.includes("..")) {
    throw SidjuaError.from(
      "SEC-010",
      `Module path must not contain "..": "${modulePath}"`,
    );
  }
  const resolved = resolve(modulePath);
  assertWithinDirectoryReal(resolved, baseDir);
  return resolved;
}


/**
 * POSIX env var name regex: uppercase letters, digits, underscores;
 * must start with a letter or underscore.
 */
const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Validate an environment variable name.
 * Throws INPUT-004 on invalid names.
 *
 * Defense-in-depth — keys come from trusted manifests in V1,
 * but this guards against future dynamic key injection.
 */
export function validateEnvName(name: string): string {
  if (!ENV_NAME_REGEX.test(name)) {
    throw SidjuaError.from(
      "INPUT-004",
      `Invalid environment variable name: "${name}"`,
    );
  }
  return name;
}

/**
 * Sanitize an environment variable value for safe writing to a .env file.
 *
 * Values containing `\n` or `\r` can inject additional env var
 * declarations into a .env file (e.g. `TOK=real\nMALICIOUS=injected`).
 * Values with spaces, `#`, or `=` are wrapped in double-quotes.
 *
 * @throws SidjuaError SEC-012 if the value contains newline characters
 */
export function sanitizeEnvValue(value: string): string {
  if (/[\n\r]/.test(value)) {
    throw SidjuaError.from(
      "SEC-012",
      "Environment variable value contains newline/carriage-return characters — possible injection attempt",
    );
  }

  // Wrap in double-quotes if the value contains spaces, `#`, or `=`
  if (/[\s#=]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  return value;
}


/**
 * Write `{ key: value }` pairs to a .env file atomically and with
 * restrictive permissions (0o600 — owner read/write only).
 *
 * Atomic write pattern: write to a `.tmp.<pid>` file, then `rename()` so
 * readers never see a partially-written file. `rename()` is atomic on
 * POSIX when src and dst are on the same filesystem, which is always true
 * here because both paths are within the same `installPath` directory.
 */
async function writeEnvFile(
  envPath:  string,
  secrets:  Record<string, string>,
): Promise<void> {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(secrets)) {
    const validName  = validateEnvName(name);
    const safeValue  = sanitizeEnvValue(value);
    lines.push(`${validName}=${safeValue}`);
  }

  const tmpPath = `${envPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, envPath);
}


/**
 * List all modules that ship with SIDJUA (whether or not installed).
 */
export function listAvailableModules(): Array<{ id: string; manifest: ModuleManifest }> {
  return AVAILABLE_MODULES.map((id) => ({ id, manifest: MANIFESTS[id]! }));
}

/**
 * Get the runtime status of a module (installed + configured check).
 */
export async function getModuleStatus(workDir: string, id: string): Promise<ModuleStatus> {
  validateModuleId(id);

  const manifest = MANIFESTS[id];
  if (!manifest) {
    return { id, installed: false, configured: false, secretsSet: false, missingSecrets: [] };
  }

  const installed = await registry.isInstalled(workDir, id);
  if (!installed) {
    return { id, installed: false, configured: false, secretsSet: false, missingSecrets: [] };
  }

  const installPath = await registry.getInstallPath(workDir, id);
  const missingSecrets = await findMissingSecrets(installPath ?? "", manifest);
  const secretsSet = missingSecrets.length === 0;
  const configured = secretsSet;

  const status: ModuleStatus = {
    id,
    installed,
    configured,
    secretsSet,
    missingSecrets,
    manifest,
  };
  if (installPath !== undefined) {
    status.installPath = installPath;
  }
  return status;
}

/**
 * Install a module: write templates to workDir, register in registry.
 *
 * @param secretSource Optional secret source for injecting secrets during install.
 *                     Defaults to process.env when not provided.
 */
export async function installModule(workDir: string, id: string, secretSource?: SecretEnvSource): Promise<void> {
  validateModuleId(id);

  // First-party policy: only built-in modules are permitted in V1.0
  if (!FIRST_PARTY_MODULES.has(id)) {
    logModuleEvent({
      eventType: "module_install_blocked",
      moduleId:  id,
      timestamp: new Date().toISOString(),
    });
    throw SidjuaError.from(
      "MOD-003",
      `Module "${id}" is not a recognized first-party module. ` +
      "V1.0 only supports built-in modules. Third-party module support requires module signing (planned for future release).",
    );
  }

  const manifest = MANIFESTS[id];
  if (!manifest) {
    throw new Error(`Unknown module: ${id}. Available: ${AVAILABLE_MODULES.join(", ")}`);
  }

  // Validate tool capabilities against governance whitelist before touching disk
  await validateModuleCapabilities(manifest);

  // Warn when a module declares network_policy — V1 has no sandbox enforcement
  if (manifest.network_policy !== undefined) {
    logger.warn(
      "module_network_policy_audit_only",
      `Module "${id}" declares a network_policy but SIDJUA V1 does not enforce it. ` +
      "Network policies are documented for audit purposes only. " +
      "Sandbox enforcement is planned for a future release.",
      {
        metadata: {
          module_id:     id,
          allowed_hosts: manifest.network_policy.allowed_hosts ?? [],
          requires_internet: manifest.network_policy.requires_internet ?? false,
        },
      },
    );
  }

  const installPath = join(workDir, ".system", "modules", id);
  validateModulePath(installPath, join(workDir, ".system", "modules"));  // path traversal guard

  await mkdir(installPath, { recursive: true });

  // Write all template files
  const templates = TEMPLATES[id] ?? {};
  for (const [filename, content] of Object.entries(templates)) {
    const dest = join(installPath, filename);
    if (!existsSync(dest)) {
      await writeFile(dest, content, "utf-8");
    }
  }

  // Copy secrets from environment if available
  await injectEnvSecrets(installPath, manifest, secretSource);

  await registry.register(workDir, {
    id,
    installPath,
    installedAt: new Date().toISOString(),
  });

  // Audit log
  logModuleEvent({
    eventType: "module_install",
    moduleId:  id,
    version:   manifest.version,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Uninstall a module: remove data dir + unregister.
 */
export async function uninstallModule(workDir: string, id: string): Promise<void> {
  validateModuleId(id);

  const installed = await registry.isInstalled(workDir, id);
  if (!installed) {
    throw new Error(`Module ${id} is not installed.`);
  }

  const installPath = await registry.getInstallPath(workDir, id);
  if (installPath) {
    validateModulePath(installPath, join(workDir, ".system", "modules"));  // path traversal guard
    if (existsSync(installPath)) {
      await rm(installPath, { recursive: true, force: true });
    }
  }

  await registry.unregister(workDir, id);

  // Audit log
  logModuleEvent({
    eventType: "module_uninstall",
    moduleId:  id,
    timestamp: new Date().toISOString(),
  });
}

/**
 * List all installed modules with their status.
 */
export async function listInstalledModules(workDir: string): Promise<ModuleStatus[]> {
  const entries = await registry.getInstalled(workDir);
  return Promise.all(entries.map((e) => getModuleStatus(workDir, e.id)));
}

/**
 * Load secrets for a module as a key-value map.
 * Reads from `<installPath>/.env` file (dotenv-style, no library needed).
 */
export async function loadModuleSecrets(installPath: string): Promise<Record<string, string>> {
  const envPath = join(installPath, ".env");
  if (!existsSync(envPath)) return {};
  const raw = await readFile(envPath, "utf-8");
  return parseDotenv(raw);
}

/**
 * Load config for a module from `<installPath>/config.yaml`.
 * Returns raw key-value pairs (flat YAML object).
 */
export async function loadModuleConfig(installPath: string): Promise<Record<string, string>> {
  const configPath = join(installPath, "config.yaml");
  if (!existsSync(configPath)) return {};
  const { parse: parseYaml } = await import("yaml");
  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .map(([k, v]) => [k, String(v)])
  );
}


/**
 * Find required secrets that are not yet set in the .env file.
 */
async function findMissingSecrets(
  installPath: string,
  manifest: ModuleManifest,
): Promise<string[]> {
  if (!manifest.secrets || manifest.secrets.length === 0) return [];
  if (!installPath) return manifest.secrets.filter((s) => s.required).map((s) => s.key);

  const secrets = await loadModuleSecrets(installPath);
  return manifest.secrets
    .filter((s) => s.required && !secrets[s.key])
    .map((s) => s.key);
}

/**
 * Inject secrets from environment variables (or a custom SecretEnvSource) into the .env file.
 * Only writes env vars that match a declared secret key.
 *
 * Uses writeEnvFile() for sanitization + atomic write + 0o600 perms.
 *
 * @param secretSource Optional governed secret source; falls back to `process.env` when not provided.
 */
async function injectEnvSecrets(installPath: string, manifest: ModuleManifest, secretSource?: SecretEnvSource): Promise<void> {
  if (!manifest.secrets || manifest.secrets.length === 0) return;

  // Use injected SecretEnvSource when provided; fall back to the process environment.
  const source: SecretEnvSource = secretSource ?? { get: (k) => process.env[k] };

  const existing = await loadModuleSecrets(installPath);
  let changed = false;

  for (const secret of manifest.secrets) {
    const envVal = source.get(secret.key);
    if (envVal && !existing[secret.key]) {
      existing[secret.key] = envVal;
      changed = true;
    }
  }

  if (changed) {
    const envPath = join(installPath, ".env");
    await writeEnvFile(envPath, existing);
  }
}


/**
 * Injectable I/O interface — lets the CLI use readline while tests mock it.
 */
export interface InstallIO {
  /**
   * Prompt the user for input.
   * @param question   Display text shown before the input cursor.
   * @param opts.secret    Mask input (for tokens / passwords).
   * @param opts.default   Pre-filled default shown in brackets.
   */
  prompt(question: string, opts?: { secret?: boolean; default?: string }): Promise<string>;
  /** Write a line to stdout (no extra newline needed). */
  write(msg: string): void;
}

/**
 * Interactive install: copies templates, then prompts the user for each
 * declared secret and config key, writing results to .env / config.yaml.
 *
 * Call `installModule()` first if you need the directory structure without
 * prompting (e.g. CI / scripted installs using env vars).
 */
export async function interactiveInstall(
  workDir: string,
  id: string,
  io: InstallIO,
): Promise<void> {
  validateModuleId(id);

  // First-party policy: mirrors the check in installModule
  if (!FIRST_PARTY_MODULES.has(id)) {
    logModuleEvent({
      eventType: "module_install_blocked",
      moduleId:  id,
      timestamp: new Date().toISOString(),
    });
    throw SidjuaError.from(
      "MOD-003",
      `Module "${id}" is not a recognized first-party module. ` +
      "V1.0 only supports built-in modules. Third-party module support requires module signing (planned for future release).",
    );
  }

  const manifest = MANIFESTS[id];
  if (!manifest) {
    throw new Error(`Unknown module: ${id}. Available: ${AVAILABLE_MODULES.join(", ")}`);
  }

  // Step 1: non-interactive base install (copies templates, injects env secrets)
  await installModule(workDir, id);

  const installPath = join(workDir, ".system", "modules", id);

  // Step 2: Prompt for secrets not yet set
  if (manifest.secrets && manifest.secrets.length > 0) {
    const existingSecrets = await loadModuleSecrets(installPath);
    const secretsToSet: Record<string, string> = { ...existingSecrets };
    let secretsChanged = false;

    for (const secret of manifest.secrets) {
      if (existingSecrets[secret.key]) {
        io.write(`  ${secret.key}: already set — skipping`);
        continue;
      }

      io.write(`\n${secret.description}`);
      const value = await io.prompt(`  Enter ${secret.key}`, { secret: secret.key.toLowerCase().includes("token") || secret.key.toLowerCase().includes("password") });
      if (value.trim()) {
        secretsToSet[secret.key] = value.trim();
        secretsChanged = true;
      } else if (secret.required) {
        io.write(`  ⚠ ${secret.key} is required — skipping for now. Add it manually to ${installPath}/.env`);
      }
    }

    if (secretsChanged) {
      // Sanitized + atomic write
      await writeEnvFile(join(installPath, ".env"), secretsToSet);
    }
  }

  // Step 3: Prompt for config values
  if (manifest.config && manifest.config.length > 0) {
    const existingConfig = await loadModuleConfig(installPath);
    const configToWrite: Record<string, string> = { ...existingConfig };
    let configChanged = false;

    for (const cfg of manifest.config) {
      if (existingConfig[cfg.key]) {
        io.write(`  ${cfg.key}: already set — skipping`);
        continue;
      }
      const defaultVal = cfg.default ?? "";
      io.write(`\n${cfg.description}${defaultVal ? ` [${defaultVal}]` : ""}`);
      const value = await io.prompt(`  Enter ${cfg.key}`, { default: defaultVal });
      const resolved = value.trim() || defaultVal;
      if (resolved) {
        configToWrite[cfg.key] = resolved;
        configChanged = true;
      }
    }

    if (configChanged) {
      const lines = Object.entries(configToWrite)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      await writeFile(join(installPath, "config.yaml"), lines + "\n", "utf-8");
    }
  }
}

/**
 * Create a readline-backed InstallIO for real CLI use.
 * Lazy-imported to keep module-loader usable without a TTY.
 */
export async function createReadlineIO(): Promise<InstallIO> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return {
    write(msg: string): void {
      process.stdout.write(msg + "\n");
    },

    async prompt(question: string, opts?: { secret?: boolean; default?: string }): Promise<string> {
      const suffix = opts?.default ? ` [${opts.default}]` : "";
      return new Promise<string>((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer);
        });
      });
    },
  };
}

/**
 * Parse a dotenv-style string into key-value pairs.
 * Supports `KEY=value` and `KEY="value"` syntax.
 * Ignores comments (`# ...`) and blank lines.
 */
export function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}


// ---------------------------------------------------------------------------
// Central secret store access for modules
// ---------------------------------------------------------------------------

const MODULE_SECRET_NAMESPACE_PREFIX = "module.";

/**
 * Remove a single key from a module's .env file, rewriting atomically.
 * No-op if the file or key does not exist.
 */
async function removeFromModuleEnv(installPath: string, secretName: string): Promise<void> {
  const envPath = join(installPath, ".env");
  if (!existsSync(envPath)) return;
  try {
    const raw     = await readFile(envPath, "utf8");
    const entries = parseDotenv(raw);
    if (!(secretName in entries)) return;
    delete entries[secretName];
    await writeEnvFile(envPath, entries);
  } catch (_e) {
    // Non-fatal — leave the .env file intact on read/write failure
  }
}

/**
 * Retrieve a module secret, preferring the central encrypted secrets store.
 *
 * Resolution order:
 *   1. Central secrets store: `provider.get("module.<moduleName>", secretName)`
 *   2. `.env` file in the module install directory (legacy; triggers migration)
 *   3. `undefined` — caller should handle missing secret
 *
 * When a value is found in the .env file and a provider is available, the
 * value is migrated to the central store and removed from the .env file so
 * that the next call resolves via path (1).
 *
 * @param moduleName  Short module identifier (e.g. "discord")
 * @param secretName  Secret key (e.g. "DISCORD_BOT_TOKEN")
 * @param installPath Absolute path to the module install directory
 * @param provider    Central secrets provider; optional — omit in test/env contexts
 */
export async function getModuleSecret(
  moduleName:  string,
  secretName:  string,
  installPath: string,
  provider?:   SecretsProvider,
): Promise<string | undefined> {
  const namespace = `${MODULE_SECRET_NAMESPACE_PREFIX}${moduleName}`;

  // Path 1: central store
  if (provider !== undefined) {
    try {
      const stored = await provider.get(namespace, secretName);
      if (stored !== null && stored !== "") return stored;
    } catch (_e) {
      // Fall through to .env fallback on provider error
    }
  }

  // Path 2: .env file (legacy)
  const envPath = join(installPath, ".env");
  if (existsSync(envPath)) {
    try {
      const raw   = await readFile(envPath, "utf8");
      const env   = parseDotenv(raw);
      const value = env[secretName];

      if (value !== undefined && value !== "") {
        logger.warn(
          "module_secret_env_fallback",
          `Module "${moduleName}" secret "${secretName}" loaded from .env — migrate to secrets store`,
          { metadata: { moduleName, secretName } },
        );

        // Migrate to central store and remove from .env
        if (provider !== undefined) {
          try {
            await provider.ensureNamespace(namespace);
            await provider.set(namespace, secretName, value);
            await removeFromModuleEnv(installPath, secretName);
            logger.info(
              "module_secret_migrated",
              `Migrated "${moduleName}/${secretName}" from .env to central secrets store`,
              { metadata: { moduleName, secretName } },
            );
          } catch (_e) {
            // Migration failure is non-fatal — value already in hand
          }
        }

        return value;
      }
    } catch (_e) {
      // Non-fatal — .env unreadable
    }
  }

  return undefined;
}
