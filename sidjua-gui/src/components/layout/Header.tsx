// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import { ChevronRight, Menu, Power } from 'lucide-react';
import { ThemeToggle } from '../shared/ThemeToggle';
import { LanguageSelector } from '../shared/LanguageSelector';
import { useAppConfig } from '../../lib/config';
import type { ConnectionStatus } from '../../lib/config';
import { SseStatusIndicator } from '../shared/SseStatusIndicator';
import { useSse } from '../../hooks/useSse';
import { useTranslation } from '../../hooks/useTranslation';


interface Crumb { label: string; to: string; }

function getCrumbs(pathname: string, t: (key: string) => string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [{ label: t('gui.breadcrumb.dashboard'), to: '/' }];

  const LABELS: Record<string, string> = {
    agents:     t('gui.breadcrumb.agents'),
    divisions:  t('gui.breadcrumb.divisions'),
    governance: t('gui.breadcrumb.governance'),
    audit:      t('gui.breadcrumb.audit'),
    costs:      t('gui.breadcrumb.costs'),
    config:     t('gui.breadcrumb.config'),
    settings:   t('gui.breadcrumb.settings'),
    chat:       t('gui.breadcrumb.chat'),
  };

  const crumbs: Crumb[] = [{ label: t('gui.breadcrumb.dashboard'), to: '/' }];
  let path = '';
  for (const seg of segments) {
    path += `/${seg}`;
    crumbs.push({ label: LABELS[seg] ?? seg, to: path });
  }
  return crumbs;
}


function ConnectionIndicator({ status, t }: { status: ConnectionStatus; t: (key: string) => string }) {
  const MAP = {
    connected: { color: 'var(--color-success)', label: t('gui.connection.connected')    },
    checking:  { color: 'var(--color-warning)', label: t('gui.connection.checking')     },
    error:     { color: 'var(--color-danger)',  label: t('gui.connection.disconnected') },
    unknown:   { color: 'var(--color-text-muted)', label: t('gui.connection.unknown')   },
  } as const;

  const { color, label } = MAP[status];

  return (
    <span
      title={label}
      aria-label={t('gui.connection.status_aria').replace('{status}', label)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '15px', color: 'var(--color-text-secondary)' }}
    >
      <span
        aria-hidden
        style={{
          width:        '8px',
          height:       '8px',
          borderRadius: '50%',
          background:   color,
          flexShrink:   0,
        }}
      />
      {label}
    </span>
  );
}


interface HeaderProps {
  /** Show the hamburger menu button (tablet/mobile breakpoints). */
  showMenuButton?: boolean | undefined;
  /** Called when the hamburger button is clicked. */
  onMenuToggle?: (() => void) | undefined;
}

export function Header({ showMenuButton = false, onMenuToggle }: HeaderProps) {
  const location      = useLocation();
  const { status, config, buildInfo } = useAppConfig();
  const { status: sseStatus } = useSse();
  const { t }         = useTranslation();
  const crumbs        = getCrumbs(location.pathname, t);

  return (
    <header
      style={{
        height:          'var(--header-height)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
        padding:         '0 24px',
        background:      'var(--color-surface)',
        gap:             '12px',
      }}
    >
      {/* Hamburger button — visible at tablet/mobile breakpoints */}
      {showMenuButton && (
        <button
          onClick={onMenuToggle}
          aria-label={t('gui.connection.menu_toggle_aria')}
          style={{
            display:      'inline-flex',
            alignItems:   'center',
            justifyContent: 'center',
            background:   'none',
            border:       'none',
            borderRadius: 'var(--radius-sm)',
            color:        'var(--color-text-secondary)',
            cursor:       'pointer',
            padding:      '6px',
            flexShrink:   0,
          }}
        >
          <Menu size={20} />
        </button>
      )}

      {/* Home link */}
      <Link
        to="/"
        style={{
          textDecoration: 'none',
          color:          'var(--color-accent)',
          fontWeight:     700,
          fontSize:       '17px',
          flexShrink:     0,
          letterSpacing:  '-0.02em',
        }}
      >
        SIDJUA
      </Link>

      {/* Breadcrumbs */}
      <nav aria-label={t('gui.breadcrumb.aria')} style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <React.Fragment key={crumb.to}>
              {i > 0 && (
                <ChevronRight
                  size={14}
                  aria-hidden
                  style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}
                />
              )}
              {isLast ? (
                <span style={{ fontSize: '17px', fontWeight: 600, color: 'var(--color-text)' }}>
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.to}
                  style={{ fontSize: '15px', color: 'var(--color-text-secondary)', textDecoration: 'none' }}
                >
                  {crumb.label}
                </Link>
              )}
            </React.Fragment>
          );
        })}
      </nav>

      {/* Right side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {buildInfo && (
          <span
            title={buildInfo.buildDate ?? undefined}
            style={{ fontSize: '13px', color: 'var(--color-text-muted)', fontFamily: 'monospace', userSelect: 'none' }}
          >
            v{buildInfo.version}{buildInfo.buildNumber ? `-${buildInfo.buildNumber}` : ''}
          </span>
        )}
        <span
          title={t('gui.shutdown_reminder')}
          style={{ display: 'inline-flex', cursor: 'help', flexShrink: 0 }}
        >
          <Power size={14} style={{ color: 'var(--color-text-muted)' }} />
        </span>
        <ConnectionIndicator status={status} t={t} />
        {config.apiKey && <SseStatusIndicator status={sseStatus} />}
        <LanguageSelector />
        <ThemeToggle />
      </div>
    </header>
  );
}
