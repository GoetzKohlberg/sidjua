// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: AutoCollector
 * Listens for TASK_COMPLETED events and pipes results into division auto-collections.
 */

import type { Database } from "../utils/db.js";
import type { EmbeddingPipeline } from "./embedding/embedding-pipeline.js";
import type { CollectionManager } from "./collection-manager.js";
import { createLogger, type Logger } from "../core/logger.js";

export interface AutoCollectorConfig {
  enabled: boolean;
  retention_days?: number;
}

export interface TaskResultEvent {
  task_id: string;
  division: string;
  result_content: string;
  completed_at: string;
}

export class AutoCollector {
  constructor(
    private readonly db: Database,
    private readonly pipeline: EmbeddingPipeline,
    private readonly collectionManager: CollectionManager,
    private readonly config: AutoCollectorConfig = { enabled: true },
    private readonly logger: Logger = createLogger("auto-collector"),
  ) {}

  async onTaskCompleted(event: TaskResultEvent): Promise<void> {
    if (!this.config.enabled) return;

    const collectionId = `auto-results-${event.division}`;

    // Ensure the auto-collection exists
    if (this.collectionManager.getById(collectionId) === undefined) {
      this.collectionManager.create({
        id: collectionId,
        name: `Auto Results — ${event.division}`,
        description: "Automatically populated from task results",
        scope: {
          divisions: [event.division],
          classification: "INTERNAL",
        },
      });
    }

    try {
      await this.pipeline.ingest(event.result_content, {
        collection_id: collectionId,
        source_file: `task-result-${event.task_id}.md`,
      });

      this.logger.info("task_result_ingested", "Task result ingested into auto-collection", {
        metadata: { task_id: event.task_id, collection_id: collectionId },
      });
    } catch (err) {
      this.logger.error("task_result_ingest_failed", "Failed to ingest task result", {
        metadata: { task_id: event.task_id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
