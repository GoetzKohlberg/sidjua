# OpenClaw Skill → MCP Server Mapping

This table shows how OpenClaw skills map to MCP server packages in SIDJUA.
Use it to guide users on what gets auto-imported and what requires manual setup.

---

## Direct Equivalents

These skills have a 1:1 MCP server equivalent and are auto-configured during import.

| OpenClaw Skill | MCP Server Package | Notes |
|---|---|---|
| `skill-filesystem` | `@anthropic/mcp-server-filesystem` | Path scoping via governance |
| `file-manager` | `@anthropic/mcp-server-filesystem` | Path scoping via governance |
| `skill-github` | `@anthropic/mcp-server-github` | Token via secrets provider |
| `github` | `@anthropic/mcp-server-github` | Token via secrets provider |
| `skill-brave-search` | `@anthropic/mcp-server-brave-search` | API key required |
| `web-search` | `@anthropic/mcp-server-brave-search` | API key required |
| `skill-google-calendar` | `google-calendar-mcp` | OAuth setup needed post-import |
| `skill-gmail` | `google-gmail-mcp` | OAuth setup needed post-import |
| `skill-slack` | `@anthropic/mcp-server-slack` | Bot token via secrets |
| `skill-sqlite` | `@anthropic/mcp-server-sqlite` | DB path via governance |
| `skill-puppeteer` | `@anthropic/mcp-server-puppeteer` | Headless browser |
| `skill-fetch` | `@anthropic/mcp-server-fetch` | URL governance applies |
| `skill-git` | `@anthropic/mcp-server-git` | Repo path scoped |
| `skill-notion` | `notion-mcp` | Integration token needed |
| `skill-todoist` | `todoist-mcp` | API token needed |
| `skill-linear` | `linear-mcp` | API key needed |
| `skill-postgres` | `@anthropic/mcp-server-postgres` | Connection string via secrets |
| `skill-memory` | `@anthropic/mcp-server-memory` | Knowledge graph storage |

---

## Partial Equivalents

These skills have a close MCP equivalent but may require additional configuration
or have API version differences.

| OpenClaw Skill | MCP Server Package | Notes |
|---|---|---|
| `skill-home-assistant` | `homeassistant-mcp` | Different API version — verify endpoints |

---

## No Direct Equivalent

These skills have no current MCP equivalent. They require a custom SIDJUA Module
(see Module SDK documentation) or can be replaced by a REST wrapper.

| OpenClaw Skill | Reason | Recommended Alternative |
|---|---|---|
| `skill-spotify` | No MCP equivalent | Build REST wrapper module |
| `skill-trading` | Domain-specific | Custom Module SDK implementation |
| `skill-voice` | TTS/STT as external service | External service integration |
| `calculator` | LLM native capability | No migration needed |
| `translator` | LLM native capability | No migration needed |

---

## Unknown / Custom Skills

Skills not in the table above are treated as "custom skills". The import records
them in `import-data/mcp-servers-import.yaml` with `status: none` and a note
recommending manual migration using the Module SDK.

To build a custom module: `sidjua module init <name>`

---

## Post-Import Steps for Secret-Dependent Skills

After import, these skills require token/key setup:

1. Run `sidjua secret set <namespace> <key>` for each required token
2. Edit `config/mcp-servers.yaml` to enable the servers (set `enabled: true`)
3. Run `sidjua apply` to apply the updated configuration
4. Test with `sidjua mcp test <server-name>`
