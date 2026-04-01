// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';

export class CsvExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return (
      ext === '.csv' ||
      ext === '.tsv' ||
      mimetype.includes('csv') ||
      mimetype.includes('tab-separated')
    );
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    const text  = buffer.toString('utf-8').trim();
    const lines = text.split(/\r?\n/);
    const isTsv = filename.endsWith('.tsv');

    return {
      text,
      metadata: {
        rows:  Math.max(0, lines.length - 1),
        isTsv,
      },
    };
  }
}
