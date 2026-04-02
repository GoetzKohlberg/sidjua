// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P356: VectorStore barrel export + factory.
 *
 * Factory reads from environment variables:
 *   SIDJUA_QDRANT_ENABLED=true   — use QdrantVectorStore
 *   SIDJUA_QDRANT_URL            — Qdrant base URL (default: http://localhost:6333)
 *
 * Default: SqliteVectorStore (no extra infra required).
 */

export type { VectorPoint, VectorSearchResult, VectorStore } from "./vector-store.js";
export { SqliteVectorStore } from "./sqlite-vector-store.js";
export { QdrantClient }      from "./qdrant-client.js";
export { QdrantVectorStore } from "./qdrant-vector-store.js";

import type { Database }     from "../../utils/db.js";
import type { VectorStore }  from "./vector-store.js";
import { SqliteVectorStore } from "./sqlite-vector-store.js";
import { QdrantClient }      from "./qdrant-client.js";
import { QdrantVectorStore } from "./qdrant-vector-store.js";

/**
 * Create the appropriate VectorStore based on environment configuration.
 *
 * Set `SIDJUA_QDRANT_ENABLED=true` (or `1`) to use Qdrant.
 * Falls back to SQLite when Qdrant is not enabled or not reachable.
 */
export function createVectorStore(db: Database): VectorStore {
  const enabled = process.env["SIDJUA_QDRANT_ENABLED"];
  if (enabled === "true" || enabled === "1") {
    const url = process.env["SIDJUA_QDRANT_URL"] ?? "http://localhost:6333";
    return new QdrantVectorStore(new QdrantClient(url));
  }
  return new SqliteVectorStore(db);
}
