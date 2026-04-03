// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Module SDK type definitions.
 *
 * A SIDJUA Module = MCP Server + Governance Metadata.
 * Modules live in {workDir}/modules/{name}/module.yaml.
 */

export interface ModuleDefinition {
  name:        string;
  version:     string;
  description: string;
  author:      string;
  type:        "mcp-wrapper" | "native";

  mcp: {
    transport: "stdio" | "sse";
    command?:  string;
    args?:     string[];
    url?:      string;
    env?:      Record<string, string>;
  };

  governance_defaults: {
    allowed_divisions:      string[];
    allowed_tiers:          string[];
    max_calls_per_minute:   number;
    forbidden_patterns:     string[];
    classification_ceiling: string;
    budget_per_call:        number;
  };

  tools?: Array<{
    name:               string;
    description:        string;
    requires_approval?: boolean;
  }>;
}

export interface InstalledModule {
  name:       string;
  path:       string;
  definition: ModuleDefinition;
  source:     "local" | "npm";
}
