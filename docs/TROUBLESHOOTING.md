# SIDJUA Troubleshooting Guide

Common problems and how to fix them. Each section describes the symptom, the likely cause, and the fix.

---

## `sidjua apply` Fails

### Symptom: "schema_version is required" or "schema_version not supported"

**Cause:** Your `divisions.yaml` is missing `schema_version: "1.0"` or uses a different format.

**Fix:**
1. Open `config/divisions.yaml` (or the path you passed with `--config`)
2. Ensure the first content line is `schema_version: "1.0"` (after any comments)
3. Verify the structure uses `company:` and `divisions:` as a list — not `organization:` or `preset:`
4. Run `sidjua apply --dry-run` to validate before applying

Correct file header:
```yaml
schema_version: "1.0"

company:
  name: "My Org"
  size: "solo"

divisions:
  - code: engineering
    ...
```

---

### Symptom: "EACCES: permission denied" or "ENOENT: no such file or directory"

**Cause:** SIDJUA cannot write to the working directory or a required subdirectory.

**Fix:**
1. Check that the working directory is writable: `ls -la .`
2. For Docker: ensure named volumes are mounted and the `sidjua` user (uid 1001) owns `/app/data` and `/app/config`
3. If running manually: run as the user who owns the project directory
4. Verify disk space: `df -h .`

---

### Symptom: apply exits at step 3 (DATABASE) with SQLite error

**Cause:** The SQLite database file exists but is corrupted, or another process has it locked.

**Fix:**
1. Check if another `sidjua` process is running: `ps aux | grep sidjua`
2. If the database is new and nothing important is in it, delete `.system/sidjua.db` and re-run apply
3. If you need to preserve data, use `sidjua backup create` first

---

## API Key Issues

### Symptom: `sidjua server start` exits with "Error: API key required"

**Cause:** `SIDJUA_API_KEY` is not set and `--api-key` was not passed.

**Fix:**
1. Generate a key: `sidjua api-key generate`
2. Save it: `export SIDJUA_API_KEY="<key>"` (or add to `.env`)
3. For Docker: add `SIDJUA_API_KEY=<key>` to `.env`, then `docker compose up -d sidjua`

---

### Symptom: REST API returns `401 Unauthorized`

**Cause:** The bearer token in the `Authorization` header does not match `SIDJUA_API_KEY`.

**Fix:**
1. Verify the environment variable is set in the running process: `docker compose exec sidjua env | grep SIDJUA_API_KEY`
2. Check for trailing whitespace or newline in the key value
3. If you recently rotated the key, the grace period may still be active — wait for `--grace-seconds` to expire or restart
4. Re-generate and reset: `sidjua api-key generate`, then update `.env` and restart

---

## Provider & LLM Errors

### Symptom: Agent tasks fail with "provider error" or "LLM call timed out"

**Cause (most common):** Rate limit hit on the configured provider.

**Fix:**
1. Check provider status pages (Anthropic: status.anthropic.com, OpenAI: status.openai.com)
2. Add a `fallback_provider` and `fallback_model` to the agent's YAML definition — SIDJUA will retry with the fallback automatically
3. If using a free-tier provider (Groq, Cloudflare Workers AI), you may have exhausted the daily quota — wait or switch providers

**Cause:** API key is invalid or expired.

**Fix:**
1. Verify the key resolves: `sidjua key test <key-name>`
2. Check the provider dashboard to confirm the key is active
3. Remove the old key ref and add a new one: `sidjua key remove <name>` then `sidjua key add <name> ...`

---

### Symptom: Cloudflare Workers AI returns 403 or "authentication failed"

**Cause:** `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` is wrong.

**Fix:**
1. Verify both environment variables are set: `echo $CLOUDFLARE_ACCOUNT_ID` and `echo $CLOUDFLARE_API_TOKEN`
2. In the Cloudflare dashboard, confirm the token has **Workers AI** permissions
3. Account ID is a 32-character hex string from the right sidebar of the dashboard — not the zone ID

---

### Symptom: Agent keeps escalating tasks with "Exceeded max reasoning turns"

**Cause:** The task is too complex for the agent's configured turn limit (T3: 10 turns, T2: 15, T1: 20).

**Fix:**
1. Break the task into smaller, more focused sub-tasks
2. Improve the agent's skill file to give clearer instructions on when to call `execute_result`
3. For complex planning tasks, use a T1 or T2 agent instead of T3
4. If the task genuinely needs more turns, contact Opus (T1) to evaluate raising the limit — do not change the code unilaterally

---

