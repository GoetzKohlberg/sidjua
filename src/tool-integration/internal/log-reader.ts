// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * log-reader — read application/system log files (last N lines).
 * Path traversal protection: only files within ALLOWED_LOG_DIRS are readable.
 */

import { existsSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, sep }                  from "node:path";
import type { InternalToolDef } from "../adapters/internal-adapter.js";

const MAX_LINES = 200;
export const ALLOWED_LOG_DIRS = ["/data/logs", "./logs", "/tmp"];

export const logReaderTool: InternalToolDef = {
  id:          "internal-log-reader",
  name:        "read_logs",
  description: "Read application and system log files (last N lines)",
  capabilities: [
    {
      name:              "read_log",
      description:       "Read tail of a log file. Restricted to allowed log directories.",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          file:   { type: "string", description: "Log file path or name (e.g. \"sidjua.log\")" },
          lines:  { type: "number", description: `Number of lines to read (max ${MAX_LINES})`, default: 50 },
          filter: { type: "string", description: "Optional regex pattern to filter lines" },
        },
        required:            ["file"],
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    const file   = params["file"] as string;
    const lines  = Math.min(Number(params["lines"]) || 50, MAX_LINES);
    const filter = params["filter"] as string | undefined;

    // Resolve — if relative, search allowed dirs
    let resolvedPath = "";
    if (isAbsolute(file)) {
      resolvedPath = file;
    } else {
      for (const dir of ALLOWED_LOG_DIRS) {
        const candidate = join(dir, file);
        if (existsSync(candidate)) { resolvedPath = candidate; break; }
      }
    }

    if (!resolvedPath || !existsSync(resolvedPath)) {
      return { error: `Log file not found: ${file}`, searched: ALLOWED_LOG_DIRS };
    }

    // Security: ensure resolved real path is within an allowed directory
    let realPath: string;
    try {
      realPath = realpathSync(resolvedPath);
    } catch (_e) {
      return { error: "Cannot resolve log file path" };
    }

    const isAllowed = ALLOWED_LOG_DIRS.some((d) => {
      try {
        const realDir = realpathSync(d);
        return realPath === realDir || realPath.startsWith(realDir + sep);
      } catch (_e) { return false; }
    });
    if (!isAllowed) {
      return { error: "Access denied: file outside allowed log directories" };
    }

    const content  = readFileSync(realPath, "utf-8");
    let logLines   = content.split("\n").slice(-lines);

    if (filter) {
      const regex = new RegExp(filter, "i");
      logLines = logLines.filter((l: string) => regex.test(l));
    }

    return {
      file:           realPath,
      total_lines:    content.split("\n").length,
      returned_lines: logLines.length,
      content:        logLines.join("\n"),
    };
  },
};
