# Template: Research Lab

A T2 research lead with three T3 researcher workers for parallel research tasks.

## Agents

| ID | Tier | Role |
|---|---|---|
| research-lead | T2 | Coordination, decomposition, synthesis |
| researcher-1 | T3 | Research specialist |
| researcher-2 | T3 | Research specialist |
| researcher-3 | T3 | Research specialist |

## Setup

```bash
sidjua init --template research-lab
# Set required secrets:
sidjua secret set brave_search_api_key
sidjua apply
sidjua agent chat research-lead
```

## Customisation

- Add or remove researcher agents (copy `researcher-1.yaml`)
- Update `research-lead.yaml`'s `can_delegate_to` list accordingly
- Replace `brave` with another search provider in `config/mcp-servers.yaml`
- Increase `max_calls_per_task` in governance rules for deeper research
