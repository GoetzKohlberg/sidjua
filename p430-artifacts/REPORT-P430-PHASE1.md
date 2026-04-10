# REPORT-P430-PHASE1: Temp-Dir Leak Inventory

**Date:** 2026-04-10
**Phase:** 1 — INVENTORY
**Scope:** `tests/**/*.test.ts` — all mkdtemp / tmpdir usage

## Summary

| Metric | Count |
|--------|-------|
| Total files with mkdtemp/tmpdir usage | 239 |
| MECHANICAL (safe 1:1 replace) | 117 |
| NEEDS-REVIEW | 122 |
| afterEach+rm (cleanup present) | 179 |
| try-finally (cleanup present) | 26 |
| NONE (confirmed leak) | 33 |
| rm-present-no-hook | 1 |

## NEEDS-REVIEW Reason Breakdown

| Reason | Files |
|--------|-------|
| helper-fn-no-guaranteed-cleanup | 108 |
| NONE-cleanup-leak | 33 |
| many-calls:7 | 3 |
| many-calls:5 | 2 |
| many-calls:8 | 1 |
| many-calls:6 | 1 |
| beforeAll-without-afterAll | 1 |
| rm-no-lifecycle-hook | 1 |

## MECHANICAL Files (117)

These files use mkdtemp/tmpdir with standard afterEach+rm or try-finally cleanup.
Safe for 1:1 migration to `useTempDir` / `withTempDir` helper.

