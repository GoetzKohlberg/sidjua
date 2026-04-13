// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P351 — ChatUploadZone: drag-and-drop wrapper + paperclip upload button.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';

export interface UploadResult {
  upload_id:         string;
  filename:          string;
  size_bytes:        number;
  mimetype:          string;
  extraction_status: string;
}

interface ChatUploadZoneProps {
  agentId:            string;
  conversationId?:    string;
  baseUrl:            string;
  authHeaders:        () => Record<string, string>;
  onUploadComplete?:  (upload: UploadResult) => void;
  disabled?:          boolean;
  children:           React.ReactNode;
}

const ACCEPTED_TYPES = '.xlsx,.docx,.pdf,.csv,.tsv,.txt,.md,.png,.jpg,.jpeg';

export function ChatUploadZone({
  agentId,
  conversationId,
  baseUrl,
  authHeaders,
  onUploadComplete,
  disabled,
  children,
}: ChatUploadZoneProps) {
  const { t }                                  = useTranslation();
  const [isDragging,      setIsDragging]      = useState(false);
  const [uploading,       setUploading]       = useState(false);
  const [uploadProgress,  setUploadProgress]  = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setError(null);
    setUploadProgress(`Uploading ${file.name}…`);

    try {
      // Sanitize filename to prevent path traversal or injection via Content-Disposition
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const formData = new FormData();
      formData.append('file', file, safeName);
      if (conversationId) formData.append('conversation_id', conversationId);

      const res = await fetch(`${baseUrl}/api/v1/chat/${agentId}/upload`, {
        method:  'POST',
        headers: authHeaders(),
        body:    formData,
      });

      if (!res.ok) {
        // Use a generic message — don't surface internal server details (e.g. paths, status codes).
        // 413 = file too large; 415 = unsupported type — provide hints without leaking internals.
        const userMsg = res.status === 413
          ? 'File is too large. Please upload a smaller file.'
          : res.status === 415
            ? 'Unsupported file type.'
            : 'Upload failed. Please try again.';
        throw new Error(userMsg);
      }

      const result = await res.json() as UploadResult;
      setUploadProgress(null);
      onUploadComplete?.(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  }, [agentId, conversationId, baseUrl, authHeaders, onUploadComplete, uploading]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled) return;
    const files = e.dataTransfer.files;
    if (files.length > 0) void handleUpload(files[0]!);
  }, [disabled, handleUpload]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) void handleUpload(files[0]!);
    // Reset so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleUpload]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div style={{
          position:       'absolute',
          inset:          0,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          gap:            '8px',
          background:     'rgba(0,0,0,0.5)',
          border:         '2px dashed var(--color-accent)',
          borderRadius:   'var(--radius-md)',
          color:          'var(--color-accent)',
          fontWeight:     500,
          fontSize:       '16px',
          zIndex:         10,
          pointerEvents:  'none',
        }}>
          {/* paperclip-ish upload icon */}
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          {t('gui.chat.drop_file')}
        </div>
      )}

      {/* Upload progress */}
      {uploadProgress !== null && (
        <div style={{
          display:      'flex',
          alignItems:   'center',
          gap:          '8px',
          padding:      '6px 12px',
          background:   'var(--color-surface-alt)',
          borderRadius: 'var(--radius-md)',
          fontSize:     '15px',
          marginBottom: '4px',
          color:        'var(--color-text)',
        }}>
          <div style={{
            width:       '14px',
            height:      '14px',
            border:      '2px solid var(--color-accent)',
            borderTopColor: 'transparent',
            borderRadius:   '50%',
            animation:   'sjg-spin 0.8s linear infinite',
            flexShrink:  0,
          }} />
          {uploadProgress}
        </div>
      )}

      {/* Error banner */}
      {error !== null && (
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '6px 12px',
          background:     'var(--color-error-bg, #fef2f2)',
          color:          'var(--color-error, #dc2626)',
          borderRadius:   'var(--radius-md)',
          fontSize:       '15px',
          marginBottom:   '4px',
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border:     'none',
              cursor:     'pointer',
              color:      'inherit',
              padding:    '0 0 0 8px',
              fontSize:   '18px',
              lineHeight: 1,
            }}
          >×</button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      {/* Inject openFilePicker + uploading state to children via cloneElement */}
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
              onOpenFilePicker: openFilePicker,
              uploadInProgress: uploading,
            })
          : child,
      )}
    </div>
  );
}

/** Paperclip upload button — placed next to the send button in ChatInput. */
export function PaperclipButton({
  onClick,
  disabled,
}: {
  onClick:   () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={t('gui.chat.upload_file_types_title')}
      aria-label={t('gui.chat.aria_upload_file')}
      style={{
        background:   'none',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        cursor:       disabled ? 'not-allowed' : 'pointer',
        padding:      '0 10px',
        height:       '40px',
        display:      'flex',
        alignItems:   'center',
        color:        disabled ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
        opacity:      disabled ? 0.5 : 1,
        flexShrink:   0,
        transition:   'background 0.15s ease',
      }}
    >
      {/* Paperclip icon */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
      </svg>
    </button>
  );
}
