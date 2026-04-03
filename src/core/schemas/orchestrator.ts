// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Zod schemas for orchestrator.yaml config.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Delegation rules
// ---------------------------------------------------------------------------

export const DelegationRuleSchema = z.object({
  from_tier:                       z.number().int().min(1).max(3),
  to_tier:                         z.number().int().min(1).max(3),
  allowed:                         z.boolean(),
  requires_classification_match:   z.boolean(),
  budget_cascade:                  z.enum(["proportional", "fixed", "remaining"]),
});

// ---------------------------------------------------------------------------
// Pipeline config (Phase 9.5)
// ---------------------------------------------------------------------------

export const PipelineConfigSchema = z.object({
  max_queue_size:    z.number().int().positive().optional(),
  default_priority:  z.number().int().min(1).max(10).optional(),
  ack_timeout_ms:    z.number().int().positive().optional(),
  backpressure:      z.object({
    enabled:           z.boolean().optional(),
    high_water_mark:   z.number().int().positive().optional(),
    low_water_mark:    z.number().int().positive().optional(),
  }).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Sandbox config (Phase 19)
// ---------------------------------------------------------------------------

export const SandboxConfigSchema = z.object({
  type:             z.enum(["none", "bubblewrap", "docker"]).optional(),
  enabled:          z.boolean().optional(),
  allowed_paths:    z.array(z.string()).optional(),
  network:          z.boolean().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Orchestrator YAML config (raw — string keys for YAML compatibility)
// ---------------------------------------------------------------------------

export const OrchestratorConfigRawSchema = z.object({
  max_agents:              z.number().int().positive().optional(),
  max_agents_per_tier:     z.record(z.string(), z.number().int().positive()).optional(),
  event_poll_interval_ms:  z.number().int().positive().optional(),
  delegation_timeout_ms:   z.number().int().positive().optional(),
  synthesis_timeout_ms:    z.number().int().positive().optional(),
  max_tree_depth:          z.number().int().min(1).max(10).optional(),
  max_tree_breadth:        z.number().int().min(1).max(50).optional(),
  default_division:        z.string().min(1).optional(),
  governance_root:         z.string().optional(),
  delegation_rules:        z.array(DelegationRuleSchema).optional(),
  pipeline:                PipelineConfigSchema.optional(),
  sandbox:                 SandboxConfigSchema.optional(),
}).passthrough();

export type DelegationRuleInput           = z.input<typeof DelegationRuleSchema>;
export type OrchestratorConfigRawInput    = z.input<typeof OrchestratorConfigRawSchema>;
