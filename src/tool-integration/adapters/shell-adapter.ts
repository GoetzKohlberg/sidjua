// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Shell adapter — whitelist-enforced command execution.
 * macOS/Linux: bash -c <cmd>; Windows: powershell.exe -Command <cmd>
 * Strips secrets from env; caps output at 1MB; enforces timeout.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { parse as shellParse } from "shell-quote";
import type {
  ToolAdapter,
  ToolAction,
  ToolCapability,
  ToolResult,
  ToolType,
  ShellToolConfig,
} from "../types.js";
import { createLogger } from "../../core/logger.js";
import { SidjuaError } from "../../core/error-codes.js";

const logger = createLogger("shell-adapter");
const execFileAsync = promisify(execFile);


/**
 * Commands that are always blocked as an additional safety net, even if listed
 * in allowed_commands. These cannot be executed regardless of configuration.
 * Note: the primary security control is the mandatory allowed_commands allowlist.
 */
const ALWAYS_BLOCKED_COMMANDS = new Set([
  "sudo",
  "su",
]);

const SECRET_ENV_PATTERN = /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Shell metacharacters that enable command injection when a command string
 * is passed to a shell interpreter. Reject any argument containing these.
 */
const SHELL_METACHAR_PATTERN = /[;&|`$(){}[\]<>!#~*?\\"'\n\r]/;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB


interface SpawnOpts {
  cwd:       string;
  env:       Record<string, string>;
  timeoutMs: number;
  maxBytes:  number;
}

/**
 * Execute a command with `shell: false` (no shell interpretation).
 * Accumulates stdout/stderr up to maxBytes and enforces a timeout.
 */
function spawnCollect(
  cmd:  string,
  args: string[],
  opts: SpawnOpts,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      shell: false, // CRITICAL: no shell interpretation
      cwd:   opts.cwd,
      env:   opts.env,
    });

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`Command timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > opts.maxBytes) {
        proc.kill();
        reject(new Error(`Command output exceeded ${opts.maxBytes} bytes`));
        return;
      }
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > opts.maxBytes) {
        proc.kill();
        reject(new Error(`Command output exceeded ${opts.maxBytes} bytes`));
        return;
      }
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", () => {
      clearTimeout(timer);
      if (!timedOut) resolve({ stdout, stderr });
    });
  });
}


export class ShellAdapter implements ToolAdapter {
  readonly id: string;
  readonly type: ToolType = "shell";

  private readonly config: ShellToolConfig;
  private readonly capabilities: ToolCapability[];
  private connected = false;

  /** Set of commands explicitly allowed to run. Required — constructor throws if absent. */
  private readonly allowedSet: Set<string>;
  /** Set of commands blocked as a supplemental safety net on top of the allowlist. */
  private readonly blockedSet: Set<string>;

