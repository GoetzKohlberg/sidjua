# Template: Governance Demo

A minimal 2-agent setup designed to demonstrate SIDJUA's governance system.

## Agents

| ID | Tier | Role |
|---|---|---|
| ceo-demo | T1 | Delegating agent, triggers governance scenarios |
| worker-demo | T3 | Receives delegations, demonstrates T3 constraints |

## Setup

```bash
sidjua init --template governance-demo
sidjua apply
```

## Demo Walkthrough

Open two terminals:

**Terminal 1 — watch governance decisions:**
```bash
sidjua audit tail --follow
```

**Terminal 2 — interact with the agents:**
```bash
sidjua agent chat ceo-demo
```

Try these prompts in order:
1. "Delegate a short summary task to worker-demo" — succeeds
2. "Delete the file notes.txt" — blocked by governance rule `block-delete`
3. "Increase the daily budget to $50" — escalated for human approval
4. "Access the SECRET project plan" — blocked by `block-secret-classification`

## What to Observe

- `sidjua_governance_blocks_total` metric increments on each block
- Audit log records agent, tool, rule, and decision for every action
- `require_approval` actions pause execution until a human responds
