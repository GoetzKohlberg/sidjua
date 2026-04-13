// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA GUI — LanguageSelector component (P191/P192)
 *
 * Globe icon + current locale code button that opens a dropdown
 * listing all available languages grouped by region.
 * AI-generated translations are marked with "(AI)".
 * Human-maintained translations (en, de) have no indicator.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useToast } from './Toast';
import { useAppConfig } from '../../lib/config';
import { LOCALE_REGISTRY, REGION_ORDER } from '../../i18n/locale-registry';


function GlobeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}




export function LanguageSelector() {
  const { locale, setLocale, t } = useTranslation();
  const { config }                = useAppConfig();
  const toast                     = useToast();
  const [open, setOpen]           = useState(false);
  const [available, setAvailable] = useState<string[]>(Object.keys(LOCALE_REGISTRY));
  const containerRef              = useRef<HTMLDivElement>(null);

  // Fetch available locales from the API on mount
  useEffect(() => {
    const serverUrl = config.serverUrl || window.location.origin;
    fetch(`${serverUrl}/api/v1/locale`)
      .then((res) => res.ok ? res.json() as Promise<{ available: string[] }> : null)
      .then((data) => { if (data?.available) setAvailable(data.available); })
      .catch(() => { /* silent — fall back to default */ });
  }, [config.serverUrl]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function handleSelect(code: string) {
    setOpen(false);
    if (code !== locale) {
      const { serverPersisted } = await setLocale(code);
      if (!serverPersisted) {
        toast.info(t('gui.locale.server_restricted'));
      }
    }
  }

  // Group available locales by region
  const byRegion: Record<string, string[]> = {};
  for (const code of available) {
    const region = LOCALE_REGISTRY[code]?.region ?? 'Other';
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push(code);
  }
  const regions = REGION_ORDER.filter((r) => byRegion[r]?.length);
  if (byRegion['Other']?.length) regions.push('Other');

  const currentMeta = LOCALE_REGISTRY[locale];

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t('gui.locale.selector_aria')}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t('gui.locale.selector_aria')}
        style={{
          display:         'inline-flex',
          alignItems:      'center',
          gap:             '5px',
          height:          '32px',
          padding:         '0 8px',
          border:          '1px solid var(--color-border)',
          borderRadius:    'var(--radius-md)',
          backgroundColor: 'var(--color-surface)',
          color:           'var(--color-text-secondary)',
          fontSize:        '16px',
          fontWeight:      600,
          letterSpacing:   '0.04em',
          cursor:          'pointer',
          transition:      'all var(--transition-fast)',
        }}
      >
        <GlobeIcon />
        <span>{currentMeta?.nativeName?.slice(0, 6) ?? locale.toUpperCase()}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="listbox"
          aria-label={t('gui.locale.selector_aria')}
          style={{
            position:   'absolute',
            right:      0,
            top:        '36px',
            zIndex:     300,
            width:      '220px',
            maxHeight:  '400px',
            overflowY:  'auto',
            background: 'var(--color-surface)',
            border:     '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow:  'var(--shadow-md)',
            padding:    '4px',
          }}
        >
          {regions.map((region) => (
            <div key={region}>
              {/* Region header */}
              <div style={{
                padding:    '6px 10px 3px',
                fontSize:   '14px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color:      'var(--color-text-muted)',
                textTransform: 'uppercase',
              }}>
                {region}
              </div>

              {/* Languages in this region */}
              {(byRegion[region] ?? []).map((code) => {
                const meta      = LOCALE_REGISTRY[code];
                const isSelected = code === locale;
                return (
                  <div key={code} role="option" aria-selected={isSelected}>
                    <button
                      onClick={() => handleSelect(code)}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          '6px',
                        width:        '100%',
                        padding:      '6px 10px',
                        background:   isSelected ? 'var(--color-sidebar-active)' : 'transparent',
                        border:       'none',
                        borderRadius: 'var(--radius-sm)',
                        color:        isSelected ? 'var(--color-sidebar-logo)' : 'var(--color-text)',
                        fontSize:     '15px',
                        fontWeight:   isSelected ? 600 : 400,
                        cursor:       'pointer',
                        textAlign:    'left',
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        {meta?.nativeName ?? code}
                        {' '}
                        <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
                          ({meta?.name ?? code})
                        </span>
                      </span>
                      {meta?.aiGenerated && (
                        <span style={{
                          fontSize:     '11px',
                          fontWeight:   700,
                          color:        'var(--color-text-muted)',
                          background:   'var(--color-border)',
                          borderRadius: '3px',
                          padding:      '1px 4px',
                          flexShrink:   0,
                        }}>
                          AI
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
