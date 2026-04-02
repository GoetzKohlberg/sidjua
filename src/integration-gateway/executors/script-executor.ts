// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Integration Gateway: Script Executor
 *
 * Executes local scripts (Python, Node.js, Bash) for desktop-app APIs
 * (DaVinci Resolve, Blender, etc.).
 *
 * Security:
 *   - Runtime allow-list — no arbitrary interpreter
 *   - Optional directory containment check via assertWithinDirectory
 *   - Hard timeout via SIGKILL
 *   - Output size cap (100 KB)
 *   - SIDJUA_REQUEST_ID injected into child env for tracing
 */

import { spawn }                    from "node:child_process";
import { existsSync }               from "node:fs";
import { createLogger }             from "../../core/logger.js";
import { assertWithinDirectoryReal } from "../../utils/path-utils.js";
import { IntegrationError }         from "../errors.js";

const logger = createLogger("script-executor");


export interface ScriptExecutionRequest {
  /** Absolute path to the script file */
  script_path: string;
  /** Function or entry-point name within the script */
  function_name: string;
  /** Named arguments passed as JSON to the script via argv[2] */
  args: Record<string, unknown>;
  /** Interpreter: "python3" | "python" | "node" | "bash" */
  runtime: string;
  /** Hard timeout in milliseconds */
  timeout_ms: number;
  /** Request correlation ID (injected as SIDJUA_REQUEST_ID env var) */
  request_id: string;
}

export interface ScriptExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  execution_ms: number;
}


const ALLOWED_RUNTIMES: ReadonlySet<string> = new Set(["python3", "python", "node", "bash"]);
const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB

export class ScriptExecutor {
  /**
   * @param allowedScriptDir  If set, scripts MUST reside within this directory.
   *                          When undefined, any existing file is accepted.
   */
  constructor(private readonly allowedScriptDir?: string) {}

  /** Execute a local script and return its stdout/stderr/exit code. */
  async execute(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    // 1. Validate runtime
    if (!ALLOWED_RUNTIMES.has(request.runtime)) {
      throw new IntegrationError(
        `Runtime '${request.runtime}' not allowed. Allowed: ${[...ALLOWED_RUNTIMES].join(", ")}`,
        "RUNTIME_NOT_ALLOWED",
      );
    }

    // 2. Validate script path
    await this.validateScriptPath(request.script_path);

    // 3. Build command
    const { command, args } = this.buildCommand(request);

    logger.debug("script-executor", `Spawning ${request.runtime} script`, {
      metadata: { requestId: request.request_id, scriptPath: request.script_path, function: request.function_name },
    });

    // 4. Spawn with timeout
    return this.spawnProcess(command, args, request.timeout_ms, request.request_id);
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private async validateScriptPath(scriptPath: string): Promise<void> {
    if (!existsSync(scriptPath)) {
      throw new IntegrationError(
        `Script not found: ${scriptPath}`,
        "SCRIPT_NOT_FOUND",
      );
    }

    if (this.allowedScriptDir !== undefined) {
      // assertWithinDirectoryReal throws SidjuaError SEC-010 on path traversal
      assertWithinDirectoryReal(scriptPath, this.allowedScriptDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Command building
  // ---------------------------------------------------------------------------

  private buildCommand(request: ScriptExecutionRequest): { command: string; args: string[] } {
    const { runtime, script_path, function_name, args } = request;
    const jsonArgs = JSON.stringify(args);
    return {
      command: runtime,
      args: [script_path, function_name, jsonArgs],
    };
  }

  // ---------------------------------------------------------------------------
  // Process spawning
  // ---------------------------------------------------------------------------

  private async spawnProcess(
    command: string,
    args: string[],
    timeoutMs: number,
    requestId: string,
  ): Promise<ScriptExecutionResult> {
    return new Promise<ScriptExecutionResult>((resolve) => {
      const startTime = Date.now();
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env:   { ...process.env, SIDJUA_REQUEST_ID: requestId },
      });

      child.stdout?.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += data.toString();
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
        logger.warn("script-executor", `Process killed after ${timeoutMs}ms timeout`, {
          metadata: { requestId, command },
        });
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          success:      !killed && code === 0,
          stdout:       stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr:       killed
            ? `Process killed after ${timeoutMs}ms timeout`
            : stderr.slice(0, MAX_OUTPUT_BYTES),
          exit_code:    code ?? -1,
          execution_ms: Date.now() - startTime,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success:      false,
          stdout:       "",
          stderr:       err.message,
          exit_code:    -1,
          execution_ms: Date.now() - startTime,
        });
      });
    });
  }
}
