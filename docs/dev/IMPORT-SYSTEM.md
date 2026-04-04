# Import System

## What It Does

SIDJUA can import agent configurations from competitor platforms, reducing
migration friction for operators switching to SIDJUA. The import system reads
the source installation, maps the existing configuration to SIDJUA equivalents,
and generates ready-to-use YAML definitions, skill files, and connector config.

Currently supported: **OpenClaw**.

---

## How It Works

1. **Validate path** — `validateOpenClawPath()` resolves `~` expansion, checks the directory exists, and verifies required OpenClaw files are present.
2. **Parse files** — the parser reads `agents.md`, `soul.md`, `memory.md`, `heartbeat.md`, `config.yaml`, and `.clawhub` into typed structures.
3. **Map skills to MCP** — `lookupSkillMapping()` checks each OpenClaw skill against the mapping table (18 direct mappings, 1 partial, 5 not supported).
4. **Generate config** — mappers produce SIDJUA YAML agent definitions, skill Markdown files, scheduler YAML for heartbeats, and adapter YAML for channels.
5. **Store secrets** — any API keys or tokens found in the source config are written to SIDJUA's encrypted secrets store under the agent's namespace.
6. **Report** — `executeImport()` returns an `ImportResult` listing succeeded components, failed components, and unsupported features with explanations.

The import is **fail-component**: if one component fails to import, the others
continue. The result always tells you exactly what was imported and what was not.

---

## Key Files

| Path | Purpose |
|------|---------|
| `src/core/import/types.ts` | `OpenClawAgent`, `SkillMapping`, `ImportResult` interfaces |
| `src/core/import/openclaw-validators.ts` | Path validation, directory structure check |
| `src/core/import/openclaw-parser.ts` | Parsers for all OpenClaw file formats |
| `src/core/import/skill-mapping-table.ts` | 24-entry skill mapping table, `lookupSkillMapping()` |
| `src/core/import/openclaw-mappers.ts` | Transforms parsed data into SIDJUA config files |
| `src/core/import/import-executor.ts` | `analyzeInstallation()` (read-only) + `executeImport()` (write) |
| `src/core/import/index.ts` | Barrel export |
| `agents/skills/knowledge/openclaw-skill-mapping.md` | Human-readable skill mapping reference (for HR agent) |
| `agents/skills/knowledge/openclaw-filesystem.md` | OpenClaw directory structure reference |

---

## CLI Usage

```bash
# Preview what would be imported (read-only)
sidjua import analyze /path/to/openclaw-installation

# Execute the import
sidjua import run /path/to/openclaw-installation

# Import to a specific workspace
sidjua import run /path/to/openclaw-installation --workdir /var/sidjua
```

---

## Skill Mapping Table

| OpenClaw skill | SIDJUA equivalent | Status |
|---------------|-------------------|--------|
| `web_search` | `mcp/brave-search` | Direct |
| `file_manager` | `mcp/filesystem` | Direct |
| `email` | messaging adapter (email) | Direct |
| `slack` | messaging adapter (slack) | Direct |
| `calendar` | `mcp/google-calendar` | Direct |
| `code_executor` | sandbox tool | Direct |
| `database_query` | `mcp/sqlite` or `mcp/postgres` | Direct |
| `image_analysis` | vision via provider API | Direct |
| *(18 total direct)* | | |
| `trading_bot` | — | Not supported |
| `browser_automation` | — | Not supported |
| *(5 total unsupported)* | | |

For the full mapping table see `agents/skills/knowledge/openclaw-skill-mapping.md`.

---

## Common Questions

**What doesn't get imported?**

The following are not imported, with reasons:

| Feature | Reason |
|---------|--------|
| Custom trading bots | Requires regulatory approval before enabling |
| Browser automation scripts | Security review required per site |
| Raw Python scripts | SIDJUA uses MCP tools, not arbitrary code |
| Direct database credentials | Must be re-entered via `sidjua secrets set` |
| Scheduled tasks with `@reboot` | Use `sidjua schedule add` with an explicit cron expression |

**Will the import overwrite existing agents?**

No. The import creates new files under new names and never overwrites existing
SIDJUA configuration. If an agent with the same `id` already exists, the
import skips that component and reports it in the `ImportResult`.

**What permissions does the import need?**

Read access to the source installation and write access to the SIDJUA workspace.
The import never modifies the source installation.
