// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 8: Agent Runtime types
 *
 * All interfaces, enums, and IPC message types for the Agent Runtime.
 * Architecture decisions from V1-RUNTIME-DECISIONS-Q5-Q12.md:
 *   - Subprocess isolation via child_process.fork()
 *   - 3-level memory: short-term / long-term / pool (file-based V1)
 *   - 3 tiers (T1/T2/T3). Tier = authority.
 *   - Fully async. Agents work on multiple tasks concurrently.
 *   - Every LLM call goes through Pre-Action Pipeline.
 */

import type { TaskEvent, CreateTaskInput, ManagementSummary } from "../tasks/types.js";
import type { Message } from "../types/provider.js";
import type { RoleToolConfig } from "../defaults/loader.js";

// Re-export for convenience
export type { TaskEvent, CreateTaskInput, ManagementSummary, Message };


export interface AgentDefinition {
  id: string;                          // unique: "opus-ceo", "sonnet-devlead", "haiku-worker-1"
  name: string;                        // human-readable: "Opus CEO Assistant"
  tier: 1 | 2 | 3;                    // authority level
  provider: string;                    // "anthropic" | "openai"
  model: string;                       // "claude-sonnet-4-6", "gpt-4o"
  skill_file: string;                  // path to skill.md
  division: string;                    // primary division assignment
  capabilities: string[];              // ["code", "analysis", "writing"]
  max_concurrent_tasks: number;        // how many RUNNING tasks simultaneously
  token_budget_per_task: number;       // default token limit per task
  cost_limit_per_hour: number;         // USD hard cap per hour
  checkpoint_interval_ms: number;      // how often to save state (default: 30000)
  ttl_default_seconds: number;         // default timeout per task
  heartbeat_interval_ms: number;       // how often agent pings watchdog (default: 10000)
  max_retries: number;                 // restart attempts before escalation (default: 3)
  metadata: Record<string, unknown>;
  /** Tool RBAC config from role YAML (P340/P342). Optional — populated at agent start. */
  tools?: RoleToolConfig;
}


export type AgentStatus =
  | "IDLE"           // spawned, no tasks
  | "WORKING"        // actively processing tasks
  | "WAITING"        // all tasks in WAITING state
  | "PAUSED"         // manually paused by operator
  | "CRASHED"        // subprocess died unexpectedly
  | "RESTARTING"     // being restarted by Bootstrap Agent
  | "STOPPED";       // gracefully shut down


export interface AgentError {
  timestamp: string;
  type: "crash" | "timeout" | "budget" | "provider" | "governance" | "unknown";
  message: string;
  task_id?: string;
}


export interface AgentState {
  agent_id: string;
  status: AgentStatus;
  pid: number | null;                  // subprocess PID
  started_at: string | null;
  last_heartbeat: string | null;
  last_checkpoint: string | null;
  active_tasks: string[];              // task IDs currently RUNNING
  waiting_tasks: string[];             // task IDs in WAITING state
  queued_tasks: number;                // count of PENDING tasks
  total_tokens_used: number;
  total_cost_usd: number;
  restart_count: number;
  current_hour_cost: number;           // rolling cost for hourly limit
  hour_start: string;                  // when current hour window started
  error_log: AgentError[];             // recent errors (ring buffer, max 20)
}


export interface ReviewBehavior {
  strategy: "summary_only" | "summary_then_selective" | "always_full";
  confidence_threshold: number;        // below this → read full result (default: 0.8)
  max_full_reviews_per_synthesis: number; // limit full file reads (default: 3)
}

export interface DelegationStyle {
  max_sub_tasks: number;               // max children per decomposition (default: 10)
  prefer_parallel: boolean;            // true = create all sub-tasks at once
  require_plan_approval: boolean;      // true = output plan first, wait for approval
}

export interface SkillDefinition {
  agent_id: string;
  role: string;                        // "CEO Strategic Advisor", "Dev Lead", "Worker"
  system_prompt: string;               // main system prompt from skill.md body
  review_behavior: ReviewBehavior;
  delegation_style: DelegationStyle;
  output_format: string;               // preferred output format instructions
  constraints: string[];               // additional constraints/rules
  tools: string[];                     // tools this agent can use
}


export interface TaskCheckpoint {
  task_id: string;
  status: string;
  progress_notes: string;              // agent's own notes on where it is
  messages_so_far: number;             // how many LLM messages exchanged
  partial_result: string | null;       // work done so far
}

export interface Checkpoint {
  agent_id: string;
  timestamp: string;
  version: number;                     // incrementing checkpoint version
  state: AgentState;
  task_states: TaskCheckpoint[];       // per-task progress
  memory_snapshot: string;             // serialized short-term memory
  memory_lifecycle?: {
    last_hygiene_cycle: string | null;
    last_compaction: string | null;
    pending_archival: ArchivalCandidate[];
    health_snapshot: MemoryHealthReport;
  };
}


