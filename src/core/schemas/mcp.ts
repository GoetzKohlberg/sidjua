// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Zod schemas for MCP server config (mcp-servers.yaml).
 */

import { z } from "zod";

export const McpServerEntrySchema = z.object({
  id:                              z.string().min(1),
  name:                            z.string().min(1),
  command:                         z.string().min(1),
  args:                            z.array(z.string()).optional(),
  env:                             z.record(z.string(), z.string()).optional(),
  auto_start:                      z.boolean().optional(),
  max_idle_seconds:                z.number().int().positive().optional(),
  health_check_interval_seconds:   z.number().int().positive().optional(),
}).passthrough();

export const McpSettingsSchema = z.object({
  max_concurrent_servers:          z.number().int().positive().default(3),
  default_timeout_ms:              z.number().int().positive().default(30_000),
  idle_timeout_seconds:            z.number().int().positive().default(300),
  health_check_interval_seconds:   z.number().int().positive().default(60),
  auto_restart_on_crash:           z.boolean().default(true),
  config_path:                     z.string().default("./config/mcp-servers.yaml"),
}).passthrough();

export const McpConfigFileSchema = z.object({
  servers:  z.array(McpServerEntrySchema).default([]),
  settings: McpSettingsSchema.optional(),
}).passthrough();

export type McpServerEntryInput = z.input<typeof McpServerEntrySchema>;
export type McpConfigFileInput  = z.input<typeof McpConfigFileSchema>;