### Symptom: Agent tasks fail with "Tool call was blocked by governance"

**Cause:** The governance pipeline's Stage 1 (Forbidden) or Stage 5 (Policy) blocked a tool call.

**Fix:**
1. View the full governance reason: `sidjua logs --task <id> --type governance`
2. If the block is correct (the action was genuinely not allowed), update the agent's skill file to use a different approach
3. If the block is a false positive, review `governance/boundaries/forbidden-actions.yaml` and your policy files — only Opus/T1 should modify governance rules

---

## Budget & Spending Errors

### Symptom: Task fails with "budget exceeded" or error code EXEC-005

**Cause:** The task hit its per-task USD limit, the agent hit its monthly budget, or the division hit its monthly or daily limit.

**Fix:**
1. Check which level triggered: `sidjua logs --task <id>`
2. View current spending: `sidjua costs --period 30d`
3. For per-task limits: submit the task with a higher `--cost-limit` value
4. For agent limits: `sidjua agent edit <id> --budget-monthly <new-limit>`
5. For division limits: edit `.system/cost-centers.yaml` and re-run `sidjua apply`

---

### Symptom: Budget warning emails/notifications not arriving

**Cause:** SIDJUA emits `BUDGET_WARNING` events to the event stream — outbound notifications require an external integration (webhook, monitoring tool).

**Fix:**
1. Connect to the SSE event stream: `GET /api/v1/events?token=<api-key>` and filter for `BUDGET_WARNING` events
2. Use `sidjua costs` for manual checks: `sidjua costs --period 24h`

---

## Docker Issues

### Symptom: `docker compose up -d` fails with "port 3000 already in use"

**Cause:** Another process (or another SIDJUA instance) is already using port 3000.

**Fix:**
1. Find what is using it: `ss -tlnp | grep 3000` or `lsof -i :3000`
2. Either stop the conflicting service, or override the port: add `SIDJUA_PORT=3001` to `.env` and `docker compose up -d`

---

### Symptom: Container starts but health check never passes

**Cause (a):** `SIDJUA_API_KEY` is not set, so `server start` exits before binding.

Check logs: `docker compose logs sidjua | tail -20`

**Cause (b):** The server started but `sidjua apply` has not been run, so the database is not initialized.

**Fix:** Run `docker compose exec sidjua sidjua apply` after the container is up.

**Cause (c):** Port mapping issue — server is bound to `127.0.0.1` instead of `0.0.0.0` inside the container.

This should not happen with the default Docker setup (the entrypoint passes `--host 0.0.0.0`), but if you have a custom CMD, ensure it includes `--host 0.0.0.0`.

---

### Symptom: `docker compose exec sidjua sidjua <command>` returns "command not found: sidjua"

**Cause:** The container did not build correctly or the binary is missing.

**Fix:**
1. Rebuild: `docker compose build --no-cache`
2. Check the Dockerfile `RUN` line that installs the binary: `grep -A2 "usr/local/bin/sidjua" Dockerfile`
3. If the build failed, check for npm or TypeScript compile errors in the build output

---

### Symptom: Volume data is lost after `docker compose down`

**Cause:** `docker compose down -v` removes named volumes. Running `down` without `-v` preserves volumes.

**Fix:**
- Use `docker compose down` (without `-v`) to stop containers while keeping data
- To back up before removing: `sidjua backup create --label "pre-removal"` before running down
- Named volumes (`sidjua-data`, `sidjua-config`, etc.) are never removed unless you explicitly pass `-v` or `docker volume rm`

---

## Docker: Quick Diagnostics

Before diving into platform-specific sections, run these checks to narrow down the problem:

```bash
# Container status
docker compose ps

# Application logs
docker logs sidjua

# Health endpoint (should return {"status":"ok",...})
curl http://localhost:4200/api/v1/health

# Is port 4200 already in use by something else?
lsof -i :4200          # macOS / Linux
netstat -tlnp | grep 4200   # Linux alternative
```

If the container is not listed by `docker compose ps`, check `docker compose logs` for startup errors.

---

## Docker: Windows + WSL2

### Docker Desktop must be running with WSL2 backend

Open Docker Desktop → Settings → General and confirm **"Use the WSL 2 based engine"** is checked. The Docker daemon is not available in WSL2 without this — commands will fail with `Cannot connect to the Docker daemon`.

If Docker Desktop is installed but the daemon is not reachable:
1. Start Docker Desktop from the Windows Start Menu
2. Wait for the whale icon in the system tray to stop animating
3. Re-run your `docker compose` command

### Memory limits

