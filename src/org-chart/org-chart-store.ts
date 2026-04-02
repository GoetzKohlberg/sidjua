// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * OrgChartStore — read-only queries for the SIDJUA org chart hierarchy.
 *
 * Queries the `agents` and `divisions` tables (V3 schema, V1_INITIAL base).
 * All methods return plain data objects — no side effects.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrgAgentNode {
  id:           string;
  name:         string;
  tier:         number;
  division_code: string | null;
  role_title:   string | null;
  reports_to:   string | null;
  delegate_to:  string | null;
  active:       boolean;
}

export interface OrgDivisionNode {
  code:                 string;
  name_en:              string;
  parent_division_code: string | null;
  budget_allocation:    number | null;
  active:               boolean;
  head_agent:           string | null;
  head_role:            string | null;
}

export interface OrgNode {
  division:  OrgDivisionNode;
  agents:    OrgAgentNode[];
  children:  OrgNode[];
}

export interface OrgTreeResponse {
  roots: OrgNode[];
}

export interface OrgAgentDetail {
  agent:      OrgAgentNode;
  division:   OrgDivisionNode | null;
  reports_to_agent:  OrgAgentNode | null;
  delegate_to_agent: OrgAgentNode | null;
  direct_reports:    OrgAgentNode[];
}

export interface OrgDivisionDetail {
  division:          OrgDivisionNode;
  parent:            OrgDivisionNode | null;
  children:          OrgDivisionNode[];
  agents:            OrgAgentNode[];
  head_agent_detail: OrgAgentNode | null;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface AgentRow {
  id:            string;
  name:          string;
  tier:          number;
  division_code: string | null;
  role_title:    string | null;
  reports_to:    string | null;
  delegate_to:   string | null;
  active:        number;
}

interface DivisionRow {
  code:                 string;
  name_en:              string;
  parent_division_code: string | null;
  budget_allocation:    number | null;
  active:               number;
  head_agent:           string | null;
  head_role:            string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class OrgChartStore {
  constructor(private readonly db: InstanceType<typeof Database>) {}

  // ---- private helpers ---------------------------------------------------

  private _allAgents(): OrgAgentNode[] {
    const rows = this.db.prepare<[], AgentRow>(`
      SELECT id, name, tier, division_code,
             role_title, reports_to, delegate_to, active
      FROM   agents
      ORDER  BY name ASC
    `).all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  private _allDivisions(): OrgDivisionNode[] {
    const rows = this.db.prepare<[], DivisionRow>(`
      SELECT code, name_en, parent_division_code,
             budget_allocation, active, head_agent, head_role
      FROM   divisions
      ORDER  BY code ASC
    `).all() as DivisionRow[];
    return rows.map(rowToDivision);
  }

  private _agentById(id: string): OrgAgentNode | null {
    const row = this.db.prepare<[string], AgentRow>(`
      SELECT id, name, tier, division_code,
             role_title, reports_to, delegate_to, active
      FROM   agents
      WHERE  id = ?
    `).get(id) as AgentRow | undefined;
    return row !== undefined ? rowToAgent(row) : null;
  }

  private _divisionByCode(code: string): OrgDivisionNode | null {
    const row = this.db.prepare<[string], DivisionRow>(`
      SELECT code, name_en, parent_division_code,
             budget_allocation, active, head_agent, head_role
      FROM   divisions
      WHERE  code = ?
    `).get(code) as DivisionRow | undefined;
    return row !== undefined ? rowToDivision(row) : null;
  }

  private _agentsByDivision(divisionCode: string): OrgAgentNode[] {
    const rows = this.db.prepare<[string], AgentRow>(`
      SELECT id, name, tier, division_code,
             role_title, reports_to, delegate_to, active
      FROM   agents
      WHERE  division_code = ?
      ORDER  BY name ASC
    `).all(divisionCode) as AgentRow[];
    return rows.map(rowToAgent);
  }

  private _childDivisions(parentCode: string): OrgDivisionNode[] {
    const rows = this.db.prepare<[string], DivisionRow>(`
      SELECT code, name_en, parent_division_code,
             budget_allocation, active, head_agent, head_role
      FROM   divisions
      WHERE  parent_division_code = ?
      ORDER  BY code ASC
    `).all(parentCode) as DivisionRow[];
    return rows.map(rowToDivision);
  }

  private _directReports(agentId: string): OrgAgentNode[] {
    const rows = this.db.prepare<[string], AgentRow>(`
      SELECT id, name, tier, division_code,
             role_title, reports_to, delegate_to, active
      FROM   agents
      WHERE  reports_to = ?
      ORDER  BY name ASC
    `).all(agentId) as AgentRow[];
    return rows.map(rowToAgent);
  }

  // ---- public API --------------------------------------------------------

  /**
   * Returns the full org chart tree.
   * Root divisions are those with no parent_division_code (or an unknown parent).
   * Each node contains the division metadata, its agents, and its child OrgNodes.
   */
  getTree(): OrgTreeResponse {
    const allDivisions = this._allDivisions();
    const allAgents    = this._allAgents();

    const divSet = new Set(allDivisions.map((d) => d.code));

    // Build agent index by division code
    const agentsByDiv = new Map<string, OrgAgentNode[]>();
    for (const agent of allAgents) {
      const key = agent.division_code ?? "__none__";
      const arr = agentsByDiv.get(key) ?? [];
      arr.push(agent);
      agentsByDiv.set(key, arr);
    }

    // Build division child index
    const childDivsMap = new Map<string, OrgDivisionNode[]>();
    for (const div of allDivisions) {
      if (div.parent_division_code !== null && divSet.has(div.parent_division_code)) {
        const arr = childDivsMap.get(div.parent_division_code) ?? [];
        arr.push(div);
        childDivsMap.set(div.parent_division_code, arr);
      }
    }

    const buildNode = (div: OrgDivisionNode): OrgNode => ({
      division: div,
      agents:   agentsByDiv.get(div.code) ?? [],
      children: (childDivsMap.get(div.code) ?? []).map(buildNode),
    });

    // Root divisions: no parent, or parent not in DB
    const roots = allDivisions.filter(
      (d) => d.parent_division_code === null || !divSet.has(d.parent_division_code),
    );

    return { roots: roots.map(buildNode) };
  }

  /**
   * Returns detailed org-chart data for a single agent.
   * Returns null if the agent does not exist.
   */
  getAgentDetail(agentId: string): OrgAgentDetail | null {
    const agent = this._agentById(agentId);
    if (agent === null) return null;

    const division        = agent.division_code !== null ? this._divisionByCode(agent.division_code) : null;
    const reportsToAgent  = agent.reports_to !== null ? this._agentById(agent.reports_to) : null;
    const delegateToAgent = agent.delegate_to !== null ? this._agentById(agent.delegate_to) : null;
    const directReports   = this._directReports(agentId);

    return { agent, division, reports_to_agent: reportsToAgent, delegate_to_agent: delegateToAgent, direct_reports: directReports };
  }

  /**
   * Returns all agent IDs from the agents table.
   * Used by the status endpoint to enumerate all known agents.
   */
  getAllAgentIds(): string[] {
    const rows = this.db.prepare<[], { id: string }>('SELECT id FROM agents').all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Returns detailed org-chart data for a single division.
   * Returns null if the division does not exist.
   */
  getDivisionDetail(code: string): OrgDivisionDetail | null {
    const division = this._divisionByCode(code);
    if (division === null) return null;

    const parent          = division.parent_division_code !== null ? this._divisionByCode(division.parent_division_code) : null;
    const children        = this._childDivisions(code);
    const agents          = this._agentsByDivision(code);
    const headAgentDetail = division.head_agent !== null ? this._agentById(division.head_agent) : null;

    return { division, parent, children, agents, head_agent_detail: headAgentDetail };
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToAgent(r: AgentRow): OrgAgentNode {
  return {
    id:            r.id,
    name:          r.name,
    tier:          r.tier,
    division_code: r.division_code,
    role_title:    r.role_title,
    reports_to:    r.reports_to,
    delegate_to:   r.delegate_to,
    active:        r.active === 1,
  };
}

function rowToDivision(r: DivisionRow): OrgDivisionNode {
  return {
    code:                 r.code,
    name_en:              r.name_en,
    parent_division_code: r.parent_division_code,
    budget_allocation:    r.budget_allocation,
    active:               r.active === 1,
    head_agent:           r.head_agent,
    head_role:            r.head_role,
  };
}
