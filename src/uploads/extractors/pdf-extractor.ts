// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';

export class PdfExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return ext === '.pdf' || mimetype === 'application/pdf';
  }

  async extract(buffer: Buffer, _filename: string): Promise<ExtractionResult> {
    // pdf-parse v2 API: new PDFParse({ data: buffer }) + getText()
    let PDFParseClass: new (opts: { data: Buffer }) => {
      getText: () => Promise<{ text: string; total?: number; pages?: unknown[] }>;
    };

    try {
      const mod = await import('pdf-parse');
      // ESM named export: { PDFParse }
      const modAny = mod as Record<string, unknown>;
      PDFParseClass = (modAny['PDFParse'] ?? modAny['default']) as typeof PDFParseClass;
      if (typeof PDFParseClass !== 'function') {
        throw new Error('PDFParse constructor not found in pdf-parse module');
      }
    } catch (_e) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      throw new Error(`PDF extraction requires the "pdf-parse" package: ${msg}`);
    }

    const parser = new PDFParseClass({ data: buffer });
    const result = await parser.getText();

    // v2 API: result.total = page count, result.pages = array of page objects
    const pageCount = result.total ?? result.pages?.length ?? 0;
    return {
      text:     (result.text ?? '').trim(),
      metadata: { pages: pageCount },
    };
  }
}