WSL2 allocates up to 50 % of total RAM by default, which may be too little for SIDJUA + an LLM provider. Create or edit `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
memory=4GB
swap=2GB
```

Restart WSL2: `wsl --shutdown` in PowerShell, then reopen your WSL2 terminal.

### Volume permission errors

WSL2 mounts Windows drives under `/mnt/c/`, `/mnt/d/`, etc. Docker volumes work best when the workspace is inside the WSL2 filesystem (e.g. `~/sidjua`), not on a Windows path. If you clone into `C:\Users\…` and bind-mount it from WSL2, you may see `permission denied` on SQLite files.

**Fix:** Move the project into the WSL2 home directory:
```bash
cp -r /mnt/c/Users/you/sidjua ~/sidjua
cd ~/sidjua && docker compose up -d
```

### Windows Firewall blocking port 4200

Windows Defender Firewall may block inbound connections to the WSL2 IP on port 4200. If `curl http://localhost:4200/api/v1/health` times out:
1. Open **Windows Security → Firewall & network protection → Allow an app through firewall**
2. Add an inbound rule for TCP port 4200, or temporarily disable the private network firewall for testing

### seccomp profile not found

`seccomp-profile.json` must be in the same directory as `docker-compose.yml`. If the file is missing, Docker will fail to start the container with a `no such file or directory` error.

Download it from the repository:
```bash
curl -O https://raw.githubusercontent.com/GoetzKohlberg/sidjua/main/seccomp-profile.json
```

If seccomp is not supported on your platform, comment out the `security_opt` line in `docker-compose.yml` (see the Ubuntu section below).

---

## Docker: Ubuntu / Linux

### Use Docker CE, not docker.io

The `docker.io` package from Ubuntu's default repositories is often outdated. Install Docker CE from Docker's official repository:

```bash
# Quick install script (review before running)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### User must be in the `docker` group

Running `docker` commands as root works but is not recommended. Add your user to the `docker` group and start a new shell session:

```bash
sudo usermod -aG docker $USER
newgrp docker    # or log out and back in
```

### Rootless Docker is not supported

SIDJUA's seccomp profile requires root-level privileges when applied. Rootless Docker setups will fail to start the container with a seccomp error. Use standard (rooted) Docker CE.

If you must use rootless Docker, comment out the `security_opt` line in `docker-compose.yml`:

```yaml
# security_opt:
#   - seccomp:./seccomp-profile.json
```

### AppArmor may block the container

On Ubuntu 22.04+ with AppArmor enabled, the default profile may deny some syscalls needed by SIDJUA. If the container starts but crashes immediately:

```bash
docker logs sidjua | grep -i apparmor
```

If AppArmor is the cause, you can run the container with `--security-opt apparmor=unconfined` (add to `docker-compose.yml` under `security_opt`) for diagnostics, then configure a proper AppArmor profile for production.

### Port conflict — another service on port 4200

```bash
ss -tlnp | grep 4200    # find what is using the port
```

Override the port without editing `docker-compose.yml`:

```bash
SIDJUA_PORT=4201 docker compose up -d
```

Add `SIDJUA_PORT=4201` to your `.env` file to make it permanent.

---

## Docker: macOS

### Docker Desktop for Mac — Apple Silicon (M1/M2/M3)

SIDJUA ships multi-arch images (`linux/amd64` and `linux/arm64`). On Apple Silicon, Docker Desktop will pull the native `arm64` image automatically — no Rosetta emulation needed. If you see architecture warnings, ensure Docker Desktop is up to date (≥ 4.15).

### File sharing — volume mount access

Docker Desktop on macOS requires explicit permission to access directories outside your home folder. If `docker compose up` fails with a volume-related error:

1. Open Docker Desktop → Settings → Resources → File Sharing
2. Add the directory containing `docker-compose.yml`
3. Click **Apply & Restart**

### VirtioFS vs gRPC-FUSE

Docker Desktop ≥ 4.6 supports **VirtioFS** for file sharing, which is significantly faster than the older gRPC-FUSE backend. Enable it in Docker Desktop → Settings → General → **"Use VirtioFS for file sharing"**. This is especially noticeable if SIDJUA is writing frequently to SQLite on a bind-mounted volume.

### SIDJUA goes offline after Mac sleep/wake

**Symptom:** After the Mac goes to sleep, SIDJUA is unreachable at `http://localhost:4200` even though Docker Desktop appears to be running.

