// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P351 — FileReferenceCard: renders an uploaded file in the chat stream.
 */

import React from 'react';

interface FileReferenceCardProps {
  filename:          string;
  sizeBytes:         number;
  mimetype:          string;
  extractionStatus?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ mimetype }: { mimetype: string }) {
  if (mimetype.startsWith('image/')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    );
  }
  if (mimetype.includes('spreadsheet') || mimetype.includes('csv') || mimetype.includes('tab-separated')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
      </svg>
    );
  }
  if (mimetype.includes('pdf') || mimetype.includes('word')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    );
  }
  // Generic file icon
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
      <polyline points="13 2 13 9 20 9"/>
    </svg>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'pending') {
    return <span style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>pending</span>;
  }
  if (status === 'done') {
    return <span style={{ color: 'var(--color-success, #22c55e)', fontSize: '13px' }}>✓ extracted</span>;
  }
  if (status === 'processing') {
    return <span style={{ color: 'var(--color-accent)', fontSize: '13px' }}>processing…</span>;
  }
  if (status === 'failed') {
    return <span style={{ color: 'var(--color-error, #dc2626)', fontSize: '13px' }}>extraction failed</span>;
  }
  return null;
}

export function FileReferenceCard({
  filename,
  sizeBytes,
  mimetype,
  extractionStatus,
}: FileReferenceCardProps) {
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          '10px',
      padding:      '8px 12px',
      background:   'var(--color-surface-alt)',
      border:       '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      maxWidth:     '320px',
      marginTop:    '4px',
    }}>
      <div style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>
        <FileIcon mimetype={mimetype} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{
          fontSize:     '15px',
          fontWeight:   500,
          whiteSpace:   'nowrap',
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          color:        'var(--color-text)',
        }}>
          {filename}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
          <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
            {formatSize(sizeBytes)}
          </span>
          <StatusBadge status={extractionStatus} />
        </div>
      </div>
    </div>
  );
}
