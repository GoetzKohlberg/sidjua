# Template: Personal Assistant

A single T3 assistant agent for personal productivity tasks.

## Agents

| ID | Tier | Role |
|---|---|---|
| assistant | T3 | Personal productivity assistant |

## Setup

```bash
sidjua init --template personal-assistant
sidjua apply
sidjua agent chat assistant
```

## Customisation

- Edit `agents/assistant.yaml` to change the model or budget
- Edit `agents/assistant.md` to adjust the assistant's persona and instructions
- Add MCP servers in `config/mcp-servers.yaml` for additional capabilities
