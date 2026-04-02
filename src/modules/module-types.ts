// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Module System Types
 *
 * Defines the interfaces for installable agent modules (Discord, SAP, ERP, etc.).
 * Modules ship as compiled TypeScript; configuration + secrets live in workDir.
 */


export interface ModuleSecret {
  key:          string;
  description:  string;
  required:     boolean;
  validation?:  string; // regex pattern for validation
}

export interface ModuleConfig {
  key:          string;
  description:  string;
  required:     boolean;
  default?:     string;
}

export interface ModuleAgent {
  /** Agent ID that will be installed (e.g. "discord-bot") */
  id:         string;
  /** Path relative to module data dir where agent definition YAML is written */
  definition: string;
  /** Path relative to module data dir where skill Markdown is written */
  skill:      string;
}

export interface ModuleManifest {
  id:                   string;
  name:                 string;
  version:              string;
  description:          string;
  /** e.g. "communication", "erp", "monitoring" */
  category:             string;
  sidjua_min_version:   string;
  agent?:               ModuleAgent;
  secrets?:             ModuleSecret[];
  config?:              ModuleConfig[];
  /** CLI command names this module registers (informational) */
  commands?:            string[];
  /** Tools this module provides — validated against governance capability whitelist at install time. */
  tools?:               ModuleTool[];
  /**
   * Declared network access requirements.
   * V1: AUDIT-ONLY — not enforced. Modules run with full Node.js network access.
   * Enforcement requires sandbox integration (planned for a future release).
   */
  network_policy?:      ModuleNetworkPolicy;
}

export interface ModuleNetworkPolicy {
  /** Hostnames or IP ranges this module is expected to connect to. */
  allowed_hosts?: string[];
  /** Whether outbound internet access is required. */
  requires_internet?: boolean;
  /** Free-text description of network requirements. */
  description?: string;
}


export interface ModuleTool {
  /** Unique tool name within this module (e.g. "send_message"). */
  name:         string;
  /** Human-readable description (logged in audit trail). */
  description:  string;
  /**
   * Capability categories claimed by this tool.
   * Validated against the operator-approved whitelist during install.
   * See ALLOWED_MODULE_CAPABILITIES in module-loader.ts.
   */
  capabilities: string[];
}


export interface ModuleStatus {
  id:             string;
  installed:      boolean;
  configured:     boolean;
  /** All required secrets are set */
  secretsSet:     boolean;
  /** List of required secrets that are missing */
  missingSecrets: string[];
  installPath?:   string;
  manifest?:      ModuleManifest;
}


export interface ModuleRegistryEntry {
  id:           string;
  installPath:  string;
  installedAt:  string; // ISO-8601
}
