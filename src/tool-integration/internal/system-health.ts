// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * system-health — CPU, memory, disk, uptime, load average.
 */

import { hostname, platform, arch, uptime, cpus, totalmem, freemem, loadavg } from "node:os";
import { execFileSync } from "node:child_process";
import type { InternalToolDef } from "../adapters/internal-adapter.js";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export const systemHealthTool: InternalToolDef = {
  id:          "internal-system-health",
  name:        "system_health",
  description: "Check system health: CPU, memory, disk, uptime, load average",
  capabilities: [
    {
      name:              "check_health",
      description:       "Returns CPU usage, memory (total/free/used), disk space, uptime, load average",
      risk_level:        "low",
      requires_approval: false,
      input_schema:      { type: "object", properties: {}, additionalProperties: false },
      output_schema:     { type: "object" },
    },
  ],
  execute: async (_params) => {
    const totalMem  = totalmem();
    const freeMem   = freemem();
    const cpuList   = cpus();
    const loadAvg   = loadavg();
    const uptimeSec = uptime();

    let diskInfo = "unavailable";
    try {
      const dfOutput = execFileSync("df", ["-h", "/"], { timeout: 5000 }).toString().trim();
      diskInfo = dfOutput.split("\n").pop() ?? "unavailable";
    } catch (_e) { /* non-critical */ }

    return {
      hostname:       hostname(),
      platform:       platform(),
      arch:           arch(),
      uptime_seconds: uptimeSec,
      uptime_human:   formatUptime(uptimeSec),
      cpu_count:      cpuList.length,
      cpu_model:      cpuList[0]?.model ?? "unknown",
      load_average:   { "1m": loadAvg[0], "5m": loadAvg[1], "15m": loadAvg[2] },
      memory: {
        total_gb:      (totalMem / 1e9).toFixed(2),
        free_gb:       (freeMem  / 1e9).toFixed(2),
        used_gb:       ((totalMem - freeMem) / 1e9).toFixed(2),
        usage_percent: (((totalMem - freeMem) / totalMem) * 100).toFixed(1),
      },
      disk: diskInfo,
    };
  },
};
