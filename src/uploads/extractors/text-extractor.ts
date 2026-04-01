// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';

export class TextExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return ['.txt', '.md'].includes(ext) || mimetype.startsWith('text/');
  }

  async extract(buffer: Buffer, _filename: string): Promise<ExtractionResult> {
    const text = buffer.toString('utf-8').trim();
    return {
      text,
      metadata: { lines: text.split('\n').length },
    };
  }
}
