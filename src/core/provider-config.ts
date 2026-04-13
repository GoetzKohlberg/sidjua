// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Configuration Storage
 *
 * Stores the user's selected LLM provider configuration in the SIDJUA data
 * directory with AES-256-GCM encrypted API keys.
 *
 * Storage layout:
 *   {dataRoot}/config/provider-config.json  — encrypted provider config
 *   {dataRoot}/config/.provider-master-key  — 32-byte hex encryption key
 *
 * Falls back to in-memory storage if the data directory is not writable.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join }                                             from "node:path";
import { createCipheriv, createDecipheriv, randomBytes }   from "node:crypto";
import { resolvePaths }                                     from "./paths.js";
import { createLogger }                                     from "./logger.js";
import { SidjuaError }                                      from "./error-codes.js";

const logger = createLogger("provider-config");

const ALGO = "aes-256-gcm";


/** Provider entry as stored on disk (key encrypted). */
interface StoredProvider {
  provider_id:       string;
  /** AES-256-GCM encrypted API key, base64-encoded as iv:tag:ciphertext. */
  api_key_encrypted: string;
  api_base?:         string;
  model?:            string;
  custom_name?:      string;
}

/** Full config as stored on disk. */
interface StoredConfig {
  version:          number;
  mode:             "simple" | "advanced";
  default_provider: StoredProvider | null;
  agent_overrides:  Record<string, StoredProvider>;
}


/** A provider entry with the plaintext API key. */
export interface ConfiguredProvider {
  provider_id:   string;
  api_key:       string;
  api_base?:     string;
  model?:        string;
  custom_name?:  string;
}

/** The full provider configuration (decrypted). */
export interface ProviderConfig {
  mode:             "simple" | "advanced";
  default_provider: ConfiguredProvider | null;
  agent_overrides:  Record<string, ConfiguredProvider>;
}


let _memoryConfig: ProviderConfig | null   = null;
let _memoryMode:   "fs" | "memory"         = "memory";


function encryptKey(plaintext: string, masterKey: Buffer): string {
  const iv       = randomBytes(12); // 96-bit IV for GCM
  const cipher   = createCipheriv(ALGO, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag      = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptKey(ciphertext: string, masterKey: Buffer): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}


let _masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (_masterKey !== null) return _masterKey;

  try {
    const paths    = resolvePaths();
    const configDir = paths.data.config;
    const keyPath  = join(configDir, ".provider-master-key");

    if (existsSync(keyPath)) {
      const hex = readFileSync(keyPath, "utf-8").trim();

      // Validate: 64 hex chars = 32 bytes for AES-256-GCM.
      // A truncated or corrupted key would silently produce wrong encryptions.
      if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
        throw SidjuaError.from(
          "PCFG-002",
          `Invalid provider master key in ${keyPath}: ` +
          `expected 64 hex chars (32 bytes for AES-256), got ${hex.length} chars. ` +
          `Delete the file to auto-generate a new key (existing encrypted configs will be lost).`,
        );
      }

      // Warn on insecure file permissions (non-Windows only).
      if (process.platform !== "win32") {
        try {
          const mode = statSync(keyPath).mode & 0o777;
          if (mode !== 0o600) {
            logger.warn("provider_config", `Master key file has insecure permissions (${mode.toString(8)}, expected 600) — repairing`, {
              metadata: { path: keyPath },
            });
            chmodSync(keyPath, 0o600);
          }
        } catch (_statErr) { /* non-fatal */ }
      }

      _masterKey  = Buffer.from(hex, "hex");
      _memoryMode = "fs";
      return _masterKey;
    }

    // Generate a new key
    const newKey = randomBytes(32);
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(keyPath, newKey.toString("hex"), { mode: 0o600 });
      chmodSync(keyPath, 0o600); // belt-and-suspenders: enforce 0o600 regardless of umask
      _masterKey  = newKey;
      _memoryMode = "fs";
      logger.info("provider_config", "Generated new provider master key", { metadata: { path: keyPath } });
    } catch (e: unknown) {
      if (process.env["SIDJUA_EPHEMERAL"] === "true") {
        logger.info("provider_config", "Ephemeral mode — using in-memory master key (config not persisted)", {});
        _masterKey  = newKey;
        _memoryMode = "memory";
      } else {
        throw SidjuaError.from(
          "PCFG-005",
          `Cannot persist provider master key to ${keyPath}: ${e instanceof Error ? e.message : String(e)}. ` +
          `Set SIDJUA_EPHEMERAL=true for in-memory mode (config lost on restart).`,
        );
      }
    }
    return _masterKey;
  } catch (e: unknown) {
    if (e instanceof SidjuaError) throw e;
    if (process.env["SIDJUA_EPHEMERAL"] === "true") {
      logger.info("provider_config", "Ephemeral mode — path resolution skipped, using in-memory master key", {});
      if (_masterKey === null) _masterKey = randomBytes(32);
      _memoryMode = "memory";
      return _masterKey;
    }
    throw SidjuaError.from(
      "PCFG-005",
      `Provider config path resolution failed: ${e instanceof Error ? e.message : String(e)}. ` +
      `Set SIDJUA_EPHEMERAL=true for in-memory mode.`,
    );
  }
}


