// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Zod schemas for governance YAML config files.
 *
 * These schemas validate data loaded from:
 *   boundaries/forbidden-actions.yaml
 *   boundaries/approval-workflows.yaml
 *   classification/levels.yaml
 *   classification/rules.yaml
 *   policies/*.yaml
 *   security/security.yaml
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Forbidden actions
// ---------------------------------------------------------------------------

export const ForbiddenRuleSchema = z.object({
  action:      z.string().min(1),
  condition:   z.string().optional(),
  reason:      z.string().min(1),
  escalate_to: z.string().min(1),
});

export const ForbiddenConfigSchema = z.object({
  forbidden: z.array(ForbiddenRuleSchema),
}).passthrough();

// ---------------------------------------------------------------------------
// Approval workflows
// ---------------------------------------------------------------------------

export const ApprovalTriggerSchema = z.object({
  action:    z.string().min(1),
  condition: z.string().optional(),
});

export const ApprovalWorkflowSchema = z.object({
  trigger:       ApprovalTriggerSchema,
  require:       z.string().min(1),
  timeout_hours: z.number().positive(),
});

export const ApprovalWorkflowsConfigSchema = z.object({
  workflows: z.array(ApprovalWorkflowSchema),
}).passthrough();

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const ClassificationLevelSchema = z.object({
  code:        z.string().min(1),
  rank:        z.number().int().min(0),
  description: z.string(),
});

export const ClassificationLevelsConfigSchema = z.object({
  levels: z.array(ClassificationLevelSchema),
}).passthrough();

export const ClassificationRulesConfigSchema = z.object({
  agent_clearance:    z.record(z.string(), z.string()).optional(),
  division_overrides: z.record(z.string(), z.record(z.string(), z.string())).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Policy rules
// ---------------------------------------------------------------------------

export const PolicyEnforcementSchema = z.enum(["hard", "soft"]);

export const PolicyRuleSchema = z.object({
  id:           z.string().min(1),
  description:  z.string(),
  action_types: z.array(z.string().min(1)),
  check:        z.string().min(1),
  enforcement:  PolicyEnforcementSchema,
});

export const PolicyConfigFileSchema = z.object({
  rules: z.array(PolicyRuleSchema),
}).passthrough();

// ---------------------------------------------------------------------------
// Security filter
// ---------------------------------------------------------------------------

export const SecurityFilterModeSchema = z.enum(["blacklist", "whitelist"]);

export const SecurityFilterEntrySchema = z.object({
  pattern:    z.string().min(1),
  applies_to: z.array(z.string().min(1)),
  reason:     z.string().min(1),
});

export const SecurityFilterConfigSchema = z.object({
  mode:             SecurityFilterModeSchema.default("blacklist"),
  blocked:          z.array(SecurityFilterEntrySchema).optional(),
  allowed:          z.array(SecurityFilterEntrySchema).optional(),
  allowed_networks: z.array(z.string()).optional(),
});

export const SecurityConfigFileSchema = z.object({
  filter: SecurityFilterConfigSchema,
}).passthrough();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ForbiddenRuleInput           = z.input<typeof ForbiddenRuleSchema>;
export type ApprovalWorkflowInput        = z.input<typeof ApprovalWorkflowSchema>;
export type ClassificationLevelInput     = z.input<typeof ClassificationLevelSchema>;
export type PolicyRuleInput              = z.input<typeof PolicyRuleSchema>;
export type SecurityFilterEntryInput     = z.input<typeof SecurityFilterEntrySchema>;
