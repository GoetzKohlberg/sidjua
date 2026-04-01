// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';

export class DocxExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return ext === '.docx' || mimetype.includes('wordprocessing');
  }

  async extract(buffer: Buffer, _filename: string): Promise<ExtractionResult> {
    let mammoth: typeof import('mammoth');
    try {
      mammoth = await import('mammoth');
    } catch (_e) {
      throw new Error('DOCX extraction requires the "mammoth" package');
    }

    const mod    = (mammoth as { default?: typeof mammoth } & typeof mammoth).default ?? mammoth;
    const result = await mod.extractRawText({ buffer });
    const text   = result.value.trim();
    const warnings = result.messages.filter(
      (m: { type: string }) => m.type === 'warning',
    ).length;

    return {
      text,
      metadata: { paragraphs: text.split('\n\n').length, warnings },
    };
  }
}