function getConfigPath(): string | null {
  try {
    const paths = resolvePaths();
    return join(paths.data.config, "provider-config.json");
  } catch (_pathErr: unknown) {
    return null;
  }
}


function encryptProvider(p: ConfiguredProvider, masterKey: Buffer): StoredProvider {
  const stored: StoredProvider = {
    provider_id:       p.provider_id,
    api_key_encrypted: encryptKey(p.api_key, masterKey),
  };
  if (p.api_base     !== undefined) stored.api_base     = p.api_base;
  if (p.model        !== undefined) stored.model        = p.model;
  if (p.custom_name  !== undefined) stored.custom_name  = p.custom_name;
  return stored;
}

function decryptProvider(s: StoredProvider, masterKey: Buffer): ConfiguredProvider {
  return {
    provider_id:  s.provider_id,
    api_key:      decryptKey(s.api_key_encrypted, masterKey),
    ...(s.api_base    !== undefined ? { api_base:    s.api_base }    : {}),
    ...(s.model       !== undefined ? { model:       s.model }       : {}),
    ...(s.custom_name !== undefined ? { custom_name: s.custom_name } : {}),
  };
}

function configToStored(config: ProviderConfig, masterKey: Buffer): StoredConfig {
  const overrides: Record<string, StoredProvider> = {};
  for (const [agentId, p] of Object.entries(config.agent_overrides)) {
    overrides[agentId] = encryptProvider(p, masterKey);
  }
  return {
    version:          1,
    mode:             config.mode,
    default_provider: config.default_provider !== null
                        ? encryptProvider(config.default_provider, masterKey)
                        : null,
    agent_overrides:  overrides,
  };
}

function storedToConfig(stored: StoredConfig, masterKey: Buffer): ProviderConfig {
  const overrides: Record<string, ConfiguredProvider> = {};
  for (const [agentId, p] of Object.entries(stored.agent_overrides)) {
    overrides[agentId] = decryptProvider(p, masterKey);
  }
  return {
    mode:             stored.mode,
    default_provider: stored.default_provider !== null
                        ? decryptProvider(stored.default_provider, masterKey)
                        : null,
    agent_overrides:  overrides,
  };
}


/**
 * Load the current provider configuration.
 * Returns null if no configuration has been saved yet.
 */
