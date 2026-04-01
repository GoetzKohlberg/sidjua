// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P352 — ExtractionService: async text extraction after file upload.
 *
 * Dispatches to format-specific FileExtractor implementations.
 * Updates uploads.extracted_text and extraction_status in SQLite.
 * Emits SSE extraction_complete event on completion or failure.
 */

import { readFileSync }  from 'node:fs';
import { extname }       from 'node:path';
import { createLogger }  from '../core/logger.js';
import type { UploadStore } from './upload-store.js';
import type { FileExtractor } from './extractors/types.js';
import { XlsxExtractor }  from './extractors/xlsx-extractor.js';
import { DocxExtractor }  from './extractors/docx-extractor.js';
import { PdfExtractor }   from './extractors/pdf-extractor.js';
import { CsvExtractor }   from './extractors/csv-extractor.js';
import { ImageExtractor } from './extractors/image-extractor.js';
import { TextExtractor }  from './extractors/text-extractor.js';

const logger = createLogger('extraction');

/** Maximum extracted text stored in DB (500 K chars). */
const MAX_TEXT_LENGTH = 500_000;

export class ExtractionService {
  private readonly extractors: FileExtractor[];

  constructor(
    private readonly uploadStore: UploadStore,
    private readonly emitEvent?: (event: Record<string, unknown>) => void,
  ) {
    // More-specific extractors first; TextExtractor is the catch-all for text/*
    this.extractors = [
      new XlsxExtractor(),
      new DocxExtractor(),
      new PdfExtractor(),
      new CsvExtractor(),
      new ImageExtractor(),
      new TextExtractor(),
    ];
  }

  /**
   * Process a single upload: read file → extract text → persist result.
   * Best-effort: failures are recorded in DB and logged, never thrown.
   */
  async processUpload(uploadId: string): Promise<void> {
    const upload = this.uploadStore.getById(uploadId);
    if (!upload) {
      logger.warn('extraction_skip', `Upload ${uploadId} not found`, {});
      return;
    }

    if (upload.extraction_status === 'done') {
      logger.info('extraction_skip', `Upload ${uploadId} already extracted`, {});
      return;
    }

    this.uploadStore.updateExtractionStatus(uploadId, 'processing');

    try {
      const ext       = extname(upload.filename).toLowerCase();
      const extractor = this.extractors.find((e) => e.supports(upload.mimetype, ext));

      if (!extractor) {
        throw new Error(`No extractor for ${upload.mimetype} / ${ext}`);
      }

      const buffer = readFileSync(upload.file_path);
      const result = await extractor.extract(buffer, upload.filename);

      let text = result.text;
      if (text.length > MAX_TEXT_LENGTH) {
        text =
          text.slice(0, MAX_TEXT_LENGTH) +
          `\n\n[Truncated: ${text.length} chars total, showing first ${MAX_TEXT_LENGTH}]`;
      }

      this.uploadStore.updateExtractionStatus(uploadId, 'done', text);

      logger.info('extraction_done', `Extracted ${text.length} chars from ${upload.filename}`, {
        metadata: { uploadId, ext, ...result.metadata },
      });

      this.emitEvent?.({
        type: 'extraction_complete',
        data: {
          upload_id:   uploadId,
          agent_id:    upload.agent_id,
          filename:    upload.filename,
          text_length: text.length,
          status:      'done',
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Pass undefined so updateExtractionStatus only updates the status column
      this.uploadStore.updateExtractionStatus(uploadId, 'failed');

      logger.error('extraction_failed', `Failed to extract ${upload.filename}: ${errorMsg}`, {
        metadata: { uploadId, error: errorMsg },
      });

      this.emitEvent?.({
        type: 'extraction_complete',
        data: {
          upload_id: uploadId,
          agent_id:  upload.agent_id,
          filename:  upload.filename,
          status:    'failed',
          error:     errorMsg,
        },
      });
    }
  }

  /**
   * Re-process all pending/processing uploads.
   * Called on boot to recover from a previous crash mid-extraction.
   */
  async processPending(): Promise<number> {
    const pending = this.uploadStore.getPending();
    for (const upload of pending) {
      await this.processUpload(upload.id);
    }
    return pending.length;
  }
}
