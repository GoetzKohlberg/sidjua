# Known Issues — V1 Release History

All issues listed below were identified in V1.0.0 and resolved in V1.0.1 (March 31, 2026) unless noted otherwise.

## GUI & UX

### Audit Events Not Populated

After chat interactions with tool calls, the audit_events table may remain empty. This means the audit log page shows no data even though tools were executed successfully.

**Status: Resolved in V1.0.1**

### Agent Table Shows "auto" Instead of Active Provider

The agent list table displays `auto` in the MODEL column instead of the resolved provider/model name. The agent cards above the table correctly show the active provider.

**Status: Resolved in V1.0.1**

### Agent Status Inconsistency

Agent cards may show "active" while the table shows "Stopped" for the same agent. Both components read from different data sources.

**Status: Resolved in V1.0.1**

### Starter Team Banner Stays Visible

The blue "configure an LLM provider" banner remains visible even when all agents have a provider configured and are operational.

**Status: Resolved in V1.0.1**

### Advanced Provider Mode Not Persistent

Per-agent provider changes in Advanced mode are not saved. No API key field appears for new providers.

**Status: Resolved in V1.0.1**

### Agent Detail View Missing LLM Model Selection

Clicking on an agent card in "Your Team" shows details but no way to change the LLM provider or model directly.

**Status: Resolved in V1.0.1**

## Tools & Features

### create_agent_role Requires Description

When creating an agent and leaving the description empty, the tool returns an error. The agent may then fabricate a description instead of communicating the error.

**Status: Resolved in V1.0.1**

### HR Agent Uses Numeric Tier Labels

HR Agent shows tiers as "1/2/3". Tiers use numeric values (1/2/3) in the API. The HR knowledge document provides human-readable labels: Tier 1 (lightweight/fast), Tier 2 (capable), Tier 3 (specialized/powerful). Named tier labels for enterprise deployments are planned for a future release.

**Status: Partially Resolved**

## Infrastructure

### Division Sync Incomplete

`sidjua apply` syncs only the root divisions.yaml, not the individual files in defaults/divisions/. The GUI shows all divisions correctly from YAML, but the database may only have "default" active.

**Status: Resolved in V1.0.1**

---

For current known limitations, see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).
