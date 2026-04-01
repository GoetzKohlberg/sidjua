// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P352 — FileExtractor interface and ExtractionResult.
 */

export interface ExtractionResult {
  text:      string;
  metadata?: Record<string, unknown>;
}

export interface FileExtractor {
  /** Return true if this extractor handles the given MIME type / extension. */
  supports(mimetype: string, extension: string): boolean;
  /** Extract text from the file buffer. */
  extract(buffer: Buffer, filename: string): Promise<ExtractionResult>;
}