  constructor(id: string, config: ShellToolConfig, capabilities: ToolCapability[]) {
    this.id = id;
    this.config = config;
    this.capabilities = capabilities;

    // P272 Task 3: Require an explicit allowlist — a default-allow model is unsafe.
    // The operator MUST enumerate exactly which commands this adapter may execute.
    if (!config.allowed_commands || config.allowed_commands.length === 0) {
      throw new Error(
        "ShellAdapter requires non-empty 'allowed_commands' configuration. " +
        "Enumerate the exact commands this adapter is permitted to execute.",
      );
    }
    this.allowedSet = new Set(config.allowed_commands);

    // Additional blocked set: operator-supplied extras merged with always-blocked commands.
    this.blockedSet = new Set([
      ...ALWAYS_BLOCKED_COMMANDS,
      ...(config.blocked_commands ?? []),
    ]);
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.connected = true;
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(action: ToolAction): Promise<ToolResult> {
    const start = Date.now();

    const cap = action.capability;
    if (cap !== "execute" && cap !== "shell_exec") {
      return {
        success: false,
        error: `Unknown shell capability: ${cap}`,
        duration_ms: Date.now() - start,
      };
    }

    const command = String(action.params["command"] ?? "");
    if (command.trim().length === 0) {
      return {
        success: false,
        error: "No command provided",
        duration_ms: Date.now() - start,
      };
    }

    // Validate command against allow/block lists
    try {
      this.validateCommand(command);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }

    const sanitizedEnv = this.sanitizeEnv({
      ...process.env,
      ...(this.config.env ?? {}),
    });

    // B2 (P274): Use shell-quote for proper tokenization — naive .split(" ") breaks
    // on quoted arguments and fails to detect injection patterns inside quotes.
    const parsed = shellParse(command.trim());
    // Reject shell operators (pipe, &&, ||, ;, etc.) — we run with shell: false
    if (parsed.some((t): boolean => typeof t !== "string")) {
      return {
        success: false,
        error: "Shell operators are not allowed in commands",
        duration_ms: Date.now() - start,
      };
    }
    const tokens = parsed as string[];
    const [executable, ...args] = tokens;

    if (!executable) {
      return { success: false, error: "Empty command", duration_ms: Date.now() - start };
    }

    // Validate all tokens for shell metacharacters before execution
    for (const token of tokens) {
      if (SHELL_METACHAR_PATTERN.test(token)) {
        return {
          success: false,
          error:   `Shell metacharacter detected in argument: ${token.slice(0, 50)}`,
          duration_ms: Date.now() - start,
        };
      }
    }

    const timeoutMs = this.config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxBytes  = this.config.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    try {
      const result = await spawnCollect(executable, args, {
        cwd:       this.config.working_dir ?? process.cwd(),
        env:       sanitizedEnv,
        timeoutMs,
        maxBytes,
      });
      return {
        success: true,
        data: { stdout: result.stdout, stderr: result.stderr },
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  }

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      if (process.platform === "win32") {
        await execFileAsync("powershell.exe", ["-Command", "echo ok"], {
          timeout: 5_000,
          maxBuffer: 1_024,
        });
      } else {
        await execFileAsync("bash", ["-c", "echo ok"], {
          timeout: 5_000,
          maxBuffer: 1_024,
        });
      }
      return true;
    } catch (e: unknown) {
      logger.warn("shell-adapter", "Shell adapter health check failed — adapter may be unavailable", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------

  getCapabilities(): ToolCapability[] {
    return this.capabilities;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate a shell command against the allow/block lists.
   *
   * Uses shell-quote for proper tokenization (handles quoted arguments correctly).
   * Shell operators (|, &&, etc.) are rejected outright since we execute with shell: false.
   * The first string token is the executable and must be in allowedSet.
   */
  validateCommand(command: string): void {
    const parsed = shellParse(command.trim());

    // Reject any shell operators — shell: false means pipelines don't work anyway
    if (parsed.some((t): boolean => typeof t !== "string")) {
      throw new Error("Shell operators are not allowed in commands");
    }

    const tokens = parsed as string[];
    const firstToken = tokens[0];

    if (firstToken == null || firstToken.length === 0) {
      return;
    }

    // Always-blocked commands (e.g. sudo) are rejected even if in allowedSet
    if (this.blockedSet.has(firstToken)) {
      throw new Error(`Command blocked: ${firstToken}`);
    }

    // Allowlist: command must be explicitly permitted
    if (!this.allowedSet.has(firstToken)) {
      throw new Error(`Command not in allowed list: ${firstToken}`);
    }

    // Reject shell metacharacters in each token — defence-in-depth for cases where
    // shell-quote normalises an injection pattern into a string token.
    for (const token of tokens) {
      if (SHELL_METACHAR_PATTERN.test(token)) {
        throw new Error(`Shell metacharacter detected in argument: ${token.slice(0, 50)}`);
      }
    }
  }

  /**
   * Strip environment variables whose keys contain secret-like patterns
   * to prevent leaking credentials to child processes.
   */
  private sanitizeEnv(
    env: Record<string, string | undefined>
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      if (SECRET_ENV_PATTERN.test(key)) {
        continue;
      }
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
