# OpenClaw Installation Filesystem Structure

This document describes the directory layout of an OpenClaw installation.
It is used by the HR-Manager agent to guide users through the import process.

---

## Default Installation Location

OpenClaw stores its workspace in the user's home directory by default:

```
~/.openclaw/
```

Users may also use a custom path (e.g. `~/agents/my-assistant/`).

---

## Core Files

| File | Required | Purpose |
|------|----------|---------|
| `AGENTS.md` | **Yes** | Agent definitions — name, model, capabilities |
| `SOUL.md` | No | System prompt / personality definition |
| `MEMORY.md` | No | Long-term memories (key-value + free text) |
| `HEARTBEAT.md` | No | Scheduled tasks (cron-like entries) |
| `config.yaml` | No | API keys, channel tokens, provider configuration |
| `.env` | No | Alternative to config.yaml for environment variables |

### AGENTS.md Format

```markdown
## AgentName
Model: claude-sonnet-4-6
Provider: anthropic
Capabilities: search, summarization, coding
```

Multiple agents are separated by `## ` headers. Supports optional YAML frontmatter per section.

### SOUL.md Format

Free-form Markdown. The entire file is used as the agent's system prompt.
Personality trait lines typically start with "You are ...", "You speak ...", "You think ...".

### MEMORY.md Format

```markdown
## Facts
- User prefers Python over JavaScript
- User works in Berlin timezone

## Preferences
- Prefers concise answers
```

Sections use `## ` headers as categories. List items with `- ` are individual memories.
Memory types: `fact`, `preference`, `conversation`.

### HEARTBEAT.md Format

```markdown
## Morning Summary
Schedule: daily 07:00
Action: Summarize yesterday's activity and plan today's tasks

## Weekly Report
Schedule: friday 17:00
Action: Generate weekly progress report
```

Supported schedule formats:
- `daily HH:MM` → `MM HH * * *`
- `friday HH:MM` → `MM HH * * 5`
- `weekly monday HH:MM` → `MM HH * * 1`
- Standard cron expressions (5 fields)

### config.yaml Format

```yaml
channels:
  telegram:
    token: <bot-token>
    chat_id: <chat-id>
  discord:
    token: <bot-token>
    guild_id: <server-id>
```

**Security note:** Values that look like API tokens are automatically detected
and stored via SIDJUA's secrets provider during import. They are never written
to config files in plaintext.

---

## Skill Directory

```
~/.openclaw/
  .clawhub/
    installed.json        ← Manifest of installed skills
    registry.json         ← Alternative manifest format
    skills/
      skill-github/
        package.json      ← Name, version, description
        SKILL.md          ← Tool list and usage docs
        index.js          ← Skill implementation
      skill-filesystem/
        ...
```

### installed.json Format

```json
["skill-github", "skill-filesystem", "skill-brave-search"]
```

Or object format:

```json
{
  "skill-github": { "version": "1.2.0" },
  "skill-filesystem": { "version": "0.8.1" }
}
```

### SKILL.md Format

```markdown
# skill-github

GitHub integration for OpenClaw.

## Tools
- `create_issue` — Create a new GitHub issue
- `list_prs` — List open pull requests
- `merge_pr` — Merge a pull request
```

---

## Import Checklist

When a user asks to import an OpenClaw installation, confirm:

1. **Path exists** — `~/.openclaw/` or custom path provided
2. **AGENTS.md is present** — minimum requirement for import
3. **config.yaml has secrets** — user must confirm secrets are stored securely
4. **Skills are compatible** — check skill mapping table for equivalents
5. **Heartbeats use valid schedules** — natural language converted to cron

Run `sidjua import openclaw <path>` to start the import. Use `--dry-run` first.