**Cause:** Docker Desktop on macOS suspends the Linux VM during sleep. When the Mac wakes, Docker Desktop resumes, but the internal network bridge (the NAT interface connecting container ports to `localhost`) takes a few seconds to re-initialise. During this window, port 4200 is not forwarded.

**Solution:**

1. Wait 10–15 seconds after wake — the network bridge usually recovers automatically.
2. If SIDJUA is still unreachable after 30 seconds, restart the containers:
   ```bash
   docker compose restart
   ```
3. If the issue recurs frequently, consider enabling **"Start Docker Desktop at login"** (Docker Desktop → Settings → General) so the VM is warm before you open the browser.
4. As a permanent workaround on Apple Silicon Macs, upgrade Docker Desktop to ≥ 4.30 which includes improved wake/sleep handling for the Virtualization Framework backend.

**Prevention:** All SIDJUA containers already use `restart: unless-stopped`, so they will restart automatically if Docker Desktop itself is restarted. The sleep/wake issue is specific to the brief network-bridge recovery window, not a container crash.

---

## Docker: Common Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `seccomp-profile.json: no such file or directory` | Missing seccomp profile | Download from repo root or comment out `security_opt` in `docker-compose.yml` |
| `port already in use` | Port 4200 occupied | Set `SIDJUA_PORT=<other>` in `.env` |
| `permission denied` on volumes | UID mismatch or wrong path | `docker compose down -v` then re-up; or fix ownership with `sudo chown -R 1001:1001 ./data` |
| Health check failed (`unhealthy`) | Server not started, DB not init | Check `docker logs sidjua`; run `docker compose exec sidjua sidjua apply` |
| `SIDJUA_API_KEY not set` | Missing env var | `docker compose exec sidjua sidjua api-key generate`, then add to `.env` |
| `Cannot connect to the Docker daemon` | Docker Desktop not running (WSL2/Mac) | Start Docker Desktop and wait for the daemon to be ready |
| `exec format error` | Wrong image arch | Pull the latest image: `docker compose pull` |

---

## CLI Errors

### Symptom: `sidjua: command not found`

**Cause (a):** Manual install — the binary is not in `PATH`.

**Fix:**
1. If installed globally via npm: verify `npm list -g sidjua`
2. For manual builds: run `node dist/index.js <command>` from the project directory
3. Add the project's `dist/` to your PATH, or create an alias: `alias sidjua="node /path/to/sidjua/dist/index.js"`

**Cause (b):** Docker — you are running the command on the host, not inside the container.

**Fix:** Prefix with `docker compose exec sidjua`: `docker compose exec sidjua sidjua status`

---

### Symptom: `sidjua status` shows "No state found — run sidjua apply first"

**Cause:** `sidjua apply` has never been run, or was run against a different `--work-dir`.

**Fix:**
1. Run `sidjua apply --verbose`
2. If you have a custom work directory, ensure `--work-dir` matches for all commands
3. In Docker, the work directory is `/app` — the state file lives at `/app/.system/state.json`

---

## Module Installation Errors

### Symptom: `sidjua module install discord` fails with "Unknown module"

**Cause:** The module ID is wrong.

**Fix:**
1. Run `sidjua module list` to see all available modules
2. Check the ID spelling — currently available: `discord`
3. If you need a module that is not listed, it may be planned for a future version

---

### Symptom: Module installed but `sidjua discord status` reports missing secrets

**Cause:** The required secrets (DISCORD_TOKEN, etc.) were not entered during interactive setup, or the `.env` file in the module directory is missing values.

**Fix:**
1. Run `sidjua module status discord` to see which secrets are missing
2. Open the module's `.env` file (path shown in the status output) and add the missing values
3. Restart any running Discord bot process

---

### Symptom: Non-interactive install does not prompt — secrets remain empty

**Cause:** When STDIN is not a TTY (e.g. in a script or Docker), the install uses non-interactive mode and reads secrets from environment variables.

**Fix:** Set the required environment variables before running the install:

```bash
export DISCORD_TOKEN=your-bot-token-here
export DISCORD_GUILD_ID=your-guild-id
sidjua module install discord
```

---

## OpenClaw Import Errors

### Symptom: `sidjua import openclaw` fails with "Config file not found"

**Cause:** The default config path `~/.openclaw/openclaw.json` does not exist.

**Fix:**
1. Specify the path explicitly: `sidjua import openclaw --config /path/to/openclaw.json`
2. Verify the file exists and is readable: `ls -la ~/.openclaw/openclaw.json`
3. If you use a non-standard OpenClaw install location, check its documentation for the config file path

---

### Symptom: Import fails with "JSON5 parse error" or "Unexpected token"