export type AgentIPCMessage =
  | { type: "HEARTBEAT" }
  | { type: "HEARTBEAT_ACK" }
  | { type: "INIT"; definition: AgentDefinition; checkpoint?: Checkpoint }
  | { type: "TASK_ASSIGNED"; task_id: string }
  | { type: "EVENT"; event: TaskEvent }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "SHUTDOWN"; graceful: boolean }
  | { type: "CHECKPOINT_REQUEST" }
  | { type: "CHECKPOINT_SAVED"; version: number }
  | { type: "STATUS_REQUEST" }
  | { type: "STATUS_RESPONSE"; state: AgentState }
  | { type: "COST_UPDATE"; task_id: string; cost_usd: number; tokens: number }
  | { type: "HYGIENE_REQUEST"; config: MemoryHygieneConfig }
  | { type: "HYGIENE_RESULT"; result: HygieneCycleResult }
  | { type: "MEMORY_HEALTH"; report: MemoryHealthReport };


export interface ProcessOptions {
  cwd: string;                         // working directory (division path)
  env: Record<string, string>;         // environment variables (NO secrets here)
  maxMemoryMB: number;                 // memory limit (default: 512)
  execArgv?: string[];                 // extra Node.js flags
  workerPath?: string;                 // override worker script path (for testing)
}


export type AgentAction =
  | { type: "llm_call"; request: LLMRequest }
  | { type: "create_sub_tasks"; tasks: CreateTaskInput[] }
  | { type: "write_result"; content: string; summary: ManagementSummary }
  | { type: "peer_consultation"; target_agent: string; question: string }
  | { type: "escalate"; reason: string };

export interface ActionResult {
  success: boolean;
  data?: unknown;
  blocked?: boolean;                   // true if Pre-Action Pipeline blocked
  block_reason?: string;
}


