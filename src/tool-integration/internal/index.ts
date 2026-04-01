// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Internal Tool Index — Part 1 (IT / System tools).
 *
 * These tools are registered automatically during orchestrator bootstrap
 * and are available to any agent with tool access.
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import { systemHealthTool }    from "./system-health.js";
import { dockerInfoTool }      from "./docker-info.js";
import { backupStatusTool }    from "./backup-status.js";
import { logReaderTool }       from "./log-reader.js";
import { systemOverviewTool }  from "./system-overview.js";

/** All IT/System internal tools — Part 1. */
export const INTERNAL_TOOLS_SYSTEM: InternalToolDef[] = [
  systemHealthTool,
  dockerInfoTool,
  backupStatusTool,
  logReaderTool,
  systemOverviewTool,
];

export {
  systemHealthTool,
  dockerInfoTool,
  backupStatusTool,
  logReaderTool,
  systemOverviewTool,
};
