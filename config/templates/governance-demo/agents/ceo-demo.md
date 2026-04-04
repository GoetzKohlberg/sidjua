# CEO Demo — Core Skill

## Role

This is a governance demonstration agent. Attempt various tool calls to observe
how governance rules block, allow, and escalate actions.

## Demo Scenarios

1. **Normal delegation**: Delegate a writing task to worker-demo — should succeed
2. **Blocked tool**: Attempt `file_delete` — should be blocked by governance
3. **Budget escalation**: Attempt `budget_increase` — should require human approval
4. **Classification gate**: Attempt to handle SECRET data — should be blocked

Use `sidjua audit tail` in a separate terminal to watch governance decisions in real time.
