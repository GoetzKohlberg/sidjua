// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw import type definitions.
 *
 * Represents the parsed state of an OpenClaw installation and the
 * intermediate structures produced during conversion to SIDJUA config.
 */

export interface OpenClawAgent {
  name: string;
  model: string;
  provider?: string;
  capabilities: string[];
}

export interface OpenClawSoul {
  rawText: string;
  personalityTraits: string[];
  language?: string;
}

export interface OpenClawMemory {
  type: "fact" | "preference" | "conversation";
  category: string;
  content: string;
}

export interface OpenClawHeartbeat {
  name: string;
  schedule: string;    // cron expression or raw text if unparseable
  action: string;
}

export interface OpenClawSkill {
  name: string;
  description?: string;
  version?: string;
  tools?: string[];
}

export interface OpenClawChannel {
  type: "telegram" | "discord" | "whatsapp" | "slack" | "email" | string;
  config: Record<string, string>;  // key-value pairs (may contain secrets)
}

export interface OpenClawInstallation {
  path: string;
  agents: OpenClawAgent[];
  soul: OpenClawSoul | null;
  memories: OpenClawMemory[];
  heartbeats: OpenClawHeartbeat[];
  skills: OpenClawSkill[];
  channels: OpenClawChannel[];
  validationErrors: string[];
}

export interface SkillMapping {
  openclawName: string;
  mcpPackage: string | null;     // null = no known equivalent
  status: "direct" | "partial" | "none";
  notes: string;
}

export interface ImportResult {
  agentsCreated: string[];
  skillsMapped: { direct: number; partial: number; none: number };
  memoriesImported: number;
  channelsConfigured: string[];
  heartbeatsCreated: number;
  notMigrated: Array<{ item: string; reason: string }>;
  errors: string[];
}
