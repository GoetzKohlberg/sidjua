// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  ShieldCheck,
  ScrollText,
  DollarSign,
  Settings,
  Cpu,
  Network,
} from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';

interface NavItem {
  to:       string;
  labelKey: string;
  icon:     React.ReactNode;
  badge?:   string | undefined;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/',           labelKey: 'gui.nav.dashboard',  icon: <LayoutDashboard size={18} /> },
  { to: '/chat',       labelKey: 'gui.nav.chat',        icon: <MessageSquare   size={18} /> },
  { to: '/agents',     labelKey: 'gui.nav.organization', icon: <Bot             size={18} />, badge: '6' },
  { to: '/divisions',  labelKey: 'gui.nav.divisions',   icon: <Network         size={18} /> },
  { to: '/governance', labelKey: 'gui.nav.governance',  icon: <ShieldCheck     size={18} /> },
  { to: '/audit',      labelKey: 'gui.nav.audit',       icon: <ScrollText      size={18} /> },
  { to: '/costs',      labelKey: 'gui.nav.costs',       icon: <DollarSign      size={18} /> },
  { to: '/config',     labelKey: 'gui.nav.config',      icon: <Cpu             size={18} /> },
  { to: '/settings',   labelKey: 'gui.nav.settings',    icon: <Settings        size={18} /> },
];

interface SidebarProps {
  /** True when sidebar is showing as an overlay drawer (mobile only). */
  drawerOpen?: boolean | undefined;
  /** True when in mobile breakpoint (≤767px) — sidebar becomes a drawer. */
  isMobile?: boolean | undefined;
  /** Called when the user dismisses the drawer (e.g. clicking a nav link). */
  onClose?: (() => void) | undefined;
}

export function Sidebar({ drawerOpen = false, isMobile = false, onClose }: SidebarProps) {
  const { t } = useTranslation();
  // Collapsed = icon-only mode when viewport ≤ 1024px (and not in drawer mode)
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 1024);

  useEffect(() => {
    function onResize() {
      setCollapsed(window.innerWidth <= 1024);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // In mobile drawer mode, always show full labels
  const showLabels = isMobile ? true : !collapsed;

  // Drawer: positioned fixed as overlay; slide in from left
  const drawerStyle: React.CSSProperties = isMobile ? {
    position:  'fixed',
    left:      0,
    top:       0,
    width:     '220px',
    height:    '100vh',
    zIndex:    200,
    transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)',
    transition: 'transform 0.2s ease',
  } : {};

  return (
    <nav
      aria-label={t('gui.nav.aria_main')}
      style={{
        display:       'flex',
        flexDirection: 'column',
        height:        '100vh',
        background:    'var(--color-sidebar-bg)',
        color:         'var(--color-sidebar-text)',
        userSelect:    'none',
        overflow:      'hidden',
        ...drawerStyle,
      }}
    >
      {/* Logo / wordmark */}
      <div
        style={{
          height:        'var(--header-height)',
          display:       'flex',
          alignItems:    'center',
          justifyContent: showLabels ? 'flex-start' : 'center',
          padding:       showLabels ? '0 20px' : '0',
          fontWeight:    700,
          fontSize:      showLabels ? '16px' : '14px',
          letterSpacing: '0.05em',
          color:         'var(--color-sidebar-logo)',
          borderBottom:  '1px solid var(--color-sidebar-divider)',
          flexShrink:    0,
          transition:    'all var(--transition-base)',
        }}
      >
        {showLabels ? 'SIDJUA' : 'S'}
      </div>

      {/* Nav items */}
      <ul
        style={{
          listStyle: 'none',
          padding:   showLabels ? '12px 8px' : '12px 4px',
          flex:      1,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {NAV_ITEMS.map(({ to, labelKey, icon, badge }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === '/'}
              title={showLabels ? undefined : t(labelKey)}
              onClick={isMobile ? onClose : undefined}
              style={({ isActive }) => ({
                display:        'flex',
                alignItems:     'center',
                justifyContent: showLabels ? 'flex-start' : 'center',
                gap:            '10px',
                padding:        showLabels ? '8px 12px' : '10px',
                borderRadius:   'var(--radius-md)',
                color:          isActive ? 'var(--color-sidebar-logo)' : 'var(--color-sidebar-text)',
                background:     isActive ? 'var(--color-sidebar-active)' : 'transparent',
                fontWeight:     isActive ? 600 : 400,
                fontSize:       '14px',
                textDecoration: 'none',
                transition:     'background var(--transition-fast), color var(--transition-fast)',
                marginBottom:   '2px',
                whiteSpace:     'nowrap',
              })}
            >
              {icon}
              {showLabels && (
                <>
                  <span style={{ flex: 1 }}>{t(labelKey)}</span>
                  {badge && (
                    <span style={{
                      background:   'var(--color-sidebar-badge-bg)',
                      borderRadius: '999px',
                      fontSize:     '10px',
                      fontWeight:   700,
                      padding:      '1px 6px',
                      minWidth:     '18px',
                      textAlign:    'center',
                    }}>
                      {badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {/* Version footer */}
      {showLabels && (
        <div
          style={{
            padding:    '12px 20px',
            fontSize:   '11px',
            color:      'var(--color-sidebar-footer-text)',
            borderTop:  '1px solid var(--color-sidebar-divider)',
            flexShrink: 0,
          }}
        >
          v{import.meta.env.VITE_APP_VERSION ?? '1.0.0'}
        </div>
      )}
    </nav>
  );
}