| File | Lines | Cleanup | Notes |
|------|-------|---------|-------|
| `tests/agent-lifecycle/agent-create-quick.test.ts` | 64, 144 | afterEach+rm | |
| `tests/agents/bootstrap.test.ts` | 389 | afterEach+rm | |
| `tests/agents/integration/agent-lifecycle.test.ts` | 107 | afterEach+rm | |
| `tests/agents/integration/memory-persistence.test.ts` | 44 | afterEach+rm | |
| `tests/agents/skill-loader.test.ts` | 318 | afterEach+rm | |
| `tests/api/agent-tools-governance.test.ts` | 34 | afterEach+rm | |
| `tests/api/agent-tools.test.ts` | 37 | afterEach+rm | |
| `tests/api/p268-orchestrator-startup.test.ts` | 72 | try-finally | |
| `tests/api/routes/upload-routes.test.ts` | 93 | afterEach+rm | |
| `tests/api/security-hardening.test.ts` | 47 | afterEach+rm | |
| `tests/apply/filesystem.test.ts` | 90 | afterEach+rm | |
| `tests/apply/finalize.test.ts` | 61 | afterEach+rm | |
| `tests/apply/integration.test.ts` | 69 | afterEach+rm | |
| `tests/benchmarks/report-writer.test.ts` | 38 | afterEach+rm | |
| `tests/cli/apply-command.test.ts` | 79 | afterEach+rm | |
| `tests/cli/commands/costs.test.ts` | 55, 147 | afterEach+rm | |
| `tests/cli/commands/sandbox-check.test.ts` | 121 | afterEach+rm | |
| `tests/cli/file-size-limits.test.ts` | 18 | afterEach+rm | |
| `tests/cli/schedule-commands.test.ts` | 71 | afterEach+rm | |
| `tests/cli/status-command.test.ts` | 75 | afterEach+rm | |
| `tests/core/agents/definition-loader.test.ts` | 16 | afterEach+rm | |
| `tests/core/deep-health.test.ts` | 24 | afterEach+rm | |
| `tests/core/import/import-executor.test.ts` | 54, 55 | afterEach+rm | |
| `tests/core/import/openclaw-parser.test.ts` | 214 | afterEach+rm | |
| `tests/core/import/openclaw-validators.test.ts` | 13 | afterEach+rm | |
| `tests/core/mcp/mcp-registry.test.ts` | 59 | afterEach+rm | |
| `tests/core/memory/feature-flags.test.ts` | 20 | try-finally | |
| `tests/core/memory/memory-governance.test.ts` | 18 | afterEach+rm | |
| `tests/core/memory/memory-trigger.test.ts` | 21 | afterEach+rm | |
| `tests/core/modules/module-installer.test.ts` | 44, 83 | afterEach+rm | |
| `tests/core/p396-division-isolation.test.ts` | 269, 285 | try-finally | |
| `tests/core/p397-resource-management.test.ts` | 80, 354 | afterEach+rm | |
| `tests/core/reporting/pdf-renderer.test.ts` | 15 | afterEach+rm | |
| `tests/core/reporting/report-data-aggregator.test.ts` | 16 | afterEach+rm | |
| `tests/core/sandbox/config-integration.test.ts` | 46 | afterEach+rm | |
| `tests/core/telemetry/telemetry-buffer.test.ts` | 38 | afterEach+rm | |
| `tests/guide/agent-creator.test.ts` | 43 | afterEach+rm | |
| `tests/guide/commands.test.ts` | 30 | afterEach+rm | |
| `tests/guide/guide-chat.test.ts` | 73 | afterEach+rm | |
| `tests/import/openclaw-credential-migrator.test.ts` | 137 | afterEach+rm | |
| `tests/import/openclaw-skill-converter.test.ts` | 77 | afterEach+rm | |
| `tests/integration/end-to-end.integration.test.ts` | 44 | afterEach+rm | |
| `tests/integration/governance.integration.test.ts` | 44 | afterEach+rm | |
| `tests/integration/mock-end-to-end.test.ts` | 35 | afterEach+rm | |
| `tests/integration/mock-reasoning-loop.test.ts` | 74 | afterEach+rm | |
| `tests/integration/reasoning-loop.integration.test.ts` | 66 | afterEach+rm | |
| `tests/knowledge-pipeline/integration/policy-test-flow.test.ts` | 60 | afterEach+rm | |
| `tests/knowledge-pipeline/wal/memory-wal.test.ts` | 16 | afterEach+rm | |
| `tests/modules/discord/discord-cli-listen.test.ts` | 37 | afterEach+rm | |
| `tests/modules/discord/discord-gateway-daemon.test.ts` | 42, 106 | afterEach+rm | |
| `tests/orchestrator/escalation.test.ts` | 40 | afterEach+rm | |
| `tests/orchestrator/execution-bridge.test.ts` | 30 | afterEach+rm | |
| `tests/orchestrator/peer-router.test.ts` | 36 | afterEach+rm | |
| `tests/orchestrator/synthesis-handler.test.ts` | 29 | afterEach+rm | |
| `tests/orchestrator/synthesis.test.ts` | 33 | afterEach+rm | |
| `tests/orchestrator/tree-manager.test.ts` | 36 | afterEach+rm | |
| `tests/pipeline/ack-tracker.test.ts` | 48 | afterEach+rm | |
| `tests/pipeline/approval.test.ts` | 70 | afterEach+rm | |
| `tests/pipeline/config-loader.test.ts` | 27 | afterEach+rm | |
| `tests/pipeline/integration/backpressure-flow.test.ts` | 33 | afterEach+rm | |
| `tests/pipeline/integration/crash-recovery.test.ts` | 35 | afterEach+rm | |
| `tests/pipeline/integration/multi-producer.test.ts` | 36 | afterEach+rm | |
| `tests/pipeline/integration/priority-ordering.test.ts` | 30 | afterEach+rm | |
| `tests/pipeline/memory-lifecycle-policy.test.ts` | 194, 292 | afterEach+rm | |
| `tests/pipeline/personal-mode.test.ts` | 50 | afterEach+rm | |
| `tests/pipeline/pipeline-rbac.test.ts` | 49 | afterEach+rm | |
| `tests/pipeline/pipeline.integration.test.ts` | 84 | afterEach+rm | |
| `tests/pipeline/priority-queue.test.ts` | 46 | afterEach+rm | |
| `tests/pipeline/resume.test.ts` | 33 | afterEach+rm | |
| `tests/pipeline/security-filter.test.ts` | 450 | afterEach+rm | |
| `tests/pipeline/task-pipeline.test.ts` | 53 | afterEach+rm | |
| `tests/provider/audit-logger.test.ts` | 63 | afterEach+rm | |
| `tests/provider/registry.integration.test.ts` | 84 | afterEach+rm | |
| `tests/scheduler/cron-scheduler.test.ts` | 93 | afterEach+rm | |
| `tests/scheduler/deadline-watcher.test.ts` | 71 | afterEach+rm | |
| `tests/scripts/generate-dev-diagrams.test.ts` | 22 | afterEach+rm | |
| `tests/secrets/secret-cli.test.ts` | 31 | try-finally | |
| `tests/security/audit-p200.test.ts` | 128, 208 | try-finally | |
| `tests/security/deepseek-reaudit-p171.test.ts` | 67, 118, 163 | afterEach+rm | |
| `tests/security/defense-in-depth-p196.test.ts` | 344 | afterEach+rm | |
| `tests/security/discord-b10-h4.test.ts` | 160, 201 | afterEach+rm | |
| `tests/security/governance-ipc-sandbox-b6-b7-h7.test.ts` | 128 | afterEach+rm | |
| `tests/security/master-key-permissions.test.ts` | 36 | afterEach+rm | |
| `tests/security/module-b11-h6.test.ts` | 37 | try-finally | |
| `tests/security/p250-high-security-fixes.test.ts` | 188, 398, 410 | try-finally | |
| `tests/security/p252-quality-cleanup.test.ts` | 162 | try-finally | |
| `tests/security/p271-operational-integrity.test.ts` | 105, 111, 123, 276 | afterEach+rm | |
| `tests/security/p272-ipc-tool-module-hardening.test.ts` | 69, 294, 314 | try-finally | |
| `tests/security/p323-pre-launch-audit.test.ts` | 28 | afterEach+rm | |
| `tests/security/path-traversal-b4-b5.test.ts` | 49 | afterEach+rm | |
| `tests/security/prompt-119-fixes.test.ts` | 288, 430 | afterEach+rm | |
| `tests/security/prompt-120-fixes.test.ts` | 31, 201 | afterEach+rm | |
| `tests/security/sqlite-hardening-p199.test.ts` | 156, 210 | try-finally | |
| `tests/security/v097-high-severity-fixes.test.ts` | 116, 532 | try-finally | |
| `tests/security/v097-security-fixes.test.ts` | 298 | afterEach+rm | |
| `tests/security/xai-audit-high-p173.test.ts` | 38, 132 | afterEach+rm | |
| `tests/security/xai-audit-medium-p174.test.ts` | 122 | afterEach+rm | |
| `tests/tasks/event-bus.test.ts` | 51 | afterEach+rm | |
| `tests/tasks/integration/async-delegation.test.ts` | 32 | afterEach+rm | |
| `tests/tasks/integration/budget-cascading.test.ts` | 25 | afterEach+rm | |
| `tests/tasks/integration/full-lifecycle.test.ts` | 34 | afterEach+rm | |
| `tests/tasks/integration/peer-consultation.test.ts` | 31 | afterEach+rm | |
| `tests/tasks/queue.test.ts` | 52 | afterEach+rm | |
| `tests/tasks/result-store.test.ts` | 53 | afterEach+rm | |
| `tests/tasks/router.test.ts` | 80 | afterEach+rm | |
| `tests/tasks/state-machine.test.ts` | 59 | afterEach+rm | |
| `tests/tasks/store.test.ts` | 51 | afterEach+rm | |
| `tests/tool-integration/internal/log-reader.test.ts` | 13 | afterEach+rm | |
| `tests/tool-integration/mcp-config.test.ts` | 13 | afterEach+rm | |
| `tests/tool-integration/rest-catalog-search.test.ts` | 60 | afterEach+rm | |
| `tests/tool-integration/rest-tool-factory.test.ts` | 103 | afterEach+rm | |
| `tests/tool-integration/rest-tool-register.test.ts` | 51 | afterEach+rm | |
| `tests/uploads/conversation-uploads.test.ts` | 44 | afterEach+rm | |
| `tests/uploads/extraction-service.test.ts` | 61 | afterEach+rm | |
| `tests/uploads/file-storage.test.ts` | 15 | afterEach+rm | |
| `tests/uploads/upload-embedder.test.ts` | 98 | afterEach+rm | |
| `tests/web/tls.test.ts` | 27 | afterEach+rm | |

