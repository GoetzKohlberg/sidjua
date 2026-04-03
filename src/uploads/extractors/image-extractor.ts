// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('ocr');

export class ImageExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return ['.png', '.jpg', '.jpeg'].includes(ext) || mimetype.startsWith('image/');
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    // tesseract.js v7: terminate() returns Promise<ConfigResult>, not void
    let createWorker: (lang: string) => Promise<{
      recognize: (buf: Buffer) => Promise<{ data: { text: string; confidence: number } }>;
      terminate: () => Promise<unknown>;
    }>;

    try {
      const tesseract = await import('tesseract.js');
      createWorker = tesseract.createWorker as typeof createWorker;
    } catch (_e) {
      throw new Error('Image OCR requires the "tesseract.js" package');
    }

    logger.info('ocr_start', `Starting OCR for ${filename} (${buffer.length} bytes)`, {});

    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      const text     = data.text.trim();
      logger.info('ocr_done', `OCR complete for ${filename}: ${text.length} chars`, {
        metadata: { confidence: data.confidence },
      });
      return {
        text,
        metadata: { confidence: data.confidence, language: 'eng' },
      };
    } finally {
      await worker.terminate();
    }
  }
}
