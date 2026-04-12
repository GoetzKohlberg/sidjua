// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useAppConfig } from '../../lib/config';
import { useTranslation } from '../../hooks/useTranslation';
import { UpdateBanner, MaintenanceBanner } from './UpdateBanners';

function NotConnectedBanner() {
  const navigate = useNavigate();
  const { t }    = useTranslation();
  return (
    <div style={{
      background:   'var(--color-warning-bg)',
      border:       '1px solid var(--color-warning)',
      borderRadius: 'var(--radius-md)',
      padding:      '10px 16px',
      marginBottom: '20px',
      fontSize:     '15px',
      color:        'var(--color-warning)',
      display:      'flex',
      alignItems:   'center',
      gap:          '10px',
    }}>
      <span>{t('gui.shell.not_connected')}</span>
      <button
        onClick={() => navigate('/settings')}
        style={{
          background:     'none',
          border:         '1px solid var(--color-warning)',
          borderRadius:   'var(--radius-sm)',
          color:          'var(--color-warning)',
          cursor:         'pointer',
          padding:        '2px 10px',
          fontSize:       '16px',
          fontWeight:     600,
          whiteSpace:     'nowrap',
        }}
      >
        {t('gui.shell.open_settings')}
      </button>
    </div>
  );
}

export function Shell() {
  const { status, config } = useAppConfig();
  const { t }    = useTranslation();
  const location = useLocation();
  const isSettings = location.pathname === '/settings';
  const showBanner = !isSettings && (status === 'error' || !config.apiKey);

  // Responsive state
  const [isMobile,    setIsMobile]    = useState(() => window.innerWidth <= 767);
  const [isTablet,    setIsTablet]    = useState(() => window.innerWidth <= 1024);
  const [drawerOpen,  setDrawerOpen]  = useState(false);

  useEffect(() => {
    function onResize() {
      const mobile = window.innerWidth <= 767;
      const tablet = window.innerWidth <= 1024;
      setIsMobile(mobile);
      setIsTablet(tablet);
      if (!mobile) setDrawerOpen(false);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function toggleDrawer() {
    setDrawerOpen((prev) => !prev);
  }

  return (
    <div
      style={{
        display:             'grid',
        gridTemplateColumns: isMobile ? '0 1fr' : 'var(--sidebar-width) 1fr',
        gridTemplateRows:    'var(--header-height) 1fr',
        gridTemplateAreas:   `"sidebar header" "sidebar main"`,
        height:              '100vh',
        overflow:            'hidden',
      }}
    >
      {/* Sidebar (overlay drawer on mobile) */}
      <div style={{ gridArea: 'sidebar' }}>
        <Sidebar
          drawerOpen={drawerOpen}
          isMobile={isMobile}
          onClose={() => setDrawerOpen(false)}
        />
      </div>

      {/* Mobile overlay backdrop */}
      {isMobile && drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{
            position:   'fixed',
            inset:      0,
            background: 'var(--color-mobile-overlay)',
            zIndex:     199,
          }}
        />
      )}

      {/* Header */}
      <div style={{ gridArea: 'header', borderBottom: '1px solid var(--color-border)' }}>
        <Header
          showMenuButton={isTablet}
          onMenuToggle={toggleDrawer}
        />
      </div>

      {/* Main content */}
      <main
        style={{
          gridArea:    'main',
          overflowY:   'auto',
          background:  'var(--color-bg)',
          padding:     '24px',
          display:     'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flex: 1 }}>
          {showBanner && <NotConnectedBanner />}
          <UpdateBanner />
          <MaintenanceBanner />
          <Outlet />
        </div>
        <footer
          style={{
            marginTop:  '24px',
            paddingTop: '12px',
            borderTop:  '1px solid var(--color-border)',
            fontSize:   '13px',
            color:      'var(--color-text-muted)',
            textAlign:  'center',
          }}
        >
          <span className="license-notice">
            {t('gui.footer.license')} |{' '}
            <a
              href="https://sidjua.com/license"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
            >
              {t('gui.footer.commercial_license')}
            </a>
          </span>
        </footer>
      </main>
    </div>
  );
}