## NEEDS-REVIEW Files (122)

These files require manual analysis before migration.
Reasons: NONE-cleanup-leak, helper-fn patterns, many-calls, beforeAll-without-afterAll.

| File | Lines | Cleanup | Reasons |
|------|-------|---------|---------|
| `tests/agent-lifecycle/agent-validator.test.ts` | 114 | NONE | NONE-cleanup-leak |
| `tests/agent-lifecycle/integration/full-agent-lifecycle.test.ts` | 107 | NONE | NONE-cleanup-leak |
| `tests/agent-lifecycle/skill-loader-v2.test.ts` | 57 | NONE | helper-fn-no-guaranteed-cleanup:[57]; NONE-cleanup-leak |
| `tests/agents/integration/memory-lifecycle.test.ts` | 99, 152, 266, 311 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[99] |
| `tests/agents/memory-lifecycle.test.ts` | 105, 159, 200, 248 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[105] |
| `tests/agents/memory.test.ts` | 42, 459, 505, 555, 626, 668, 698, 745 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[459]; many-calls:8 |
| `tests/api/activity-api.test.ts` | 27 | NONE | helper-fn-no-guaranteed-cleanup:[27]; NONE-cleanup-leak |
| `tests/api/chat-persistence.test.ts` | 32 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[32] |
| `tests/api/rate-limiter-persistence.test.ts` | 32 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[32] |
| `tests/api/routes/audit.test.ts` | 21 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[21] |
| `tests/api/routes/system.test.ts` | 155, 172 | NONE | NONE-cleanup-leak |
| `tests/apply/agents.test.ts` | 72 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[72] |
| `tests/apply/audit.test.ts` | 57 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[57] |
| `tests/apply/cost-centers.test.ts` | 58 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[58] |
| `tests/apply/database-org-seed.test.ts` | 27 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[27] |
| `tests/apply/database.test.ts` | 56 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[56] |
| `tests/apply/rbac.test.ts` | 56 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[56] |
| `tests/apply/routing.test.ts` | 59 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[59] |
| `tests/apply/secrets.test.ts` | 55 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[55] |
| `tests/apply/skills.test.ts` | 56 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[56] |
| `tests/backup-button-status.test.ts` | 27 | NONE | helper-fn-no-guaranteed-cleanup:[27]; NONE-cleanup-leak |
| `tests/cli/activity-cli.test.ts` | 21 | NONE | helper-fn-no-guaranteed-cleanup:[21]; NONE-cleanup-leak |
| `tests/cli/backup-cli.test.ts` | 36 | try-finally | helper-fn-no-guaranteed-cleanup:[36] |
| `tests/cli/chat.test.ts` | 73 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[73] |
| `tests/cli/commands/agents.test.ts` | 38 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[38] |
| `tests/cli/commands/cmd-module.test.ts` | 21 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[21] |
| `tests/cli/commands/decide.test.ts` | 36 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[36] |
| `tests/cli/commands/health.test.ts` | 41 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[41] |
| `tests/cli/commands/logs.test.ts` | 37 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[37] |
| `tests/cli/commands/output.test.ts` | 38 | try-finally | helper-fn-no-guaranteed-cleanup:[38] |
| `tests/cli/commands/queue.test.ts` | 41 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[41] |
| `tests/cli/commands/run.test.ts` | 39 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[39] |
| `tests/cli/commands/shutdown.test.ts` | 34 | try-finally | helper-fn-no-guaranteed-cleanup:[34] |
| `tests/cli/commands/start-recovery.test.ts` | 34 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[34] |
| `tests/cli/commands/task-stop.test.ts` | 36 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[36] |
| `tests/cli/commands/tasks.test.ts` | 46 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[46] |
| `tests/cli/commands/update.test.ts` | 17 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[17] |
| `tests/cli/init.test.ts` | 47, 285 | try-finally | helper-fn-no-guaranteed-cleanup:[47] |
| `tests/cli/run-budget.test.ts` | 184 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[184] |
| `tests/cli/secret-edge-cases.test.ts` | 19 | try-finally | helper-fn-no-guaranteed-cleanup:[19] |
| `tests/cli/telemetry.test.ts` | 29 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[29] |
| `tests/core/activity/activity-emitter.test.ts` | 18 | NONE | helper-fn-no-guaranteed-cleanup:[18]; NONE-cleanup-leak |
| `tests/core/activity/activity-migrations.test.ts` | 16 | NONE | helper-fn-no-guaranteed-cleanup:[16]; NONE-cleanup-leak |
| `tests/core/activity/bridges/audit-event-bridge.test.ts` | 20 | NONE | helper-fn-no-guaranteed-cleanup:[20]; NONE-cleanup-leak |
| `tests/core/activity/bridges/task-event-bridge.test.ts` | 20 | NONE | helper-fn-no-guaranteed-cleanup:[20]; NONE-cleanup-leak |
| `tests/core/activity/digest-engine.test.ts` | 19 | NONE | helper-fn-no-guaranteed-cleanup:[19]; NONE-cleanup-leak |
| `tests/core/activity/digest-scheduler.test.ts` | 23 | NONE | helper-fn-no-guaranteed-cleanup:[23]; NONE-cleanup-leak |
| `tests/core/audit/audit-service.test.ts` | 18 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[18] |
| `tests/core/backup-security.test.ts` | 115, 410, 431, 432, 449, 450 | try-finally | helper-fn-no-guaranteed-cleanup:[115]; many-calls:6 |
| `tests/core/backup.test.ts` | 31, 242, 278 | try-finally | helper-fn-no-guaranteed-cleanup:[31] |
| `tests/core/governance/rule-loader.test.ts` | 23 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[23] |
| `tests/core/knowledge/embedding-migration.test.ts` | 22 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[22] |
| `tests/core/knowledge/embedding-source.test.ts` | 16 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[16] |
| `tests/core/mcp/memory-verifier.test.ts` | 14 | NONE | beforeAll-without-afterAll; NONE-cleanup-leak |
| `tests/core/memory/memory-consolidator.test.ts` | 32 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[32] |
| `tests/core/memory/memory-index.test.ts` | 27 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[27] |
| `tests/core/migration-system.test.ts` | 26, 102, 175 | try-finally | helper-fn-no-guaranteed-cleanup:[26, 175] |
| `tests/core/modules/module-scaffolder.test.ts` | 19 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[19] |
| `tests/core/paths.test.ts` | 25 | try-finally | helper-fn-no-guaranteed-cleanup:[25] |
| `tests/core/selftest/checks.test.ts` | 14 | try-finally | helper-fn-no-guaranteed-cleanup:[14] |
| `tests/core/telemetry/telemetry-reporter.test.ts` | 37 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[37] |
| `tests/core/update/backup-manager.test.ts` | 18 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[18] |
| `tests/core/update/lock-manager.test.ts` | 16 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[16] |
| `tests/core/update/migration-framework.test.ts` | 29 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[29] |
| `tests/core/update/update-check.test.ts` | 22 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[22] |
| `tests/core/update/version-archive.test.ts` | 15 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[15] |
| `tests/governance/rollback.test.ts` | 32 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[32] |
| `tests/import/import-cli.test.ts` | 18 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[18] |
| `tests/import/openclaw-importer.test.ts` | 19, 290, 300 | try-finally | helper-fn-no-guaranteed-cleanup:[19] |
| `tests/integration-gateway/cli-and-e2e.test.ts` | 167 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[167] |
| `tests/integration-gateway/governance-bridge.test.ts` | 207 | NONE | NONE-cleanup-leak |
| `tests/integration-gateway/http-adapters.test.ts` | 392 | NONE | helper-fn-no-guaranteed-cleanup:[392]; NONE-cleanup-leak |
| `tests/integration-gateway/local-executors.test.ts` | 116, 147, 154, 174, 192, 210, 228 | NONE | helper-fn-no-guaranteed-cleanup:[116]; NONE-cleanup-leak; many-calls:7 |
| `tests/integration/update-e2e.test.ts` | 69 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[69] |
| `tests/integrations/email-cli.test.ts` | 109 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[109] |
| `tests/json-bomb.test.ts` | 27 | NONE | helper-fn-no-guaranteed-cleanup:[27]; NONE-cleanup-leak |
| `tests/knowledge-pipeline/policy/policy-deployer.test.ts` | 30 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[30] |
| `tests/knowledge-pipeline/vector-store/create-vector-store.test.ts` | 19 | NONE | helper-fn-no-guaranteed-cleanup:[19]; NONE-cleanup-leak |
| `tests/knowledge-pipeline/vector-store/embedding-pipeline-vectorstore.test.ts` | 21 | NONE | helper-fn-no-guaranteed-cleanup:[21]; NONE-cleanup-leak |
| `tests/knowledge-pipeline/vector-store/hybrid-retriever-vectorstore.test.ts` | 20 | NONE | helper-fn-no-guaranteed-cleanup:[20]; NONE-cleanup-leak |
| `tests/knowledge-pipeline/vector-store/sqlite-vector-store.test.ts` | 17 | NONE | helper-fn-no-guaranteed-cleanup:[17]; NONE-cleanup-leak |
| `tests/messaging/config-loading.test.ts` | 41 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[41] |
| `tests/messaging/telegram-activity.test.ts` | 21 | NONE | helper-fn-no-guaranteed-cleanup:[21]; NONE-cleanup-leak |
| `tests/module-installer-injection.test.ts` | 32, 38, 44, 50, 57, 74, 90 | try-finally | many-calls:7 |
| `tests/modules/env-sanitization.test.ts` | 92 | try-finally | helper-fn-no-guaranteed-cleanup:[92] |
| `tests/modules/first-party-policy.test.ts` | 36 | NONE | NONE-cleanup-leak |
| `tests/modules/module-loader.test.ts` | 26, 144, 150 | NONE | NONE-cleanup-leak |
| `tests/modules/module-registry.test.ts` | 17 | NONE | NONE-cleanup-leak |
| `tests/orchestrator/checkpoint-timer.test.ts` | 24 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[24] |
| `tests/orchestrator/integration/cancellation-cascade.test.ts` | 76 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[76] |
| `tests/orchestrator/integration/full-delegation-flow.test.ts` | 131 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[131] |
| `tests/orchestrator/messaging-integration.test.ts` | 97 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[97] |
| `tests/orchestrator/orchestrator.test.ts` | 106 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[106] |
| `tests/org-chart/org-chart-seeder.test.ts` | 75, 182, 188 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[75] |
| `tests/pipeline/budget.test.ts` | 63 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[63] |
| `tests/provider/cost-tracker.test.ts` | 69 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[69] |
| `tests/security/atomic-ops-b8-b9-h11.test.ts` | 212, 319 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[212] |
| `tests/security/audit-8-deepseek-fixes.test.ts` | 33, 34, 47, 62, 71, 78, 85 | afterEach+rm | many-calls:7 |
| `tests/security/dual-audit-p391-fixes.test.ts` | 92, 149, 211, 257, 472 | try-finally | many-calls:5 |
| `tests/security/key-embed-telemetry-h8-h9-h12.test.ts` | 46 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[46] |
| `tests/security/manifest-size-limit.test.ts` | 34 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[34] |
| `tests/security/memory-exhaustion-h5.test.ts` | 80 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[80] |
| `tests/security/p249-data-integrity.test.ts` | 49 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[49] |
| `tests/security/p251-operational-integrity.test.ts` | 30 | try-finally | helper-fn-no-guaranteed-cleanup:[30] |
| `tests/security/p274-fail-closed-hardening.test.ts` | 31, 47, 168, 301, 302 | rm-present-no-hook | rm-no-lifecycle-hook; many-calls:5 |
| `tests/security/p355-security-hardening.test.ts` | 41 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[41] |
| `tests/security/path-security-p393.test.ts` | 171 | NONE | NONE-cleanup-leak |
| `tests/security/serve-gui-dir-resolve.test.ts` | 33, 60, 69 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[33] |
| `tests/security/sql-injection-audit.test.ts` | 34 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[34] |
| `tests/start-over/analyze.test.ts` | 20 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[20] |
| `tests/start-over/backup.test.ts` | 25 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[25] |
| `tests/start-over/start-over.integration.test.ts` | 23 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[23] |
| `tests/start-over/wipe.test.ts` | 16 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[16] |
| `tests/start-over/workspace-scanner.test.ts` | 16 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[16] |
| `tests/tasks/tree.test.ts` | 56 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[56] |
| `tests/tool-integration/composite-tool-creator.test.ts` | 58 | afterEach+rm | helper-fn-no-guaranteed-cleanup:[58] |
| `tests/tool-integration/filesystem-adapter.test.ts` | 18 | NONE | NONE-cleanup-leak |
| `tests/tool-integration/internal/audit-trail.test.ts` | 13 | NONE | helper-fn-no-guaranteed-cleanup:[13]; NONE-cleanup-leak |
| `tests/tool-integration/internal/list-documents.test.ts` | 14 | NONE | helper-fn-no-guaranteed-cleanup:[14]; NONE-cleanup-leak |
| `tests/tool-integration/internal/mcp-configurator.test.ts` | 25, 26 | NONE | helper-fn-no-guaranteed-cleanup:[25, 26]; NONE-cleanup-leak |
| `tests/tool-integration/internal/mcp-installer.test.ts` | 33 | NONE | helper-fn-no-guaranteed-cleanup:[33]; NONE-cleanup-leak |
| `tests/tool-integration/tool-call-router.test.ts` | 33 | NONE | helper-fn-no-guaranteed-cleanup:[33]; NONE-cleanup-leak |

## Methodology

- Searched `tests/**/*.test.ts` for: `mkdtemp`, `mkdtempSync`, `os.tmpdir`, `tmpdir()`
- Per file: recorded absolute path, hit line numbers, cleanup pattern detection
- MECHANICAL: has afterEach+rm or try-finally cleanup, single standard pattern
- NEEDS-REVIEW: NONE cleanup, helper-fn at module scope, many-calls (5+), or beforeAll-without-afterAll

## Next Step

Phase 2: Create `tests/_helpers/temp-dir.ts`, ESLint rule `tools/eslint-rules/no-raw-tempdir.js`,
vitest globalSetup, and `.gitignore` entry. No test file migrations in Phase 2.
