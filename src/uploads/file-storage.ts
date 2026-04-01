// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P351 — FileStorage: validated file storage with type/size limits.
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname }                                     from 'node:path';
import { createLogger }                                      from '../core/logger.js';

const logger = createLogger('file-storage');

/** Allowed MIME types and their file extensions. */
const ALLOWED_TYPES = new Map<string, string[]>([
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',   ['.xlsx']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/pdf',            ['.pdf']],
  ['text/csv',                   ['.csv']],
  ['text/tab-separated-values',  ['.tsv']],
  ['text/plain',                 ['.txt', '.md']],
  ['text/markdown',              ['.md']],
  ['image/png',                  ['.png']],
  ['image/jpeg',                 ['.jpg', '.jpeg']],
]);

/** Allowlist of accepted extensions for extension-only validation. */
const ALLOWED_EXTENSIONS = new Set([
  '.xlsx', '.docx', '.pdf', '.csv', '.tsv', '.txt', '.md', '.png', '.jpg', '.jpeg',
]);

export interface FileStorageConfig {
  /** Base directory for uploads. */
  baseDir:      string;
  /** Maximum file size in bytes (default 10 MB). */
  maxSizeBytes: number;
}

const DEFAULT_CONFIG: FileStorageConfig = {
  baseDir:      '/data/uploads',
  maxSizeBytes: 10 * 1024 * 1024,
};

export class FileStorage {
  private readonly config: FileStorageConfig;

  constructor(config?: Partial<FileStorageConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate file before storage.
   * Returns an error message, or null if valid.
   */
  validate(filename: string, _mimetype: string, sizeBytes: number): string | null {
    if (sizeBytes === 0) return 'File is empty';
    if (sizeBytes > this.config.maxSizeBytes) {
      return `File too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, max ${this.config.maxSizeBytes / 1024 / 1024} MB)`;
    }
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `File type not supported: ${ext || '(none)'}. Supported: ${[...ALLOWED_EXTENSIONS].join(', ')}`;
    }
    return null;
  }

  /**
   * Write buffer to disk under baseDir/{agentId}/{timestamp}-{sanitized-filename}.
   * Returns the full file path.
   */
  store(agentId: string, filename: string, buffer: Buffer): string {
    const agentDir = join(this.config.baseDir, agentId);
    mkdirSync(agentDir, { recursive: true });

    // Sanitize: strip path separators, Windows-reserved chars, and dot-dot traversal sequences; cap at 200 chars
    const sanitized  = filename
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\.\./g, '_')
      .slice(0, 200);
    const storedName = `${Date.now()}-${sanitized}`;
    const filePath   = join(agentDir, storedName);

    writeFileSync(filePath, buffer);
    logger.info('file_stored', `Stored ${filename} -> ${filePath}`, {
      metadata: { agentId, sizeBytes: buffer.length },
    });
    return filePath;
  }

  /** Delete a stored file (no-op if it does not exist). */
  delete(filePath: string): void {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

/**
 * Infer MIME type from the file extension.
 * Falls back to application/octet-stream for unknown extensions.
 */
export function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  for (const [mime, exts] of ALLOWED_TYPES) {
    if (exts.includes(ext)) return mime;
  }
  return 'application/octet-stream';
}
