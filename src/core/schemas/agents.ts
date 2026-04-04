// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Zod schemas for agent definition YAML files.
 *
 * Validates agent YAML files loaded by AgentRegistry and bootstrapOrchestrator.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export const AgentDefinitionSchema = z.object({
  id:                     z.string().min(1),
  name:                   z.string().min(1),
  tier:                   z.enum(["T1", "T2", "T3"]),
  provider:               z.string().min(1),
  model:                  z.string().min(1),
  skill_file:             z.string().min(1),
  division:               z.string().min(1),
  capabilities:           z.array(z.string()).default([]),
  max_concurrent_tasks:   z.number().int().positive().default(3),
  token_budget_per_task:  z.number().int().positive().default(100_000),
  cost_limit_per_hour:    z.number().nonnegative().default(1.0),
  checkpoint_interval_ms: z.number().int().positive().default(30_000),
  ttl_default_seconds:    z.number().int().positive().default(3600),
  heartbeat_interval_ms:  z.number().int().positive().default(10_000),
  max_retries:            z.number().int().min(0).default(3),
  metadata:               z.record(z.string(), z.unknown()).default({}),
}).passthrough();

// ---------------------------------------------------------------------------
// Agents YAML file (used by sidjua apply defaults/agents.yaml)
// ---------------------------------------------------------------------------

export const AgentsFileSchema = z.object({
  agents: z.array(AgentDefinitionSchema),
}).passthrough();

// ---------------------------------------------------------------------------
// Skill definition (loaded from skill.md front-matter or skill.yaml)
// ---------------------------------------------------------------------------

export const SkillDefinitionSchema = z.object({
  name:         z.string().min(1),
  description:  z.string().optional(),
  version:      z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  tools:        z.array(z.string()).optional(),
}).passthrough();

export type AgentDefinitionInput = z.input<typeof AgentDefinitionSchema>;
export type AgentsFileInput      = z.input<typeof AgentsFileSchema>;
export type SkillDefinitionInput = z.input<typeof SkillDefinitionSchema>;
