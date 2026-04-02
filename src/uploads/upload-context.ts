// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P354 — UploadContextBuilder
 *
 * Generates system messages describing uploaded files for agent context.
 * Three states: pending (extraction in progress), ready (with preview), failed.
 */

import type { UploadRecord } from './upload-store.js';

const PREVIEW_MAX_CHARS = 2000;

export type UploadContextStatus = 'pending' | 'ready' | 'failed';

export interface UploadContextMessage {
  role: 'system';
  content: string;
  metadata: {
    type:       'file_upload';
    upload_id:  string;
    filename:   string;
    mimetype:   string;
    size_bytes: number;
    status:     UploadContextStatus;
  };
}

/**
 * Build a context message for an uploaded file.
 * Called on first upload (pending) and reflected as-is on subsequent reads
 * because the DB record is always up-to-date.
 */
export function buildUploadContext(upload: UploadRecord): UploadContextMessage {
  const sizeStr = formatSize(upload.size_bytes);
  let content:  string;
  let status:   UploadContextStatus;

  switch (upload.extraction_status) {
    case 'done': {
      status = 'ready';
      const preview = upload.extracted_text
        ? truncatePreview(upload.extracted_text, PREVIEW_MAX_CHARS)
        : '[No text content extracted]';
      content = `User uploaded ${upload.filename} (${sizeStr}). Content preview:\n${preview}`;
      break;
    }
    case 'processing':
    case 'pending': {
      status  = 'pending';
      content = `User uploaded ${upload.filename} (${sizeStr}). Text extraction in progress...`;
      break;
    }
    case 'failed': {
      status  = 'failed';
      content = `User uploaded ${upload.filename} (${sizeStr}). Could not extract text.`;
      break;
    }
    default: {
      status  = 'pending';
      content = `User uploaded ${upload.filename} (${sizeStr}).`;
    }
  }

  return {
    role: 'system',
    content,
    metadata: {
      type:       'file_upload',
      upload_id:  upload.id,
      filename:   upload.filename,
      mimetype:   upload.mimetype,
      size_bytes: upload.size_bytes,
      status,
    },
  };
}

function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[... truncated, ${text.length} chars total]`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
