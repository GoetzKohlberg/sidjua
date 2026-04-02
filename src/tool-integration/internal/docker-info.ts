// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * docker-info — list Docker containers, images, and resource usage.
 */

import { execFileSync } from "node:child_process";
import type { InternalToolDef } from "../adapters/internal-adapter.js";

const DOCKER_TIMEOUT = 10_000;

export const dockerInfoTool: InternalToolDef = {
  id:          "internal-docker-info",
  name:        "docker_info",
  description: "List Docker containers, images, and resource usage",
  capabilities: [
    {
      name:              "list_containers",
      description:       "Returns running/stopped containers with status, ports, resource usage",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          all: { type: "boolean", description: "Include stopped containers", default: false },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    const psArgs = ["ps", ...(params["all"] ? ["-a"] : []), "--format", "{{json .}}"];

    let containers: unknown[] = [];
    try {
      const raw = execFileSync("docker", psArgs, { timeout: DOCKER_TIMEOUT })
        .toString().trim();
      if (raw) containers = raw.split("\n").map((line) => JSON.parse(line) as unknown);
    } catch (err: unknown) {
      return { error: "Docker not available or permission denied", detail: String(err) };
    }

    let images: unknown[] = [];
    try {
      const raw = execFileSync("docker", ["images", "--format", "{{json .}}"], { timeout: DOCKER_TIMEOUT })
        .toString().trim();
      if (raw) images = raw.split("\n").map((line) => JSON.parse(line) as unknown);
    } catch (_e) { /* non-critical */ }

    let diskUsage = "unavailable";
    try {
      diskUsage = execFileSync("docker", ["system", "df"], { timeout: DOCKER_TIMEOUT }).toString().trim();
    } catch (_e) { /* non-critical */ }

    return {
      containers: { count: containers.length, list: containers },
      images:     { count: images.length,     list: images.slice(0, 20) },
      disk_usage: diskUsage,
    };
  },
};
