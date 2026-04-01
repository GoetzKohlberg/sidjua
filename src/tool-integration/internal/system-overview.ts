// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * system-overview — OS, Node.js version, SIDJUA version, network interfaces.
 */

import { hostname, platform, arch, type, release, networkInterfaces } from "node:os";
import { existsSync, readFileSync }                                                   from "node:fs";
import { resolve }                                                                    from "node:path";
import type { InternalToolDef } from "../adapters/internal-adapter.js";

function readSidjuaVersion(): string {
  // Walk up from this file to find package.json
  try {
    const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../../package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      return pkg.version ?? "unknown";
    }
  } catch (_e) { /* ignore */ }
  return "unknown";
}

export const systemOverviewTool: InternalToolDef = {
  id:          "internal-system-overview",
  name:        "system_overview",
  description: "High-level system overview: OS, Node.js version, SIDJUA version, network interfaces",
  capabilities: [
    {
      name:              "overview",
      description:       "Returns OS info, Node version, SIDJUA version, network interfaces, environment",
      risk_level:        "low",
      requires_approval: false,
      input_schema:      { type: "object", properties: {}, additionalProperties: false },
      output_schema:     { type: "object" },
    },
  ],
  execute: async (_params) => {
    const nets = networkInterfaces();
    const ifaces: Record<string, string[]> = {};
    for (const [name, addrs] of Object.entries(nets)) {
      if (addrs) {
        ifaces[name] = addrs
          .filter((a: { internal: boolean }) => !a.internal)
          .map((a: { address: string }) => a.address);
      }
    }

    return {
      os: {
        type:     type(),
        release:  release(),
        platform: platform(),
        arch:     arch(),
      },
      hostname:       hostname(),
      node_version:   process.version,
      sidjua_version: readSidjuaVersion(),
      network:        ifaces,
      environment:    process.env["NODE_ENV"] ?? "production",
      timezone:       Intl.DateTimeFormat().resolvedOptions().timeZone,
      pid:            process.pid,
      cwd:            process.cwd(),
    };
  },
};
