// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * InternalToolAdapter — wraps a native TypeScript tool function into the
 * ToolAdapter interface.  Internal tools run in-process (no MCP, no REST,
 * no shell exec for the adapter layer itself) and are always available.
 */

import type {
  ToolAdapter,
  ToolAction,
  ToolResult,
  ToolCapability,
  ToolType,
} from "../types.js";

export type InternalToolFunction = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface InternalCapabilityDef {
  name: string;
  description: string;
  risk_level: "low" | "medium" | "high" | "critical";
  requires_approval: boolean;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export interface InternalToolDef {
  id: string;
  name: string;
  description: string;
  capabilities: InternalCapabilityDef[];
  execute: InternalToolFunction;
}

export class InternalToolAdapter implements ToolAdapter {
  readonly id: string;
  /** Reuse "composite" ToolType — internal tools are native TS function composites. */
  readonly type: ToolType = "composite";

  private readonly def: InternalToolDef;

  constructor(def: InternalToolDef) {
    this.id  = def.id;
    this.def = def;
  }

  async connect(): Promise<void> { /* no-op — always available */ }
  async disconnect(): Promise<void> { /* no-op */ }
  async healthCheck(): Promise<boolean> { return true; }

  getCapabilities(): ToolCapability[] {
    return this.def.capabilities.map((c) => ({
      id:               `${this.id}:${c.name}`,
      tool_id:          this.id,
      name:             c.name,
      description:      c.description,
      risk_level:       c.risk_level,
      requires_approval: c.requires_approval,
      input_schema:     c.input_schema,
      output_schema:    c.output_schema,
    }));
  }

  async execute(action: ToolAction): Promise<ToolResult> {
    const start = Date.now();
    try {
      const data = await this.def.execute(action.params);
      return { success: true, data, duration_ms: Date.now() - start };
    } catch (err: unknown) {
      return {
        success: false,
        error:   err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  }
}