**Cause:** The `openclaw.json` file is malformed.

**Fix:**
1. Use a JSON5 validator to check the file
2. Common issues: trailing commas, unquoted keys with special characters, comments in the wrong place
3. Run `--dry-run` first to surface parse errors without committing changes: `sidjua import openclaw --dry-run`

---

### Symptom: Import reports "Collision: agent <id> already exists"

**Cause:** An agent with the same derived ID is already in the workspace.

**Fix:**
1. Check existing agents: `sidjua agent list`
2. Either delete the existing agent (`sidjua agent delete <id>`) or use `--name` to change the imported agent's name (which changes the derived ID): `sidjua import openclaw --name "My New Name"`

---

### Symptom: API keys were not migrated (output shows "No API keys found to migrate")

**Cause:** The OpenClaw config does not store API keys in a format the importer recognizes, or the keys are stored only in environment variables.

**Fix:**
1. After import, add keys manually: `sidjua secret set providers anthropic-key --value "sk-ant-..."` or use `sidjua chat guide` → `/key anthropic sk-ant-...`
2. Use `--no-secrets` to skip the credential migration step if you prefer to set keys separately

---

## Secrets CLI Errors

### Symptom: `sidjua secret get` returns "secret not found"

**Cause:** The secret does not exist under that namespace and key combination.

**Fix:**
1. List existing keys in the namespace: `sidjua secret list <namespace>`
2. Check the namespace — common ones are `global`, `providers`, `divisions/<code>`
3. Run `sidjua secret namespaces` to see all namespaces that have been created

---

### Symptom: `sidjua secret set` fails with "value is required"

**Cause:** `--value` was not passed and the command was run non-interactively (STDIN is not a TTY).

**Fix:** Either pass the value as a flag or pipe it via stdin:

```bash
sidjua secret set global my-key --value "my-secret-value"
echo "my-secret-value" | sidjua secret set global my-key
```

---

### Symptom: Secrets database error: "SQLITE_CANTOPEN" or "unable to open database"

**Cause:** The secrets database at `.system/secrets.db` cannot be opened — usually a permissions issue or the workspace was not initialized.

**Fix:**
1. Run `sidjua apply` to initialize the workspace if not done yet
2. Check permissions: `ls -la .system/secrets.db`
3. If the file is owned by another user (e.g. created by Docker as root), fix ownership: `sudo chown $USER .system/secrets.db`

---

## Guide Agent Issues

### Symptom: `sidjua chat guide` exits immediately with "Guide agent not found"

**Cause:** The workspace was not initialized with `sidjua init`, or the guide definition file is missing.

**Fix:**
1. Run `sidjua init` to create the workspace and install the Guide agent
2. Verify the guide definition exists: check `agents/definitions/guide.yaml`
3. If the file is missing after init, try `sidjua init --force` to regenerate it

---

### Symptom: Guide responds with canned/offline answers instead of real AI responses

**Cause:** The Guide operates in offline mode when Cloudflare Workers AI is not configured or reachable. This is expected behavior — all slash commands still work.

**Fix:**
1. Check internet connectivity from the host
2. Add a different provider key for real AI responses: type `/key groq gsk_your-key` inside the chat
3. The Guide will use the configured provider for subsequent responses

---

### Symptom: `/key <provider> <api-key>` returns "Unknown provider"

**Cause:** The provider name is not in the supported list.

**Fix:** Supported provider names for `/key` are: `groq`, `google`, `anthropic`, `openai`, `deepseek`, `grok`, `xai`, `mistral`, `cohere`. Type `/providers` to see the full list with instructions for each.

---

### Symptom: Guide is running but responses are very slow or time out

**Cause:** The configured LLM provider is under load, rate-limited, or on a slow connection.

**Fix:**
1. Type `/status` to check which providers are configured
2. Add a faster provider as fallback: type `/key groq gsk_your-key` (Groq is among the fastest)
3. If using a local provider (Ollama), ensure the model is fully loaded: check `ollama list`

---

## Getting More Information

When any of the above fixes do not resolve the issue:

```bash
# Detailed apply output
sidjua apply --verbose --dry-run

# Full event stream for a specific task
sidjua logs --task <task-id> --type all

# Agent health check
sidjua agent health <agent-id>

# System health (JSON)
sidjua health --json

# Container logs (Docker)
docker compose logs sidjua --tail=50 --follow
```

Report bugs at https://github.com/GoetzKohlberg/sidjua/issues. Include the output of `sidjua health --json` and the relevant section of `sidjua logs` when filing a bug report.
