# Template: Developer Workspace

A single T3 developer assistant with filesystem and GitHub MCP access.

## Agents

| ID | Tier | Role |
|---|---|---|
| dev-assistant | T3 | Coding, review, debug, documentation |

## Setup

```bash
sidjua init --template developer-workspace
# Set required secrets:
sidjua secret set github_token
sidjua apply
sidjua agent chat dev-assistant
```

## Customisation

- Set `SIDJUA_WORK_DIR` to your project root
- Enable `allow_push: true` in `config/mcp-servers.yaml` if you trust auto-push
  (and remove the `block-push` governance rule)
- Increase `per_task_usd` for large refactors