export function getProviderConfig(): ProviderConfig | null {
  // Always call getMasterKey() first — it reads the key file from disk and sets
  // _memoryMode to "fs" when the key file is found. Without this call, _memoryMode
  // stays "memory" after process restart and null is returned even though a saved
  // config exists on disk (causes "Invalid API key" / "no_provider" errors after restart).
  const masterKey = getMasterKey();

  if (_memoryMode === "memory") {
    return _memoryConfig;
  }

  const configPath = getConfigPath();
  if (configPath === null || !existsSync(configPath)) {
    return _memoryConfig;
  }

  try {
    const raw    = readFileSync(configPath, "utf-8");
    const stored = JSON.parse(raw) as StoredConfig;
    return storedToConfig(stored, masterKey);
  } catch (e: unknown) {
    if (e instanceof SidjuaError) throw e;
    // Config file exists but cannot be read — this is a disk failure, not absence.
    // Throw instead of silently returning null to prevent data loss.
    throw SidjuaError.from(
      "PCFG-005",
      `Failed to read provider config from ${configPath}: ${e instanceof Error ? e.message : String(e)}. ` +
      `Check file permissions and disk health.`,
    );
  }
}

/**
 * Save the provider configuration.
 * API keys are encrypted before writing to disk.
 */
export function saveProviderConfig(config: ProviderConfig): void {
  const masterKey = getMasterKey();
  const stored    = configToStored(config, masterKey);

  // Always update in-memory cache
  _memoryConfig = config;

  if (_memoryMode === "memory") {
    logger.warn("provider_config", "Saving provider config in memory only — will be lost on restart", {});
    return;
  }

  const configPath = getConfigPath();
  if (configPath === null) {
    logger.warn("provider_config", "Cannot determine config path — saving in memory only", {});
    return;
  }

  try {
    const configDir = join(configPath, "..");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
    logger.info("provider_config", "Provider config saved", { metadata: { path: configPath } });
  } catch (writeErr: unknown) {
    // Disk write failure in fs mode is an error — do not silently swallow
    throw SidjuaError.from(
      "PCFG-005",
      `Failed to persist provider config to disk (${configPath}): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}. ` +
      `Set SIDJUA_EPHEMERAL=true for in-memory mode.`,
    );
  }
}

/**
 * Delete the stored provider configuration.
 * Clears both in-memory and on-disk storage.
 */
export function deleteProviderConfig(): void {
  _memoryConfig = null;

  const configPath = getConfigPath();
  if (configPath !== null && existsSync(configPath)) {
    try {
      // Overwrite with empty config rather than deleting to avoid permission issues
      const empty: StoredConfig = {
        version: 1, mode: "simple", default_provider: null, agent_overrides: {},
      };
      writeFileSync(configPath, JSON.stringify(empty, null, 2), { mode: 0o600 });
      logger.info("provider_config", "Provider config cleared", { metadata: { path: configPath } });
    } catch (e: unknown) {
      logger.warn("provider_config", "Failed to clear provider config file", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}

/**
 * Return true if at least a default provider has been configured.
 */
export function isProviderConfigured(): boolean {
  const config = getProviderConfig();
  return config !== null && config.default_provider !== null;
}

/**
 * Return the effective provider for a given agent.
 * Returns the agent-specific override if set; otherwise returns the default.
 * Returns null if no provider is configured.
 */
export function getProviderForAgent(agentId: string): ConfiguredProvider | null {
  const config = getProviderConfig();
  if (config === null) return null;

  const override = config.agent_overrides[agentId];
  if (override !== undefined) {
    // D6: custom override with empty api_key → inherit default_provider.api_key at runtime
    if (override.api_key === "" && config.default_provider !== null) {
      return { ...override, api_key: config.default_provider.api_key };
    }
    return override;
  }

  return config.default_provider;
}

/**
 * Reset cached state (for testing only).
 *
 * Clears in-memory state AND removes the on-disk provider config file so that
 * subsequent calls to getProviderConfig() return null regardless of prior test runs.
 * The master key file is left in place (it is the encryption key, not the config).
 *
 * This function must never be called from production code.
 */
export function resetProviderConfigState(): void {
  _memoryConfig = null;
  _masterKey    = null;
  _memoryMode   = "memory";

  // Remove the on-disk provider config so getProviderConfig() returns null after
  // reset, even though getMasterKey() now reads from disk on every call.
  try {
    const configPath = getConfigPath();
    if (configPath !== null && existsSync(configPath)) {
      unlinkSync(configPath);
    }
  } catch (_e) { /* ignore — test environment may not have write access */ }
}
