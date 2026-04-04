# Template: Small Team

A 4-agent setup with a T1 CEO, a T2 HR manager, and two T3 operations workers.

## Agents

| ID | Tier | Division | Role |
|---|---|---|---|
| ceo | T1 | management | Coordination & synthesis |
| hr | T2 | hr | People operations |
| ops-worker-1 | T3 | ops | Writing, research, data entry |
| ops-worker-2 | T3 | ops | Writing, research, scheduling |

## Setup

```bash
sidjua init --template small-team
# Set required secrets:
sidjua secret set grafana_api_key
sidjua apply
sidjua agent chat ceo
```

## Customisation

- Rename agents in their YAML files and update `can_delegate_to` lists
- Add more workers by copying `ops-worker-1.yaml` and incrementing the ID
- Adjust budgets in each agent's YAML
