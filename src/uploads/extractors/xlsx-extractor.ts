// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { FileExtractor, ExtractionResult } from './types.js';

export class XlsxExtractor implements FileExtractor {
  supports(mimetype: string, ext: string): boolean {
    return ext === '.xlsx' || ext === '.xls' || mimetype.includes('spreadsheet');
  }

  async extract(buffer: Buffer, _filename: string): Promise<ExtractionResult> {
    let XLSX: typeof import('xlsx');
    try {
      XLSX = await import('xlsx');
    } catch (_e) {
      throw new Error('XLSX extraction requires the "xlsx" package');
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    let totalCells = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      if (rows.length === 0) continue;

      parts.push(`--- Sheet: ${sheetName} (${rows.length} rows) ---`);
      const headers = Object.keys(rows[0]!);
      parts.push(headers.join('\t'));

      for (const row of rows) {
        const values = headers.map((h) => String(row[h] ?? ''));
        parts.push(values.join('\t'));
        totalCells += values.length;
      }
      parts.push('');
    }

    return {
      text:     parts.join('\n'),
      metadata: { sheets: workbook.SheetNames.length, totalCells },
    };
  }
}
