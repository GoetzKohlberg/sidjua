[English](README.md) | [Deutsch](docs/translations/README.de.md) | [Español](docs/translations/README.es.md) | [Français](docs/translations/README.fr.md) | [日本語](docs/translations/README.ja.md) | [한국어](docs/translations/README.ko.md) | [中文 (简体)](docs/translations/README.zh-CN.md) | [中文 (繁體)](docs/translations/README.zh-TW.md) | [العربية](docs/translations/README.ar.md) | [বাংলা](docs/translations/README.bn.md) | [Čeština](docs/translations/README.cs.md) | [Filipino](docs/translations/README.fil.md) | [हिन्दी](docs/translations/README.hi.md) | [Bahasa Indonesia](docs/translations/README.id.md) | [Italiano](docs/translations/README.it.md) | [Bahasa Melayu](docs/translations/README.ms.md) | [Nederlands](docs/translations/README.nl.md) | [Polski](docs/translations/README.pl.md) | [Português (BR)](docs/translations/README.pt-BR.md) | [Română](docs/translations/README.ro.md) | [Русский](docs/translations/README.ru.md) | [Svenska](docs/translations/README.sv.md) | [ภาษาไทย](docs/translations/README.th.md) | [Türkçe](docs/translations/README.tr.md) | [Українська](docs/translations/README.uk.md) | [Tiếng Việt](docs/translations/README.vi.md)

---

# SIDJUA Free — AI Agent Orchestration Platform

