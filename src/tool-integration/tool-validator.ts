// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Tool Validator
 *
 * Validates CreateToolInput before DB insertion and probes adapter connectivity.
 */

import type { CreateToolInput, ToolAdapter } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("tool-validator");


export class ToolValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolValidationError";
  }
}


const VALID_TOOL_TYPES = new Set([
  "mcp",
  "rest",
  "shell",
  "filesystem",
  "database",
  "computer_use",
  "adb",
  "composite",
  "internal",
]);

const TOOL_ID_PATTERN = /^[a-z0-9_-]+$/;

export class ToolValidator {
  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  /**
   * Validate a CreateToolInput object.
   * Throws ToolValidationError on any validation failure.
   */
  validate(input: CreateToolInput): void {
    // id: non-empty, pattern match
    if (
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      !TOOL_ID_PATTERN.test(input.id)
    ) {
      throw new ToolValidationError(
        "id",
        `Tool id must be a non-empty string matching /^[a-z0-9_-]+$/, got: "${input.id}"`,
      );
    }

    // name: non-empty
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw new ToolValidationError("name", "Tool name must be a non-empty string");
    }

    // type: valid ToolType
    if (!VALID_TOOL_TYPES.has(input.type)) {
      throw new ToolValidationError(
        "type",
        `Tool type must be one of [${[...VALID_TOOL_TYPES].join(", ")}], got: "${input.type}"`,
      );
    }

    // config.type must match input.type
    if (input.config.type !== input.type) {
      throw new ToolValidationError(
        "config.type",
        `config.type "${input.config.type}" must match tool type "${input.type}"`,
      );
    }

    // Type-specific config validation
    switch (input.type) {
      case "mcp": {
        if (input.config.type !== "mcp") break;
        if (
          typeof input.config.command !== "string" ||
          input.config.command.length === 0
        ) {
          throw new ToolValidationError(
            "config.command",
            "MCP tool config.command must be a non-empty string",
          );
        }
        break;
      }

      case "rest": {
        if (input.config.type !== "rest") break;
        if (
          typeof input.config.base_url !== "string" ||
          input.config.base_url.length === 0
        ) {
          throw new ToolValidationError(
            "config.base_url",
            "REST tool config.base_url must be a non-empty string",
          );
        }
        if (!input.config.base_url.startsWith("http")) {
          throw new ToolValidationError(
            "config.base_url",
            `REST tool config.base_url must start with "http", got: "${input.config.base_url}"`,
          );
        }
        break;
      }

      case "shell": {
        // No additional required fields
        break;
      }

      case "filesystem": {
        if (input.config.type !== "filesystem") break;
        if (
          !Array.isArray(input.config.allowed_paths) ||
          input.config.allowed_paths.length === 0
        ) {
          throw new ToolValidationError(
            "config.allowed_paths",
            "Filesystem tool config.allowed_paths must be a non-empty array",
          );
        }
        break;
      }

      case "database": {
        if (input.config.type !== "database") break;
        const dbType = input.config.db_type;
        if (dbType !== "sqlite" && dbType !== "postgresql") {
          throw new ToolValidationError(
            "config.db_type",
            `Database tool config.db_type must be "sqlite" or "postgresql", got: "${dbType}"`,
          );
        }
        // config.path recommended for sqlite but not required (:memory: is valid)
        break;
      }

      case "computer_use": {
        // No required fields
        break;
      }

      case "adb": {
        // No required fields
        break;
      }

      case "composite": {
        if (input.config.type !== "composite") break;
        if (
          !Array.isArray(input.config.sub_tools) ||
          input.config.sub_tools.length === 0
        ) {
          throw new ToolValidationError(
            "config.sub_tools",
            "Composite tool config.sub_tools must be a non-empty array",
          );
        }
        break;
      }

      case "internal": {
        // Internal tools are registered at startup, not via CreateToolInput.
        // Reaching this case means the caller passed type="internal" directly,
        // which is not permitted through the DB-backed registration path.
        throw new ToolValidationError(
          "type",
          "Internal tools cannot be registered via the tool validator — they are bootstrapped at startup",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------

  /**
   * Probe adapter connectivity by running connect/healthCheck/disconnect.
   * Returns false (does not throw) if any step fails.
   */
  async probe(adapter: ToolAdapter): Promise<boolean> {
    try {
      await adapter.connect();
      const healthy = await adapter.healthCheck();
      await adapter.disconnect();
      return healthy;
    } catch (e: unknown) {
      logger.warn("tool-validator", "Tool adapter validation failed — skipping adapter", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return false;
    }
  }
}
