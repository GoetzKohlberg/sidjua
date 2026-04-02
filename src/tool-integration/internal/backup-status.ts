// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * backup-status — check BorgBackup repository status and last backup timestamps.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { InternalToolDef } from "../adapters/internal-adapter.js";

const BORG_TIMEOUT = 15_000;
const DEFAULT_BORG_REPO = "/data/backups/borg";

export const backupStatusTool: InternalToolDef = {
  id:          "internal-backup-status",
  name:        "backup_status",
  description: "Check BorgBackup repository status and last backup timestamps",
  capabilities: [
    {
      name:              "check_backup",
      description:       "Returns last backup time, repo size, archive list",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          repo_path: {
            type:        "string",
            description: "BorgBackup repository path (optional, uses BORG_REPO env or default)",
          },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    const repoPath =
      (params["repo_path"] as string | undefined) ??
      process.env["BORG_REPO"] ??
      DEFAULT_BORG_REPO;

    if (!existsSync(repoPath)) {
      return { status: "no_repo", message: `No BorgBackup repository at ${repoPath}` };
    }

    try {
      const raw = execFileSync("borg", ["info", repoPath, "--json"], {
        timeout: BORG_TIMEOUT,
        stdio:   ["pipe", "pipe", "pipe"],
      }).toString();
      return { status: "ok", repo: JSON.parse(raw) as unknown };
    } catch (_e) { /* borg not installed or repo locked — try list */ }

    try {
      const raw = execFileSync("borg", ["list", repoPath, "--json"], {
        timeout: BORG_TIMEOUT,
        stdio:   ["pipe", "pipe", "pipe"],
      }).toString();
      return { status: "ok", archives: JSON.parse(raw) as unknown };
    } catch (_e) {
      return { status: "error", message: "BorgBackup not available or repo inaccessible" };
    }
  },
};