> The only agent platform where governance is enforced by architecture, not by hoping the model behaves.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Fgoetzkohlberg%2Fsidjua-blue)](https://ghcr.io/goetzkohlberg/sidjua)
[![Version](https://img.shields.io/badge/version-1.0.1-green)](https://github.com/GoetzKohlberg/sidjua/releases)

---

## Installation

### Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| **Node.js** | >= 22.0.0 | ES modules, `fetch()`, `crypto.subtle`. [Download](https://nodejs.org) |
| **C/C++ Toolchain** | Source builds only | `better-sqlite3` and `argon2` compile native addons |
| **Docker** | >= 24 (optional) | Only for Docker deployment |

Install Node.js 22: Ubuntu/Debian (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`), macOS (`brew install node@22`), Windows (`winget install OpenJS.NodeJS.LTS`).

Install C/C++ tools: Ubuntu (`sudo apt-get install -y python3 make g++ build-essential`), macOS (`xcode-select --install`), Windows (`npm install --global windows-build-tools`).

### Option A — Docker (Recommended)

```bash
git clone https://github.com/GoetzKohlberg/sidjua.git
cd sidjua
docker compose up -d
```

```bash
# Complete first-time setup
# Open http://127.0.0.1:47821 in your browser and set your admin password.

# Bootstrap governance
docker compose exec sidjua sidjua apply --verbose

# System health check
docker compose exec sidjua sidjua selftest
```

Supports **linux/amd64** and **linux/arm64** (Raspberry Pi, Apple Silicon).

### Option B — npm Global Install

```bash
npm install -g sidjua
sidjua init          # Interactive 3-step setup
sidjua chat guide    # Zero-config AI guide (no API key needed)
```

### Option C — Source Build

```bash
git clone https://github.com/GoetzKohlberg/sidjua.git
cd sidjua
npm ci && npm run build
node dist/index.js --help
```

### Platform Notes

| Feature | Linux | macOS | Windows (WSL2) | Windows (native) |
|---------|-------|-------|----------------|------------------|
| CLI + REST API | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| Docker | ✅ Full | ✅ Full (Desktop) | ✅ Full (Desktop) | ✅ Full (Desktop) |
| Sandboxing (bubblewrap) | ✅ Full | ❌ Falls back to `none` | ✅ Full (inside WSL2) | ❌ Falls back to `none` |
| Web Management Console | ✅ Full | ✅ Full | ✅ Full | ✅ Full |

No external database required. SIDJUA uses SQLite. Qdrant is optional (semantic search only).

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the complete guide with directory layout, environment variables, per-OS troubleshooting, and Docker volume reference. For Docker-specific issues on Windows/WSL2, Ubuntu, and macOS see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Why SIDJUA?

Every AI agent framework today relies on the same broken assumption: that you
can trust the AI to follow its own rules.

**The problem with prompt-based governance:**

You give an agent a system prompt that says "never access customer PII." The
agent reads the instruction. The agent also reads the user's message asking it
to pull John Smith's payment history. The agent decides — on its own — whether
to comply. That's not governance. That's a strongly worded suggestion.

**SIDJUA is different.**

Governance sits **outside** the agent. Every action goes through a 5-step
pre-action enforcement pipeline **before** it executes. You define rules in
YAML. The system enforces them. The agent never gets to decide whether to
follow them, because the check happens before the agent acts.

This is governance by architecture — not by prompting, not by fine-tuning,
not by hoping.

---

## How It Works

SIDJUA wraps your agents in an external governance layer. The agent's LLM
call never happens until the proposed action clears a 5-stage enforcement
pipeline:

**Stage 1 — Forbidden:** Blocked actions are rejected immediately. No LLM
call, no log entry marked "allowed", no second chances. If the action is on
the forbidden list, it stops here.

**Stage 2 — Approval:** Actions that require human sign-off are held for
approval before execution. The agent waits. The human decides.

**Stage 3 — Budget:** Every task runs against real-time cost limits. Per-task
and per-agent budgets are enforced. When the limit is reached, the task is
cancelled — not flagged, not logged for review, *cancelled*.

**Stage 4 — Classification:** Data crossing division boundaries is checked
against classification rules. A Tier-2 agent cannot access SECRET data. An
agent in Division A cannot read Division B's secrets.

**Stage 5 — Policy:** Custom organizational rules, enforced structurally. API
call frequency limits, output token caps, time-window restrictions.

The entire pipeline runs before any action executes. There is no "log and
review later" mode for governance-critical operations.

### Single Configuration File

Your entire agent organization lives in one `divisions.yaml`:

```yaml
divisions:
  - name: engineering
    agents:
      - name: research-agent
        provider: anthropic
        model: claude-haiku-4-5-20251001
        tier: 2
        budget:
          per_task_usd: 0.50
          per_month_usd: 50.00
    governance:
      rules:
        - no_external_api_calls: true
        - max_tokens_per_response: 4096
        - require_human_approval: [delete, send_email]
```

`sidjua apply` reads this file and provisions the complete agent infrastructure:
agents, divisions, RBAC, routing, audit tables, secrets paths, and governance
rules — in 10 reproducible steps.

### Agent Architecture

Agents are organized into **divisions** (functional groups) and **tiers**
(trust levels). Tier 1 agents have full autonomy within their governance
envelope. Tier 2 agents require approval for sensitive operations. Tier 3
agents are fully supervised. The tier system is enforced structurally — an
agent cannot self-promote.

```
┌─────────────────────────────────────────────────┐
│                 SIDJUA Platform                 │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │           Governance Layer              │   │
│  │  Forbidden → Approval → Budget →        │   │
│  │  Classification → Policy (Stage 0)      │   │
│  └────────────────────┬────────────────────┘   │
│                       │ ✅ cleared              │
│            ┌──────────▼──────────┐             │
│            │   Agent Runtime     │             │
│            │  (any LLM provider) │             │
│            └──────────┬──────────┘             │
│                       │                        │
│  ┌────────────────────▼────────────────────┐   │
│  │            Audit Trail                  │   │
│  │  (WAL-integrity-verified, append-only)  │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Architecture Constraints

SIDJUA enforces these constraints at the architecture level — agents cannot
disable, bypass, or override governance — it executes outside their runtime,
before their actions:

1. **Governance is external**: The governance layer wraps the agent. The agent
   has no access to governance code, cannot modify rules, and cannot detect
   whether governance is present.

2. **Pre-action, not post-action**: Every action is checked BEFORE execution.
   There is no "log and review later" mode for governance-critical operations.

3. **Structural enforcement**: Rules are enforced by code paths, not by
   prompts or model instructions. An agent cannot "jailbreak" out of
   governance because governance isn't implemented as instructions to the model.

4. **Audit integrity**: The Write-Ahead Log (WAL) is integrity-verified.
   Tampered entries are detected via SHA-256 integrity checks.

5. **Division isolation**: Agents in different divisions cannot access each
   other's data, secrets, or communication channels.

---

## Comparison

| Feature | SIDJUA | CrewAI | AutoGen | LangGraph | OpenClaw |
|---------|--------|--------|---------|-----------|----------|
| External Governance | ✅ Architecture | ❌ | ❌ | ❌ | ❌ |
| Pre-Action Enforcement | ✅ 5-Step Pipeline | ❌ | ❌ | ❌ | ❌ |
| EU AI Act Ready | ✅ | ❌ | ❌ | ❌ | ❌ |
| Self-Hosted | ✅ | ❌ Cloud | ❌ Cloud | ❌ Cloud | ✅ Plugin |
| Air-Gap Capable | ✅ | ❌ | ❌ | ❌ | ❌ |
| Model Agnostic | ✅ Any LLM | Partial | Partial | Partial | ✅ |
| Bidirectional Email | ✅ | ❌ | ❌ | ❌ | ❌ |
| Discord Gateway | ✅ | ❌ | ❌ | ❌ | ❌ |
| Hierarchical Agents | ✅ Divisions + Tiers | Basic | Basic | Graph | ❌ |
| Budget Enforcement | ✅ Per-Agent Limits (fail-closed) | ❌ | ❌ | ❌ | ❌ |
| Sandbox Isolation | ✅ bubblewrap (Linux) | ❌ | ❌ | ❌ | ❌ |
| Audit Integrity | ✅ WAL + tamper-evident | ❌ | ❌ | ❌ | ❌ |
| License | AGPL-3.0 | MIT | MIT | MIT | Mixed |
| Code Audits | ✅ 3 AI Auditors | ❌ | ❌ | ❌ | ❌ |
| Always-On Daemons | ✅ Governed | ❌ | ❌ | ❌ | ❌ Heartbeat only |
| Mutual Watchdog | ✅ 4-Eyes | ❌ | ❌ | ❌ | ❌ |
| Governed Cron | ✅ Budget-limited | ❌ | ❌ | ❌ | ❌ Ungoverned |
| Multi-Channel Messaging | ✅ 6+ channels | ❌ | ❌ | ❌ | Chat only |

---

## Features

### Governance & Compliance

**Pre-Action Pipeline (Stage 0)** runs before every agent action: Forbidden
check → Human Approval → Budget tracking → Data Classification → Custom
Policy. All five stages are structural — they execute in code, not in the
agent's prompt.

**Mandatory Baseline Rules** ship with every installation: 10 governance rules
(`SYS-SEC-001` through `SYS-GOV-002`) that cannot be removed or weakened by
user configuration. Custom rules extend the baseline; they cannot override it.

**EU AI Act Compliance** — audit trail, classification framework, and approval
workflows map directly to Article 9, 12, and 17 requirements. The August 2026
compliance deadline is built into the product roadmap.

**Compliance Reporting** via `sidjua audit report/violations/agents/export`:
compliance score, per-agent trust scores, violation history, CSV/JSON export
for external auditors or SIEM integration.

**Write-Ahead Log (WAL)** with integrity verification: every governance
decision is written to an integrity-verified log before execution. Tampered
entries are detected via SHA-256 integrity checks on read. `sidjua memory
recover` re-validates and repairs.

### Communication — Multi-Channel

Agents don't just respond to API calls — they participate in real communication
channels. Every inbound message becomes a governed task. Every outbound message
is logged in the audit trail.

| Channel | Status | Features |
|---------|--------|----------|
| **Discord** | ✅ Full | Gateway daemon, threads, slash commands |
| **Email** | ✅ Full | IMAP IDLE inbound, SMTP outbound, thread mapping |
| **Telegram** | ✅ Full | Bot API, long-polling, text + files + images |
| **CLI** | ✅ Full | `sidjua chat`, `sidjua run` |
| **REST API** | ✅ Full | POST /api/v1/messages — any external system |
| **WebSocket** | ✅ Full | Real-time for GUI/PWA and custom clients |
| **Slack** | ⚠️ Beta | Socket Mode adapter |
| **WhatsApp** | ⚠️ Beta | Self-hosted via baileys adapter |

**Slash commands** from any platform: `/status`, `/agents`, `/tasks`, `/costs`,
`/budget`, `/pause`, `/resume`, `/cancel`, `/schedule`, `/help`, `/divisions`.
Role-based access: viewer (read-only), user (submit tasks), admin (full control).

**Message-to-Task Bridge** — user messages go directly to the agent. Governance
rules are the only firewall. No NLP gatekeeping, no interpretation layer.

**Audited User Override** — when governance blocks a task, users can explicitly
override with a time-limited approval window. Every override is logged with user
ID, timestamp, and original block reason. Critical policies are non-overrideable.

### Autonomous Runtime

Agents run as persistent background daemons — not session-bound, not reactive.

**Always-On Daemons** — `sidjua start` becomes a persistent service
(systemd/Docker). Agents find work without explicit triggers. Configurable
modes: always-on, on-demand, cron-triggered. Daemon-level budget governance:
max cost/hour and max tasks/hour hard limits. Circuit breaker pauses the agent
after repeated failures and alerts the human. Graceful idle scaling reduces
polling when no work is available. Daemon infrastructure provides persistent
agent processes; proactive task detection and advanced watchdog features are
being hardened for V1.1.

**4-Eyes Mutual Watchdog** — two system agents (IT-Admin + Guide) cross-monitor
ALL agents and each other. If one watchdog misses heartbeats, the other detects
and restarts. If one crashes, the other restarts it. If both crash, systemd
failsafe triggers full restart. Exponential backoff prevents restart loops.
Circuit breaker stops restarts after max crashes and alerts via
Telegram/Discord/Email. No single point of failure.

**Governed Cron Scheduler** — recurring tasks via standard cron expressions.
Per-schedule governance: max cost per run, max runs per day, approval workflows.
DeadlineWatcher: deadline monitoring with configurable warning thresholds.
CLI: `sidjua schedule list/create/enable/disable/delete/show/history`.
REST API: full CRUD at `/api/v1/schedules`. Scheduled cost caps are tracked with fail-closed enforcement.

### Operations

**Single Docker command** to production:

```bash
docker run -d \
  --name sidjua \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  -p 47821:47821 \
  -v sidjua-data:/data \
  ghcr.io/goetzkohlberg/sidjua:latest
```

On first start, open http://127.0.0.1:47821 in your browser. SIDJUA will prompt you to
set an admin password. That password is the only credential you need to access the
dashboard.

No environment variables required. No configuration required. No database
server required — SIDJUA uses SQLite, one database file per agent.

#### Supported Platforms

SIDJUA provides native Docker images for:
- **Intel/AMD** (x86_64) — Linux servers, Windows WSL2, Intel Macs
- **ARM64** (aarch64) — Apple Silicon Macs, AWS Graviton, Raspberry Pi 4+

Use the installer script to automatically detect and load the correct image:
```bash
bash scripts/install-docker.sh 1.0.1
```

#### Error Logging & Privacy

Error telemetry is **disabled by default** (privacy-first). When enabled, only sanitized error types and stack hashes are transmitted — no user data, no API keys, no agent content.

- API keys and secrets are **automatically redacted** and never stored in full
- All logs are stored **locally only** at `/data/logs/sidjua-error.log`
- No data is sent externally without your explicit opt-in
- Enable with: `sidjua config set telemetry.mode basic`
- User-configurable in Settings UI

To share logs for support: `docker cp $(docker ps -aq -f name=sidjua):/data/logs/sidjua-error.log .`

**CLI Management** — complete lifecycle from a single binary:

```bash
sidjua init                      # Interactive workspace setup (3 steps)
sidjua apply                     # Provision from divisions.yaml
sidjua agent create/list/stop    # Agent lifecycle
sidjua run "task..." --wait      # Submit task with governance enforcement
sidjua audit report              # Compliance report
sidjua costs                     # Cost breakdown by division/agent
sidjua backup create/restore     # HMAC-signed backup management
sidjua update                    # Version update with automatic pre-backup
sidjua rollback                  # 1-click restore to previous version
sidjua email status/test         # Email channel management
sidjua secret set/get/rotate     # Encrypted secrets management
sidjua memory import/search      # Semantic knowledge pipeline
sidjua selftest                  # System health check (7 categories, 0-100 score)
```

**Semantic Memory** — import conversations and documents (`sidjua memory import
~/exports/claude-chats.zip`), search with vector + BM25 hybrid ranking. Supports
Cloudflare Workers AI embeddings (free, zero-config) and OpenAI large embeddings
(higher quality for large knowledge bases).

**Adaptive Chunking** — memory pipeline auto-adjusts chunk sizes to stay within
each embedding model's token limit.

**Zero-Config Guide** — `sidjua chat guide` launches an interactive AI assistant
without any API key, powered by Cloudflare Workers AI through the SIDJUA proxy.
Ask it how to set up agents, configure governance, or understand what happened
in the audit log.

**Air-Gap Deployment** — run fully disconnected from the internet using local
LLMs via Ollama or any OpenAI-compatible endpoint. No telemetry by default.
Optional opt-in crash reporting with full PII redaction.

### Security

**Sandbox Isolation** — agent skills run inside OS-level process isolation via
bubblewrap (Linux user namespaces). Zero additional RAM overhead. Pluggable
`SandboxProvider` interface: `none` for development, `bubblewrap` for production.

**Secrets Management** — encrypted secrets store with RBAC (`sidjua secret
set/get/list/delete/rotate/namespaces`). No external vault required.

**Security-First Build** — extensive internal testing plus independent validation by 4 external code auditors (DeepSeek V3, xAI Grok, GPT-5.4, Gemini). 10+ audit rounds completed, all findings resolved. Security
headers, CSRF protection, rate limiting, and input sanitization on every API
surface. SQL injection prevention with parameterized queries throughout.

**Rate Limiting** — in-memory token-bucket rate limiting is enforced per IP address.
Rate limit counters are not shared between processes: running multiple server instances
against the same database results in independent, non-shared rate limit counters.
SIDJUA Community Edition is designed for single-process operation. Do not run multiple
instances simultaneously unless you handle rate limiting externally (e.g. via a reverse proxy).

**Backup Integrity** — HMAC-signed backup archives with zip-slip protection,
zip bomb prevention, and manifest checksum verification on restore.

---

## Import from Other Frameworks

```bash
# Preview what gets imported — no changes made
sidjua import openclaw --dry-run

# Import config + skill files
sidjua import openclaw --skills
```

Your existing agents keep their identity, models, and skills. SIDJUA adds
governance, audit trails, and budget controls automatically.

---

### Your Data Is Protected

SIDJUA automatically protects your work — you don't have to think about it.

| What happens | What SIDJUA does | Data loss |
|---|---|---|
| You run `sidjua shutdown` | Drains running tasks, writes checkpoints, stops cleanly | **None** |
| Normal Mac/PC/Linux shutdown | SIDJUA catches the OS shutdown signal and saves automatically | **None** |
| Hard crash, power failure, or force-quit | Chat history and rate limiter state are checkpointed every 60 seconds; SQLite WAL provides additional durability | **At most 1 minute for chat/rate-limiter; in-flight execution state is not checkpointed** |

**How it works:**

SIDJUA silently checkpoints chat history and rate limiter state every 60 seconds — invisible, zero performance impact. SQLite WAL mode provides additional durability for all database writes. Note: in-flight agent execution context and daemon state are not included in periodic checkpoints.

When your Mac or PC shuts down normally (menu → Shut Down, or closing the lid with shutdown configured), the operating system sends a termination signal. SIDJUA catches this signal and performs a full graceful shutdown automatically — exactly as if you had run `sidjua shutdown` yourself.

The only scenario where you lose persisted state is a hard crash: pulling the power cord, a kernel panic, or holding the power button. Even then, chat history is at most 60 seconds behind the latest checkpoint. On restart, SIDJUA automatically recovers — interrupted tasks are flagged, budgets are cleaned up, and your chat history is restored.

**Best practice:** Run `sidjua shutdown` when you're done for the day. But if you forget — SIDJUA has your back.

**For server deployments:** Configure `runtime.mode: server` in your `divisions.yaml` or let SIDJUA auto-detect (systemd/Docker are recognized automatically). Checkpoint interval extends to 5 minutes since servers always receive SIGTERM on shutdown.

---

## Configuration Reference

A minimal `divisions.yaml` to get started:

```yaml
organization:
  name: "my-org"
  tier: 1

divisions:
  - name: operations
    tier: 2
    agents:
      - name: ops-agent
        provider: anthropic
        model: claude-haiku-4-5-20251001
        division: operations
        budget:
          per_task_usd: 0.25
          per_month_usd: 25.00

governance:
  stage0:
    enabled: true
    forbidden_actions:
      - delete_database
      - exfiltrate_data
    classification:
      default_level: INTERNAL
      max_agent_level: CONFIDENTIAL
```

`sidjua apply` provisions the complete infrastructure from this file. Run it
again after changes — it's idempotent.

See [docs/SIDJUA-APPLY-TECH-SPEC-V1.md](docs/SIDJUA-APPLY-TECH-SPEC-V1.md)
for the full specification of all 10 provisioning steps.

---

## REST API

The SIDJUA REST API runs on the same port as the dashboard:

```bash
sidjua server start --port 47821 --api-key $SIDJUA_API_KEY
```

Key endpoints:

```
GET  /api/v1/health          # Public health check (no auth)
GET  /api/v1/info            # System metadata (authenticated)
POST /api/v1/execute/run     # Submit a task
GET  /api/v1/execute/:id/status  # Task status
GET  /api/v1/execute/:id/result  # Task result
GET  /api/v1/events          # SSE event stream
GET  /api/v1/audit/report    # Compliance report
```

All API endpoints require Bearer authentication, except:
- `GET /api/v1/health` — health check
- `GET /api/v1/locale/*` — locale strings
- `GET /api/v1/starter-agents` / `GET /api/v1/starter-agents/:id` — read-only starter agent catalog
- `GET /api/v1/starter-divisions` / `GET /api/v1/starter-divisions/:id` — read-only starter division catalog
- Static GUI assets and SPA routes

Generate a key:

```bash
sidjua api-key generate
```

---

## Docker Compose

```yaml
services:
  sidjua:
    image: ghcr.io/goetzkohlberg/sidjua:latest
    ports:
      - "47821:47821"
    volumes:
      - sidjua-data:/data
    restart: unless-stopped

volumes:
  sidjua-data:
```

Or use the included `docker-compose.yml` which adds named volumes for config,
logs, and agent workspace, plus an optional Qdrant service for semantic search:

```bash
docker compose up -d
docker compose exec sidjua sidjua init
docker compose exec sidjua sidjua apply
```

### Production Deployment with TLS

Port 47821 serves the REST API and Management Console over HTTP.
For production deployments, place a reverse proxy in front of SIDJUA
to handle TLS termination:

**Caddy (recommended — automatic HTTPS):**

```
sidjua.example.com {
    reverse_proxy localhost:47821
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name sidjua.example.com;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:47821;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **Never expose port 47821 directly to the internet without TLS.**
> Set the environment variable `SIDJUA_TRUST_PROXY=true` when running
> behind a reverse proxy so that client IP detection works correctly.

---

## Providers

SIDJUA connects to any LLM provider without lock-in:

| Provider | Models | API Key |
|----------|--------|---------|
| Anthropic | Claude Sonnet 4.6, Haiku 4.5, Opus 4.6 | `ANTHROPIC_API_KEY` |
| OpenAI | GPT-4o, GPT-4o-mini, o1 | `OPENAI_API_KEY` |
| Google | Gemini 2.0, Gemini 1.5 Pro | `GOOGLE_API_KEY` |
| Groq | Llama 3.x, Kimi K2, GPT-OSS | `GROQ_API_KEY` (free tier) |
| Cloudflare Workers AI | Llama, Mistral, Phi | `CF_ACCOUNT_ID` + `CF_TOKEN` |
| Ollama | Any local model | No key (local) |
| OpenAI-compatible | Any endpoint | Custom URL + key |

```bash
# Add a provider key
sidjua key set groq gsk_...

# List available providers and models
sidjua provider list
```

---

## Roadmap

Full roadmap at [sidjua.com/files/roadmap.html](https://sidjua.com/files/roadmap.html).

### Shipped

**V1.0 (March 2026)** — 5-stage governance engine, autonomous agent runtime with
daemon infrastructure, multi-channel messaging (Discord, Email, Telegram, Slack,
WhatsApp, CLI, REST, WebSocket), Management Console, semantic memory pipeline,
bubblewrap sandboxing, dual licensing (AGPL-3.0 + Commercial). Available in 44 languages.

**V1.0.1 (March 31, 2026)** — Scoped API tokens with RBAC
(admin/operator/agent/readonly), SQLite-backed rate limiter persistence, audit event
pipeline, resolved model display, unified agent status, advanced provider mode, per-agent
LLM selection, division sync.

### In Development

**V1.1** — Zero-downtime in-app self-update via Blue/Green deployment with Go sidecar
proxy. Database migration system with automatic pre-migration backup. SQLite safety
hardening (WAL enforcement, PRAGMA checks, busy_timeout). GUI cleanup, code quality
audit, YAML validation pipeline. Users update from the browser — no terminal required.
CLI SSE migration for real-time log tailing. MCP Client (STDIO + SSE transport) with
6-stage governance hooks. Tool calling in the orchestrator with budget tracking. Module
SDK (init/list/add/remove/test). LLM streaming with SSE events. Webhook inbound
triggers. Prometheus metrics with Grafana dashboard. OpenClaw import for migration from
competing frameworks. Agent definition templates (CEO-Assistant, HR-Manager, IT-Manager)
with skill system. PDF report generator. Auto-generated architecture documentation
(Mermaid, C4, dependency graphs). Developer documentation and LLM context document for
agent self-knowledge. Agent runtime hardening (dead worker recovery, backpressure, queue
metrics). Runtime benchmark suite. Governed memory consolidation with feature flags.
REST tool factory with dual strategy (MCP + REST fallback for unattended agents).
Contributor documentation (CONTRIBUTING.md, Contributor Ladder, Discord roles).

### Planned

**V1.2** — Stable versioned REST API, advanced agent-to-agent communication protocol,
security penetration test.

### Architecture Vision

**V2.0** — SIDJUA splits into two independent packages:

- **sidjua-core** — The governance engine, agent orchestrator, and REST API as a
  standalone headless runtime. Rewritten in Rust for native performance, zero-GC
  latency, and cross-compilation to macOS, Windows, and Linux from a single codebase.
  Node.js bindings (napi-rs) maintain backward compatibility during transition.
  Communication via local REST API, Unix socket (Linux/Mac), and Named Pipe (Windows).

- **sidjua-gui** — A native desktop application built with Tauri (Rust + WebView).
  Communicates with sidjua-core exclusively via the versioned REST/IPC interface — never
  imports core internals. Ships as `.app` (macOS), `.exe` (Windows), `.deb`/`.AppImage`
  (Linux). The interface contract is defined by an OpenAPI spec, enabling third-party
  GUIs, web interfaces, and mobile apps.

This split means the GUI team and core team never block each other. CLI-only and
headless server deployments remain first-class citizens.

**V2.0 Enterprise** — SSO/LDAP/SAML, high availability, MOODEX (patented affective
state system), compliance packs (EU AI Act, SOC 2), tamper-evident audit export,
PostgreSQL adapter. Agent Desktop Control Layer enabling governed agents to operate
native desktop applications via platform accessibility APIs (macOS Accessibility,
Windows UI Automation, Linux AT-SPI2) — with full governance pre-approval, audit
trailing, and application-level sandboxing.

---

## Community

- **Discord**: [sidjua.com/discord](https://sidjua.com/discord)
- **GitHub Issues**: [github.com/GoetzKohlberg/sidjua/issues](https://github.com/GoetzKohlberg/sidjua/issues)
- **Email**: contact@sidjua.com
- **Docs**: [sidjua.com/docs](https://sidjua.com/docs)
- **Troubleshooting**: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

If you find a bug, open an issue — we move fast.

---

## Translations

SIDJUA is available in 44 languages. English and German are maintained by the core team. All other translations are AI-generated and community-maintained.

**Documentation:** This README and the [Installation Guide](docs/INSTALLATION.md) are available in all 44 languages. See the language selector at the top of this page.

| Region | Languages |
|--------|-----------|
| Americas | English, Spanish, Portuguese (Brazil) |
| Europe | German, French, Italian, Dutch, Polish, Czech, Romanian, Russian, Ukrainian, Swedish, Turkish |
| Middle East | Arabic |
| Asia | Hindi, Bengali, Filipino, Indonesian, Malay, Thai, Vietnamese, Japanese, Korean, Chinese (Simplified), Chinese (Traditional) |

Found a translation error? Please open a GitHub Issue with:
- Language and locale code (e.g. `fil`)
- The incorrect text or the key from the locale file (e.g. `gui.nav.dashboard`)
- The correct translation

### i18n workflow — mandatory

SIDJUA has 44 production locales. Every key in `src/locales/en.json` must have
a real translation in every other production locale. There are no stubs,
no whitelists, no soft locales.

When you add a new user-facing string:

1. Add the key to `src/locales/en.json`. Use a natural English source string
   with `{placeholder}` tokens for interpolation.
2. Use `t('your.key')` in the component or backend response.
3. Run `npm run i18n:translate` — propagates the key to every other locale
   via xAI grok-4-1-fast (one call per locale, 2M context). Preserves
   existing translations for unrelated keys. A full sweep takes 3-8 minutes;
   incremental `--only-new` takes seconds. Cost is negligible (under
   $0.01 for a handful of new keys at xAI pricing).
4. Review the diff. Commit `src/locales/` changes in the same commit as the
   `en.json` change. One commit, all locales.

Requirements:
- API keys live in `$HOME/.sidjua-env` on the dev host — populated once during PM1.
  Default provider: `xai` (grok-4-1-fast, 2M context, one call per locale). Override
  via `I18N_TRANSLATE_PROVIDER=deepseek` if xAI is down or a specific locale
  produces gibberish.
- CI enforces this: `scripts/check-i18n-completeness.ts` fails the build if
  `en.json` has keys that any production locale is missing or stubbing.
- Never hand-edit a non-English locale file. The translate script is the
  only path that writes to those files.

Want to maintain a language? See [CONTRIBUTING.md](CONTRIBUTING.md#translations) — we use a per-language maintainer model.

---

## License

SIDJUA Free is dual-licensed:

- **AGPL-3.0** — Free for self-hosting, open-source projects, and personal use.
  You may use, modify, and redistribute under AGPL-3.0 terms.
  See [LICENSE-AGPL](LICENSE-AGPL).

- **Commercial License** — Required for hosting providers and SaaS operators
  who offer SIDJUA to third-party customers.
  Contact: license@sidjua.com

- **Enterprise License** — For organizations running 100+ agents, with SLA,
  compliance support, and priority features.
  Contact: enterprise@sidjua.com

Self-hosting SIDJUA Free on your own server with your own API keys is and will
always be free under the AGPL-3.0.
