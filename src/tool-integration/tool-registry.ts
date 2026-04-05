// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Tool Registry
 *
 * CRUD on `tool_definitions` + `tool_capabilities` tables.
 */

import type { Database } from "../utils/db.js";
import type {
  ToolDefinition,
  ToolStatus,
  ToolCapability,
  CreateToolInput,
  ToolConfig,
  RiskLevel,
} from "./types.js";


interface DbToolRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
  status: string;
  pid: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DbCapabilityRow {
  id: string;
  tool_id: string;
  name: string;
  description: string;
  risk_level: string;
  requires_approval: number;
  input_schema: string;
  output_schema: string;
}


export class ToolRegistry {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Create a tool definition and its capabilities in the DB.
   * Returns the fully-hydrated ToolDefinition.
   */
  create(input: CreateToolInput): ToolDefinition {
    const now = new Date().toISOString();
    const configJson = JSON.stringify(input.config);

    this.db
      .prepare<[string, string, string, string, string, string], void>(
        `INSERT INTO tool_definitions
           (id, name, type, config_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'inactive', ?, ?)`,
      )
      .run(input.id, input.name, input.type, configJson, now, now);

    const caps = input.capabilities ?? [];
    for (const cap of caps) {
      const capId = `${input.id}:${cap.name}`;
      this.db
        .prepare<[string, string, string, string, string, number, string, string], void>(
          `INSERT INTO tool_capabilities
             (id, tool_id, name, description, risk_level, requires_approval,
              input_schema, output_schema)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capId,
          input.id,
          cap.name,
          cap.description,
          cap.risk_level,
          cap.requires_approval ? 1 : 0,
          JSON.stringify(cap.input_schema),
          JSON.stringify(cap.output_schema),
        );
    }

    return this.getById(input.id);
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  /**
   * Retrieve a tool by ID. Throws if the tool is not found.
   */
  getById(id: string): ToolDefinition {
    const row = this.db
      .prepare<[string], DbToolRow>(
        `SELECT id, name, type, config_json, status, pid, error_message,
                created_at, updated_at
         FROM tool_definitions WHERE id = ?`,
      )
      .get(id);

    if (row === undefined) {
      throw new Error(`ToolRegistry: tool not found: ${id}`);
    }

    return this.mapRow(row);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * List all tools, optionally filtered by status.
   */
  list(statusFilter?: ToolStatus): ToolDefinition[] {
    let rows: DbToolRow[];

    if (statusFilter !== undefined) {
      rows = this.db
        .prepare<[string], DbToolRow>(
          `SELECT id, name, type, config_json, status, pid, error_message,
                  created_at, updated_at
           FROM tool_definitions WHERE status = ?`,
        )
        .all(statusFilter);
    } else {
      rows = this.db
        .prepare<[], DbToolRow>(
          `SELECT id, name, type, config_json, status, pid, error_message,
                  created_at, updated_at
           FROM tool_definitions`,
        )
        .all();
    }

    return rows.map((r) => this.mapRow(r));
  }

  // -------------------------------------------------------------------------
  // updateStatus
  // -------------------------------------------------------------------------

  /**
   * Update the status of a tool, and optionally its pid and error_message.
   */
  updateStatus(
    id: string,
    status: ToolStatus,
    pid?: number,
    errorMessage?: string,
  ): void {
    const now = new Date().toISOString();
    const pidVal: number | null = pid !== undefined ? pid : null;
    const errVal: string | null = errorMessage !== undefined ? errorMessage : null;

    this.db
      .prepare<[string, number | null, string | null, string, string], void>(
        `UPDATE tool_definitions
         SET status = ?, pid = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, pidVal, errVal, now, id);
  }

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------

  /**
   * Get all capabilities for a tool.
   */
  getCapabilities(toolId: string): ToolCapability[] {
    const rows = this.db
      .prepare<[string], DbCapabilityRow>(
        `SELECT id, tool_id, name, description, risk_level, requires_approval,
                input_schema, output_schema
         FROM tool_capabilities WHERE tool_id = ?`,
      )
      .all(toolId);

    return rows.map((r) => this.mapCapabilityRow(r));
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * Delete a tool and all its associated capabilities.
   */
  delete(id: string): void {
    this.db
      .prepare<[string], void>(
        `DELETE FROM tool_capabilities WHERE tool_id = ?`,
      )
      .run(id);

    this.db
      .prepare<[string], void>(
        `DELETE FROM tool_definitions WHERE id = ?`,
      )
      .run(id);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private mapRow(row: DbToolRow): ToolDefinition {
    const config = JSON.parse(row.config_json) as ToolConfig;

    const def: ToolDefinition = {
      id: row.id,
      name: row.name,
      type: row.type as ToolDefinition["type"],
      config,
      status: row.status as ToolStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (row.pid !== null) {
      def.pid = row.pid;
    }

    if (row.error_message !== null) {
      def.error_message = row.error_message;
    }

    return def;
  }

  private mapCapabilityRow(row: DbCapabilityRow): ToolCapability {
    return {
      id: row.id,
      tool_id: row.tool_id,
      name: row.name,
      description: row.description,
      risk_level: row.risk_level as RiskLevel,
      requires_approval: row.requires_approval !== 0,
      input_schema: JSON.parse(row.input_schema) as Record<string, unknown>,
      output_schema: JSON.parse(row.output_schema) as Record<string, unknown>,
    };
  }
}
