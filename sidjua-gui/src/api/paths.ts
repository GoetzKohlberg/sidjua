// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Centralized API path configuration (FIX M4)
 *
 * All API paths in one place. If the API version changes, only this file
 * needs updating. Client methods call these functions and apply
 * validatePathParam() to dynamic segments before passing them here.
 */

const API_VERSION = 'v1';
const API_PREFIX  = `/api/${API_VERSION}`;

export const API_PATHS = {
  // System
  health:            ()             => `${API_PREFIX}/health`,
  info:              ()             => `${API_PREFIX}/info`,

  // Divisions
  divisions:         ()             => `${API_PREFIX}/divisions`,
  division:          (id: string)   => `${API_PREFIX}/divisions/${id}`,

  // Agents
  agents:            ()             => `${API_PREFIX}/agents`,
  agent:             (id: string)   => `${API_PREFIX}/agents/${id}`,
  agentStart:        (id: string)   => `${API_PREFIX}/agents/${id}/start`,
  agentStop:         (id: string)   => `${API_PREFIX}/agents/${id}/stop`,
  agentPatch:        (id: string)   => `${API_PREFIX}/agents/${id}`,

  // Tasks
  tasks:             ()             => `${API_PREFIX}/tasks`,
  task:              (id: string)   => `${API_PREFIX}/tasks/${id}`,

  // Audit
  audit:             ()             => `${API_PREFIX}/audit`,

  // Governance
  governanceStatus:  ()             => `${API_PREFIX}/governance/status`,
  governanceHistory: ()             => `${API_PREFIX}/governance/history`,

  // Logging
  loggingStatus:     ()             => `${API_PREFIX}/logging/status`,
  loggingPatch:      ()             => `${API_PREFIX}/logging`,

  // Costs
  costs:             ()             => `${API_PREFIX}/costs`,

  // SSE
  sseTicket:         ()             => `${API_PREFIX}/sse/ticket`,
  sseEvents:         ()             => `${API_PREFIX}/events`,

  // Starter agents & divisions (static definitions)
  starterAgents:     ()             => `${API_PREFIX}/starter-agents`,
  starterAgent:      (id: string)   => `${API_PREFIX}/starter-agents/${id}`,
  starterDivisions:  ()             => `${API_PREFIX}/starter-divisions`,
  starterDivision:   (id: string)   => `${API_PREFIX}/starter-divisions/${id}`,

  // Provider catalog & config
  providerCatalog:   ()             => `${API_PREFIX}/provider/catalog`,
  providerConfig:    ()             => `${API_PREFIX}/provider/config`,
  providerTest:      ()             => `${API_PREFIX}/provider/test`,

  // Chat
  chatSend:              (id: string)   => `${API_PREFIX}/chat/${id}`,
  chatHistory:           (id: string)   => `${API_PREFIX}/chat/${id}/history`,

  // Workspace config
  workspaceConfig:       ()             => `${API_PREFIX}/config`,
  firstRunComplete:      ()             => `${API_PREFIX}/config/first-run-complete`,
  bouncerConfig:         ()             => `${API_PREFIX}/config/bouncer`,

  // Chat scan (bouncer)
  chatScan:              ()             => `${API_PREFIX}/chat/scan`,

  // Locale (i18n)
  locale:                ()             => `${API_PREFIX}/locale`,
  localeStrings:         (code: string) => `${API_PREFIX}/locale/${code}`,
  localeSet:             ()             => `${API_PREFIX}/config/locale`,

  // Apply configuration
  apply:                 ()             => `${API_PREFIX}/apply`,

  // Tokens (bootstrap → admin exchange)
  tokens:                ()             => `${API_PREFIX}/tokens`,

  // Org chart status (P359)
  orgStatus:             ()             => `${API_PREFIX}/org/status`,
  orgAgentTasks:         (id: string)   => `${API_PREFIX}/org/agent/${id}/tasks`,
} as const;