export interface LLMRequest {
  messages: Message[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  taskId?: string;
  metadata?: Record<string, unknown>;
}


export interface MemoryEntry {
  id: string;
  content: string;
  source: "short_term" | "long_term" | "pool";
  agent_id?: string;
  division?: string;
  task_id?: string;
  created_at: string;
  relevance_score?: number;
}


export interface BootstrapConfig {
  heartbeat_timeout_ms: number;        // max time between heartbeats (default: 30000)
  max_restart_attempts: number;        // before escalating (default: 3)
  token_burn_rate_limit: number;       // tokens/min threshold (rabbithole detection)
  check_interval_ms: number;           // how often to check all agents (default: 5000)
  cost_check_interval_ms: number;      // how often to check hourly costs (default: 60000)
  memory_check_interval_ms?: number;   // how often to check memory health (default: 300000 = 5min)
  memory_hygiene_schedule?: string | null; // cron expression, null = disabled
  agent_memory_configs?: Record<string, { short_term_path: string; skill_path?: string }>; // per-agent memory paths
}

export interface AgentHealthEntry {
  agent_id: string;
  status: AgentStatus;
  pid: number | null;
  last_heartbeat: string | null;
  heartbeat_healthy: boolean;
  restart_count: number;
  current_hour_cost: number;
  active_tasks: number;
}

export interface HealthAlert {
  severity: "WARNING" | "CRITICAL";
  agent_id: string;
  type:
    | "heartbeat_missed"
    | "high_burn_rate"
    | "budget_exceeded"
    | "repeated_crashes"
    | "task_timeout"
    | "memory_warning"    // memory approaching threshold
    | "memory_critical"   // memory exceeding hard limit
    | "skill_bloat";      // skill.md exceeding limit
  message: string;
  timestamp: string;
}

export interface HealthReport {
  timestamp: string;
  agents: AgentHealthEntry[];
  system_healthy: boolean;
  alerts: HealthAlert[];
  memory_health?: AgentMemoryHealth[];
}


export type AgentDecision =
  | { decision: "EXECUTE"; result: string; summary: string; confidence: number }
  | { decision: "DECOMPOSE"; plan: SubTaskPlan[] };

export interface SubTaskPlan {
  title: string;
  description: string;
  tier: 1 | 2 | 3;
}


export interface AgentValidationResult {
  valid: boolean;
  errors: string[];
}


export type MemoryTier = "short_term" | "long_term" | "pool";
export type CompactionStrategy = "smart" | "truncate" | "summarize";

export interface MemoryLifecycleConfig {
  short_term_warn_kb: number;        // default: 10
  short_term_compact_kb: number;     // default: 15
  short_term_hard_limit_kb: number;  // default: 25
  skill_file_warn_kb: number;        // default: 6
  skill_file_compact_kb: number;     // default: 8
  skill_file_hard_limit_kb: number;  // default: 12
  long_term_max_entries: number;     // default: 10000
  dedup_threshold: number;           // default: 0.95 cosine similarity
  archival_target: "qdrant" | "file"; // default: "file" (V1 fallback)
  compaction_strategy: CompactionStrategy; // default: "smart"
}

export interface HygieneRecommendation {
  priority: "low" | "medium" | "high";
  action: "compact" | "archive" | "deduplicate" | "migrate";
  tier: MemoryTier;
  reason: string;
  estimated_savings_kb: number;
}

export interface MemoryHealthReport {
  agent_id: string;
  timestamp: string;
  short_term: {
    size_kb: number;
    entry_count: number;
    status: "healthy" | "warning" | "critical";
    oldest_entry: string | null;
    newest_entry: string | null;
  };
  long_term: {
    entry_count: number;
    status: "healthy" | "warning" | "critical";
    last_archival: string | null;
  };
  pool: {
    size_kb: number;
    status: "healthy" | "warning";
  };
  skill_file: {
    size_kb: number;
    status: "healthy" | "warning" | "critical";
  };
  recommendations: HygieneRecommendation[];
}

export interface ArchivalTag {
  key: string;
  value: string;
}

export interface ArchivalCandidate {
  content: string;
  content_type: "decision" | "task_result" | "session" | "knowledge" | "error_log";
  original_created_at: string;
  task_id?: string;
  project_name?: string;
  persistence_check?: PersistenceCheck;
}

export interface ArchivalResult {
  archived_count: number;
  archived_size_kb: number;
  target: MemoryTier;
  entries: Array<{
    id: string;
    content_hash: string;
    tags: ArchivalTag[];
  }>;
  errors: Array<{ content: string; error: string }>;
}

export interface CompactionResult {
  strategy: CompactionStrategy;
  before_size_kb: number;
  after_size_kb: number;
  entries_removed: number;
  entries_retained: number;
  entries_archived: number;
  dry_run: boolean;
}

export interface MigrationResult {
  migrated_count: number;
  from: MemoryTier;
  to: MemoryTier;
  errors: Array<{ entry_id: string; error: string }>;
}

export interface DeduplicationResult {
  tier: MemoryTier;
  duplicates_found: number;
  duplicates_removed: number;
  space_saved_kb: number;
}

export interface PersistenceCheck {
  content_hash: string;
  persisted_in: Array<{
    store: "tasks_db" | "events_db" | "audit_trail" | "qdrant" | "none";
    reference_id?: string;
  }>;
  safe_to_remove: boolean;
}

export interface GovernanceActionLog {
  action_type: string;
  verdict: "ALLOW" | "BLOCK" | "PAUSE";
  reason?: string;
}

export interface HygieneCycleResult {
  agent_id: string;
  timestamp: string;
  dry_run: boolean;
  duration_ms: number;
  short_term: CompactionResult | null;
  archival: ArchivalResult | null;
  deduplication: DeduplicationResult | null;
  health_before: MemoryHealthReport;
  health_after: MemoryHealthReport;
  governance_actions: GovernanceActionLog[];
}

export interface RetentionConfig {
  always_retain: string[];
  time_based: Record<string, string>;
  never_retain: string[];
}

export interface ArchivalConfig {
  target: "qdrant" | "file";
  collection_prefix: string;
  required_tags: string[];
  traceability: boolean;
}

export interface MemoryHygieneConfig {
  thresholds: MemoryLifecycleConfig;
  retention: RetentionConfig;
  archival: ArchivalConfig;
  compaction: { strategy: CompactionStrategy; dry_run: boolean };
}


export interface DeepKnowledgeEntry {
  id: string;
  content: string;
  relevance_score: number;
  source: "qdrant" | "file_archive";
  content_type: string;
  created_at: string;
}

export interface EnrichedSkillDefinition extends SkillDefinition {
  deep_knowledge: DeepKnowledgeEntry[];
  deep_knowledge_tokens: number;
}

export interface SkillHealthReport {
  skill_path: string;
  size_kb: number;
  status: "healthy" | "warning" | "critical";
  last_modified: string;
  sections: Array<{
    name: string;
    size_kb: number;
    category: "operational" | "reference" | "archive_candidate";
  }>;
  recommendations: Array<{
    section: string;
    action: "keep" | "migrate_to_qdrant" | "remove";
    reason: string;
  }>;
}

export interface SkillCompactionRules {
  max_size_kb: number;
  keep_sections: string[];
  migrate_categories: string[];
}

export interface SkillCompactionResult {
  before_size_kb: number;
  after_size_kb: number;
  migrated_sections: number;
  migrated_entries: Array<{
    section_name: string;
    qdrant_id: string;
    content_hash: string;
  }>;
  new_skill_content: string;
}


export interface AgentMemoryHealth {
  agent_id: string;
  short_term_kb: number;
  short_term_status: "healthy" | "warning" | "critical";
  skill_file_kb: number;
  skill_file_status: "healthy" | "warning" | "critical";
  long_term_entries: number;
  last_hygiene_cycle: string | null;
  needs_compaction: boolean;
}
