# Module SDK

## What It Does

A **SIDJUA Module** is an MCP server packaged with governance metadata.
The Module SDK provides scaffolding, installation, and lifecycle management
so that third-party tool providers can be added to SIDJUA without manually
editing `mcp-servers.yaml`. Modules are installed as npm packages into the
`modules/` directory and are automatically registered in the MCP registry on
startup.

---

## How It Works

1. **`module.yaml`** — the manifest file at the root of every module. Declares the server command, entry point, governance defaults, and description.
2. **Module scanner** — `scanModules()` reads `modules/*/module.yaml`, validates the manifest, and returns a map of `ModuleDefinition` objects.
3. **Registry bridge** — `buildModuleConfigMap()` converts each `ModuleDefinition` into an `McpServerConfig`. Governance overrides in the workspace's `mcp-servers.yaml` take precedence over module defaults.
4. **`initializeWithModules()`** — the MCP registry merges module configs with the static YAML config. YAML wins on name collision.
5. **Governance merging** — `mergeGovernanceOverrides()` deep-merges operator-provided overrides onto the module's defaults, so global policies apply to all modules.

---

## Key Files

| Path | Purpose |
|------|---------|
| `src/core/modules/types.ts` | `ModuleDefinition`, `InstalledModule` interfaces |
| `src/core/modules/module-scanner.ts` | `scanModules()` — reads and validates `module.yaml` files |
| `src/core/modules/module-installer.ts` | `installModule()`, `removeModule()`, `deriveModuleName()` |
| `src/core/modules/module-scaffolder.ts` | `scaffoldModule()` — creates module skeleton |
| `src/core/modules/module-registry-bridge.ts` | `moduleToMcpConfig()`, `mergeGovernanceOverrides()`, `buildModuleConfigMap()` |
| `src/cli/commands/cmd-module.ts` | CLI commands: `sidjua module init/list/add/remove/test` |

---

## CLI Commands

```bash
# Scaffold a new module in modules/my-module/
sidjua module init my-module

# Install an existing module from npm
sidjua module add @example/sidjua-module-weather

# List installed modules and their health status
sidjua module list

# Remove a module
sidjua module remove my-module

# Test a module's MCP server (calls tools/list)
sidjua module test my-module
```

---

## Configuration

### `module.yaml` format

```yaml
# modules/my-module/module.yaml

name: my-module
version: 1.0.0
description: "Short description of what this module does"

# MCP server entry point
command: node
args: [index.js]

# Governance defaults — operators can override these in mcp-servers.yaml
governance_defaults:
  allowed_tiers: [1, 2, 3]
  allowed_divisions: []         # empty = all divisions
  max_calls_per_minute: 30
  classification_ceiling: INTERNAL
  forbidden_patterns: []
  budget_per_call: 0.001
```

### Overriding module governance

Operators can override module governance in `config/mcp-servers.yaml`:

```yaml
servers:
  my-module:                    # must match module name
    governance:
      allowed_tiers: [1, 2]    # tighten: no T3 access
      max_calls_per_minute: 10
```

---

## Common Questions

**What is the difference between a module and an MCP server?**

An MCP server is a process that implements the MCP protocol. A SIDJUA Module
is an MCP server plus a `module.yaml` manifest with governance defaults. All
modules are MCP servers; not all MCP servers are modules.

**Can I publish a module to npm?**

Yes. Package the server and `module.yaml` as a standard npm package. Users
install it with `sidjua module add <package>`. The installer runs
`npm install --ignore-scripts` to prevent arbitrary script execution.

**Does installing a module require a restart?**

The module is loaded at the next daemon start. To hot-reload without restarting,
run `sidjua mcp reload` — the registry re-scans modules and reconnects any
new or changed servers.
