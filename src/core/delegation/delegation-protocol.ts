/**
 * SIDJUA — Delegation Protocol
 *
 * Implements RBAC-gated task delegation between agents.
 * Rules:
 *   T1 → T2  allowed (cross-division)
 *   T2 → T3  allowed (cross-division)
 *   T2 → T2  allowed only within the same division
 *   T3 → any blocked
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DelegationRequest {
  /** Agent ID of the delegating agent */
  fromAgent: string;
  /** Tier of the delegating agent (1 | 2 | 3) */
  fromTier: 1 | 2 | 3;
  /** Division of the delegating agent */
  fromDivision: string;

  /** Agent ID of the target agent */
  toAgent: string;
  /** Tier of the target agent */
  toTier: 1 | 2 | 3;
  /** Division of the target agent */
  toDivision: string;

  /** Short title for the delegated task */
  title: string;
  /** Full instructions for the target agent */
  instructions: string;
  /** Optional parent task ID for tree linkage */
  parentTaskId?: string;
  /** Optional context data passed to the target agent */
  context?: Record<string, unknown>;
}

export interface DelegationResult {
  /** Whether the delegation was accepted */
  accepted: boolean;
  /** Task ID created for the delegated work (present when accepted) */
  taskId?: string;
  /** Reason for rejection (present when not accepted) */
  reason?: string;
  /** RBAC rule that was violated (present when rejected due to RBAC) */
  violatedRule?: string;
}

// ─── Tool definition (used by agent runtime to expose `delegate_task`) ────────

export const DELEGATE_TASK_TOOL = {
  name: "delegate_task",
  description:
    "Delegate a subtask to another agent. Subject to RBAC tier/division rules. " +
    "Returns the new task ID on success.",
  inputSchema: {
    type: "object" as const,
    properties: {
      to_agent: {
        type: "string",
        description: "Agent ID of the target agent",
      },
      title: {
        type: "string",
        description: "Short title for the delegated task (max 120 chars)",
      },
      instructions: {
        type: "string",
        description: "Full instructions for the target agent",
      },
      context: {
        type: "object",
        description: "Optional context data to pass to the target agent",
        additionalProperties: true,
      },
    },
    required: ["to_agent", "title", "instructions"],
  },
} as const;

// ─── RBAC Validation ─────────────────────────────────────────────────────────

export interface RbacViolation {
  allowed: false;
  rule: string;
  detail: string;
}

export interface RbacAllowed {
  allowed: true;
}

export type RbacResult = RbacAllowed | RbacViolation;

/**
 * Validates whether a delegation is permitted under SIDJUA tier/division RBAC.
 *
 * Rules:
 *   1. T3 agents cannot delegate to anyone.
 *   2. T1 → T2: always allowed.
 *   3. T2 → T3: always allowed.
 *   4. T2 → T2: only within the same division.
 *   5. T1 → T1 / T1 → T3 / T2 → T1 / T3 → * : blocked.
 */
export function validateDelegationRbac(req: DelegationRequest): RbacResult {
  const { fromTier, toDivision, fromDivision, toTier } = req;

  // Rule 1: T3 cannot delegate
  if (fromTier === 3) {
    return {
      allowed: false,
      rule: "T3_NO_DELEGATION",
      detail: "Tier-3 agents cannot delegate tasks to other agents.",
    };
  }

  // Rule 2: T1 → T2 allowed (cross-division)
  if (fromTier === 1 && toTier === 2) {
    return { allowed: true };
  }

  // Rule 3: T2 → T3 allowed (cross-division)
  if (fromTier === 2 && toTier === 3) {
    return { allowed: true };
  }

  // Rule 4: T2 → T2 same division only
  if (fromTier === 2 && toTier === 2) {
    if (fromDivision === toDivision) {
      return { allowed: true };
    }
    return {
      allowed: false,
      rule: "T2_CROSS_DIVISION_BLOCKED",
      detail: `T2 agents may only delegate to T2 peers within the same division (${fromDivision}). Target is in division '${toDivision}'.`,
    };
  }

  // All other combinations are blocked
  return {
    allowed: false,
    rule: "TIER_COMBINATION_BLOCKED",
    detail: `Delegation from T${fromTier} to T${toTier} is not permitted.`,
  };
}

// ─── DelegationManager ───────────────────────────────────────────────────────

export interface AgentRegistry {
  getAgent(agentId: string): { tier: 1 | 2 | 3; division: string } | undefined;
}

export interface TaskCreator {
  createTask(input: {
    title: string;
    description: string;
    division: string;
    type: "execution";
    tier: 1 | 2 | 3;
    parent_id?: string;
    assigned_agent: string;
    token_budget: number;
    cost_budget: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export class DelegationManager {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly taskCreator: TaskCreator,
  ) {}

  async delegate(req: DelegationRequest): Promise<DelegationResult> {
    // RBAC check
    const rbac = validateDelegationRbac(req);
    if (!rbac.allowed) {
      return {
        accepted: false,
        reason: rbac.detail,
        violatedRule: rbac.rule,
      };
    }

    // Verify target agent exists
    const targetAgent = this.registry.getAgent(req.toAgent);
    if (!targetAgent) {
      return {
        accepted: false,
        reason: `Target agent '${req.toAgent}' not found in registry.`,
      };
    }

    // Create the delegated task
    const task = await this.taskCreator.createTask({
      title: req.title.slice(0, 120),
      description: req.instructions,
      division: req.toDivision,
      type: "execution",
      tier: req.toTier,
      assigned_agent: req.toAgent,
      token_budget: 16_000,
      cost_budget: 1.0,
      ...(req.parentTaskId !== undefined ? { parent_id: req.parentTaskId } : {}),
      metadata: {
        delegated_from: req.fromAgent,
        delegated_at: new Date().toISOString(),
        ...(req.context ?? {}),
      },
    });

    return { accepted: true, taskId: task.id };
  }
}
