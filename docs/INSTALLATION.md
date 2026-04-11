# SIDJUA Free — Installation Guide

SIDJUA Free version: 1.0.0 | License: AGPL-3.0-only | Updated: 2026-03-25

## Table of Contents

1. [Platform Support Matrix](#1-platform-support-matrix)
2. [Prerequisites](#2-prerequisites)
3. [Installation Methods](#3-installation-methods)
4. [Directory Layout](#4-directory-layout)
5. [Environment Variables](#5-environment-variables)
6. [Provider Configuration](#6-provider-configuration)
7. [Web Management Console (Optional)](#7-web-management-console-optional)
8. [Agent Sandboxing](#8-agent-sandboxing)
9. [Semantic Search (Optional)](#9-semantic-search-optional)
10. [Troubleshooting](#10-troubleshooting)
11. [Docker Volume Reference](#11-docker-volume-reference)
12. [Upgrading](#12-upgrading)
13. [Next Steps](#13-next-steps)

---

## 1. Platform Support Matrix

| Feature | Linux | macOS | Windows WSL2 | Windows (native) |
|---------|-------|-------|--------------|------------------|
| CLI + REST API | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| Docker | ✅ Full | ✅ Docker Desktop | ✅ Docker Desktop | ✅ Docker Desktop |
| Sandboxing (bubblewrap) | ✅ Full | ❌ Falls back to `none` | ✅ Full (inside WSL2) | ❌ Falls back to `none` |
| Web Management Console | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| Semantic Search (Qdrant) | ✅ | ✅ | ✅ | ✅ |

**Note about bubblewrap:** Linux user-namespace sandboxing. macOS and Windows native fall back to sandbox mode `none` automatically — no configuration needed.

---

## 2. Prerequisites

### Node.js >= 22.0.0

**Why:** SIDJUA uses ES modules, native `fetch()`, and `crypto.subtle` — all require Node.js 22+.

**Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Fedora / RHEL / CentOS:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
```

**Arch Linux:**
```bash
sudo pacman -S nodejs npm
```

**macOS (Homebrew):**
```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**macOS (.pkg installer):** Download from [nodejs.org/en/download](https://nodejs.org/en/download).

**Windows (winget):**
```powershell
winget install OpenJS.NodeJS.LTS
```

**Windows (.msi):** Download from [nodejs.org/en/download](https://nodejs.org/en/download).

**WSL2:** Use the Ubuntu/Debian instructions above inside your WSL2 terminal.

Verify:
```bash
node --version   # must be >= 22.0.0
npm --version    # must be >= 10.0.0
```

---

### C/C++ Toolchain (source builds only)

**Why:** `better-sqlite3` and `argon2` compile native Node.js addons during `npm ci`. Docker users skip this.

**Ubuntu / Debian:**
```bash
sudo apt-get install -y python3 make g++ build-essential linux-headers-$(uname -r)
```

**Fedora / RHEL:**
```bash
sudo dnf groupinstall "Development Tools"
sudo dnf install python3
```

**Arch Linux:**
```bash
sudo pacman -S base-devel python
```

**macOS:**
```bash
xcode-select --install
```

**Windows:** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload, then:
```powershell
npm install --global windows-build-tools
```

**Alpine Linux:**
```bash
apk add python3 make g++ build-base linux-headers
```

---

### Docker >= 24 (optional)

Required only for the Docker installation method. The Docker Compose V2 plugin (`docker compose`) must be available.

**Linux:** Follow instructions at [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
Docker Compose V2 is included with Docker Engine >= 24.

**macOS / Windows:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose V2).

Verify:
```bash
docker --version          # must be >= 24.0.0
docker compose version    # must show v2.x.x
```

---

### Git

Any recent version. Install via your OS package manager or [git-scm.com](https://git-scm.com).

---

## 3. Installation Methods

### Method A — Docker (Recommended)

The fastest path to a working SIDJUA installation. All dependencies are bundled in the image.

```bash
git clone https://github.com/GoetzKohlberg/sidjua.git
cd sidjua
docker compose up -d
```

Wait for services to become healthy (up to ~60 seconds on first build):

```bash
docker compose ps
# NAME              STATUS
# sidjua            Up X seconds (healthy)
# sidjua-qdrant     Up X seconds (healthy)
```

Complete first-time setup in your browser at http://127.0.0.1:47821 — you will be
prompted to set an admin password.

Bootstrap governance from your `divisions.yaml`:

```bash
docker compose exec sidjua sidjua apply --verbose
```

Run the system health check:

```bash
docker compose exec sidjua sidjua selftest
```

**ARM64 note:** The Docker image is built on `node:22-alpine` which supports `linux/amd64` and `linux/arm64`. Raspberry Pi (64-bit) and Apple Silicon Macs (via Docker Desktop) are supported out of the box.

**Bubblewrap in Docker:** To enable agent sandboxing inside the container, add `--cap-add=SYS_ADMIN` to your Docker run command or set it in `docker-compose.yml`:
```yaml
cap_add:
  - SYS_ADMIN
```

---

### Method B — npm Global Install

```bash
npm install -g sidjua
```

Run the interactive setup wizard (3 steps: workspace location, provider, first agent):
```bash
sidjua init
```

For non-interactive CI or container environments:
```bash
sidjua init --yes
```

Start the zero-config AI guide (no API key required):
```bash
sidjua chat guide
```

---

### Method C — Source Build

```bash
git clone https://github.com/GoetzKohlberg/sidjua.git
cd sidjua
npm ci
npm run build
```

The build process uses `tsup` to compile `src/index.ts` into:
- `dist/index.js` (ESM)
- `dist/index.cjs` (CommonJS)

Post-build steps copy i18n locale files, default roles, divisions, and knowledge base templates into `dist/`.

Run from source:
```bash
node dist/index.js --help
```

Run the test suite:
```bash
npm test                    # all tests
npm run test:coverage       # with coverage report
npx tsc --noEmit            # type check only
```

---

## 4. Directory Layout

### Docker Deployment Paths

| Path | Docker Volume | Purpose | Managed By |
|------|---------------|---------|------------|
| `/app/dist/` | Image layer | Compiled application | SIDJUA |
| `/app/node_modules/` | Image layer | Node.js dependencies | SIDJUA |
| `/app/system/` | Image layer | Built-in defaults and templates | SIDJUA |
| `/app/defaults/` | Image layer | Default config files | SIDJUA |
| `/app/docs/` | Image layer | Bundled documentation | SIDJUA |
| `/app/data/` | `sidjua-data` | SQLite databases, backups, knowledge collections | User |
| `/app/config/` | `sidjua-config` | `divisions.yaml` and custom config | User |
| `/app/logs/` | `sidjua-logs` | Structured log files | User |
| `/app/.system/` | `sidjua-system` | API key, update state, process lock | SIDJUA managed |
| `/app/agents/` | `sidjua-workspace` | Agent definitions, skills, templates | User |
| `/app/governance/` | `sidjua-governance` | Audit trail, governance snapshots | User |

---

### Manual / npm Install Paths

After `sidjua init`, your workspace is organized as:

```
~/sidjua-workspace/           # or SIDJUA_CONFIG_DIR
├── divisions.yaml            # Your governance configuration
├── .sidjua/                  # Internal state (WAL, telemetry buffer)
│   └── telemetry.db
├── data/
│   ├── sidjua.db             # Main database (agents, tasks, audit, costs)
│   ├── knowledge/            # Per-agent knowledge databases
│   │   └── <agent-id>.db
│   └── backups/              # HMAC-signed backup archives
├── agents/                   # Agent skill directories
├── governance/               # Audit trail (append-only)
├── logs/                     # Application logs
└── system/                   # Runtime state
```

---

### SQLite Databases

| Database | Path | Contents |
|----------|------|----------|
| Main | `data/sidjua.db` | Agents, tasks, costs, governance snapshots, API keys, audit log |
| Telemetry | `.sidjua/telemetry.db` | Optional opt-in error reports (PII-redacted) |
| Knowledge | `data/knowledge/<agent-id>.db` | Per-agent vector embeddings and BM25 index |

SQLite databases are single-file, cross-platform, and portable. Back them up with `sidjua backup create`.

---

## 5. Environment Variables

Copy `.env.example` to `.env` and customize. All variables are optional unless noted.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDJUA_PORT` | `3000` | REST API listen port |
| `SIDJUA_HOST` | `127.0.0.1` | REST API bind address. Use `0.0.0.0` for remote access |
| `NODE_ENV` | `production` | Runtime mode (`production` or `development`) |
| `SIDJUA_API_KEY` | Auto-generated | REST API bearer token. Auto-created on first start if absent |
| `SIDJUA_MAX_BODY_SIZE` | `2097152` (2 MiB) | Maximum inbound request body size in bytes |

### Directory Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDJUA_DATA_DIR` | `<workspace>/data` | Override data directory location |
| `SIDJUA_CONFIG_DIR` | `<workspace>` | Override config directory location |
| `SIDJUA_LOG_DIR` | `<workspace>/logs` | Override log directory location |

### Semantic Search

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDJUA_QDRANT_URL` | `http://localhost:6333` | Qdrant vector database endpoint. Docker default: `http://qdrant:6333` |
| `OPENAI_API_KEY` | — | Required for OpenAI `text-embedding-3-large` embeddings |
| `SIDJUA_CF_ACCOUNT_ID` | — | Cloudflare account ID for free embeddings |
| `SIDJUA_CF_TOKEN` | — | Cloudflare API token for free embeddings |

### LLM Providers

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT-4, embeddings) |
| `GOOGLE_AI_API_KEY` | Google AI (Gemini) |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI (free tier) |
| `GROQ_API_KEY` | Groq (fast inference, free tier available) |
| `DEEPSEEK_API_KEY` | DeepSeek |

---

## 6. Provider Configuration

### Zero-Config Option

`sidjua chat guide` works without any API key. It connects to Cloudflare Workers AI through the SIDJUA proxy. Rate-limited but suitable for evaluation and onboarding.

### Adding Your First Provider

**Groq (free tier, no credit card required):**
```bash
sidjua key set groq <your-groq-api-key>
sidjua provider list
```
Get a free key at [console.groq.com](https://console.groq.com).

**Anthropic (recommended for production):**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
sidjua key set anthropic $ANTHROPIC_API_KEY
```

**Ollama (air-gap / local deployment):**
```bash
sidjua provider add-custom \
  --id ollama \
  --name "Ollama (local)" \
  --base-url http://localhost:11434/v1 \
  --model llama3.2
```

Validate all configured providers:
```bash
sidjua setup --validate
```

---

## 7. Web Management Console (Optional)

The SIDJUA Web Management Console is a React/TypeScript application served via the Hono REST API. It is optional — the CLI and REST API work without it.

No additional installation steps are required. The web console is served automatically when the SIDJUA API server is running.

### Accessing the Console

Once the API server is started, open a browser at:

```
http://localhost:PORT
```

Where `PORT` is the API server port (default: `4000`). The console requires authentication using your API key or a scoped token.

---

## 8. Agent Sandboxing

SIDJUA uses a pluggable `SandboxProvider` interface. The sandbox wraps agent skill execution in OS-level process isolation.

### Sandbox Support by Platform

| Platform | Sandbox Provider | Notes |
|----------|-----------------|-------|
| Linux (native) | `bubblewrap` | Full user-namespace isolation |
| Docker (Linux container) | `bubblewrap` | Requires `--cap-add=SYS_ADMIN` |
| macOS | `none` (automatic fallback) | macOS does not support Linux user namespaces |
| Windows WSL2 | `bubblewrap` | Install as on Linux inside WSL2 |
| Windows (native) | `none` (automatic fallback) | |

### Installing bubblewrap (Linux)

**Ubuntu / Debian:**
```bash
sudo apt-get install -y bubblewrap socat
```

**Fedora / RHEL:**
```bash
sudo dnf install -y bubblewrap socat
```

**Arch Linux:**
```bash
sudo pacman -S bubblewrap socat
```

### Configuration

In `divisions.yaml`:
```yaml
governance:
  sandbox: bubblewrap    # or: none
```

Verify sandbox availability:
```bash
sidjua sandbox check
```

---

## 9. Semantic Search (Optional)

Semantic search powers `sidjua memory search` and agent knowledge retrieval. It requires a Qdrant vector database and an embedding provider.

### Docker Compose Profile

The included `docker-compose.yml` has a `semantic-search` profile:
```bash
docker compose --profile semantic-search up -d
```
This starts a Qdrant container alongside SIDJUA.

### Standalone Qdrant

```bash
docker run -d \
  --name sidjua-qdrant \
  -p 6333:6333 \
  -v qdrant-storage:/qdrant/storage \
  qdrant/qdrant:v1.13.2
```

Set the endpoint:
```bash
export SIDJUA_QDRANT_URL=http://localhost:6333
```

### Without Qdrant

If Qdrant is not available, `sidjua memory import` and `sidjua memory search` are disabled. All other SIDJUA features (CLI, REST API, agent execution, governance, audit) work normally. The system falls back to BM25 keyword search for any knowledge queries.

---

## 10. Troubleshooting

### All Platforms

**`npm ci` fails with `node-pre-gyp` or `node-gyp` errors:**
```
gyp ERR! build error
```
Install the C/C++ toolchain (see Prerequisites section). On Ubuntu: `sudo apt-get install -y python3 make g++ build-essential`.

**`Cannot find divisions.yaml`:**
Check `SIDJUA_CONFIG_DIR`. The file must be at `$SIDJUA_CONFIG_DIR/divisions.yaml`. Run `sidjua init` to create the workspace structure.

**REST API returns 401 Unauthorized:**
The REST API uses a separate API key (not the browser password). Generate one with:
```bash
sidjua api-key generate
```
Then pass it as `Authorization: Bearer <key>` in your requests.

**Port 3000 already in use:**
```bash
SIDJUA_PORT=3001 sidjua server start
# or set in .env: SIDJUA_PORT=3001
```

---

### Ubuntu / Debian

**`better-sqlite3` fails to compile with `futex.h` not found:**
```bash
sudo apt-get install -y linux-headers-$(uname -r)
```

---

### Fedora / RHEL

**SELinux blocks Docker volume mounts:**
```yaml
# Add :Z label for SELinux context
volumes:
  - ./my-config:/app/config:Z
```
Or set the SELinux context manually:
```bash
chcon -Rt svirt_sandbox_file_t ./my-config
```

---

### Arch Linux

**Node.js version too old:**
Use `nvm` to install Node.js 22:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22
```

---

### macOS

**`xcrun: error: invalid active developer path`:**
```bash
xcode-select --install
```

**Docker Desktop runs out of memory:**
Open Docker Desktop → Settings → Resources → Memory. Increase to at least 4 GB.

**Apple Silicon — architecture mismatch:**
Verify your Node.js installation is native ARM64 (not Rosetta):
```bash
node -e "console.log(process.arch)"
# expected: arm64
```
If it prints `x64`, reinstall Node.js using the ARM64 installer from nodejs.org.

---

### Windows (native)

**`MSBuild` or `cl.exe` not found:**
Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select the **Desktop development with C++** workload. Then run:
```powershell
npm install --global windows-build-tools
```

**Long path errors (`ENAMETOOLONG`):**
Enable long path support in the Windows registry:
```powershell
# Run as Administrator
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1
```

**`sidjua` command not found after `npm install -g`:**
Add the npm global bin directory to your PATH:
```powershell
npm config get prefix  # shows e.g. C:\Users\you\AppData\Roaming\npm
# Add that path to System Environment Variables → Path
```

---

### Windows WSL2

**Docker fails to start inside WSL2:**
Open Docker Desktop → Settings → General → enable **Use the WSL 2 based engine**.
Then restart Docker Desktop and your WSL2 terminal.

**Permission errors on files under `/mnt/c/`:**
Windows NTFS volumes mounted in WSL2 have restricted permissions. Move your workspace to a Linux-native path:
```bash
mkdir ~/sidjua-workspace
cd ~/sidjua-workspace
sidjua init
```

---

### Raspberry Pi / ARM64

**`npm ci` is very slow (5-10 minutes):**
This is normal. Native addon compilation on ARM64 takes longer. Consider using the Docker image instead:
```bash
docker pull sidjua/sidjua:latest-arm64
```

**Out of memory during build:**
Add swap space:
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

---

## 11. Docker Volume Reference

### Named Volumes

| Volume Name | Container Path | Purpose |
|-------------|---------------|---------|
| `sidjua-data` | `/app/data` | SQLite databases, backup archives, knowledge collections |
| `sidjua-config` | `/app/config` | `divisions.yaml`, custom configuration |
| `sidjua-logs` | `/app/logs` | Structured application logs |
| `sidjua-system` | `/app/.system` | API key, update state, process lock file |
| `sidjua-workspace` | `/app/agents` | Agent skill directories, definitions, templates |
| `sidjua-governance` | `/app/governance` | Immutable audit trail, governance snapshots |
| `qdrant-storage` | `/qdrant/storage` | Qdrant vector index (semantic search profile only) |

### Using a Host Directory

To mount your own `divisions.yaml` instead of editing inside the container:

```yaml
# docker-compose.override.yml
services:
  sidjua:
    volumes:
      - ./my-config:/app/config   # replaces the sidjua-config named volume
```

### Backup

```bash
sidjua backup create                    # from inside the container
# or
docker compose exec sidjua sidjua backup create
```

Backups are HMAC-signed archives stored in `/app/data/backups/`.

---

## 12. Upgrading

### Docker

```bash
git pull
docker compose build --no-cache
docker compose up -d
docker compose exec sidjua sidjua apply    # run schema migrations
```

`sidjua apply` is idempotent — always safe to re-run after an upgrade.

### npm Global Install

```bash
npm update -g sidjua
sidjua apply    # run schema migrations
```

### Source Build

```bash
git pull
npm ci
npm run build
node dist/index.js apply    # run schema migrations
```

### Rollback

SIDJUA creates a governance snapshot before each `sidjua apply`. To revert:

```bash
sidjua rollback list
sidjua rollback <version>
```

---

## 13. Next Steps

| Resource | Command / Link |
|----------|---------------|
| Quick Start | [docs/QUICK-START.md](QUICK-START.md) |
| CLI Reference | [docs/CLI-REFERENCE.md](CLI-REFERENCE.md) |
| Governance Examples | [docs/GOVERNANCE-EXAMPLES.md](GOVERNANCE-EXAMPLES.md) |
| Free LLM Provider Guide | [docs/FREE-LLM-PROVIDER-GUIDE.md](FREE-LLM-PROVIDER-GUIDE.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

First commands to run after installation:

```bash
sidjua chat guide    # zero-config AI guide — no API key needed
sidjua selftest      # system health check (7 categories, 0-100 score)
sidjua apply         # provision agents from divisions.yaml
```
