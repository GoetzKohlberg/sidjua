// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { API_PATHS } from '../api/paths';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { useTranslation } from '../hooks/useTranslation';


export function Login() {
  const navigate           = useNavigate();
  const { onLoginSuccess } = useAuth();
  const { t }              = useTranslation();

  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(API_PATHS.authLogin(), {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-SIDJUA-Request': '1',
        },
        body: JSON.stringify({ password }),
      });

      if (res.status === 429) {
        setError('Too many login attempts. Please wait 15 minutes before trying again.');
        return;
      }
      if (res.status === 401) {
        setError('Invalid password. Please try again.');
        return;
      }
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? `Server error (${res.status})`);
        return;
      }

      const data = await res.json() as { ok: boolean; csrfToken: string };
      onLoginSuccess(data.csrfToken);
      navigate('/', { replace: true });
    } catch {
      setError('Network error — please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [password, onLoginSuccess, navigate]);

  return (
    <div style={{
      minHeight:      '100vh',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      background:     'var(--color-bg)',
      padding:        '24px',
    }}>
      <div style={{
        width:        '100%',
        maxWidth:     '380px',
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding:      '36px 32px',
        boxShadow:    'var(--shadow-md)',
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <h1 style={{
            fontSize:   '22px',
            fontWeight: 700,
            color:      'var(--color-text)',
            margin:     0,
          }}>
            SIDJUA
          </h1>
          <p style={{
            fontSize:  '16px',
            color:     'var(--color-text-secondary)',
            marginTop: '6px',
          }}>
            {t('gui.login.subtitle')}
          </p>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          {/* Password */}
          <label style={{ display: 'block', marginBottom: '20px' }}>
            <span style={{
              display:      'block',
              fontSize:     '15px',
              fontWeight:   600,
              color:        'var(--color-text)',
              marginBottom: '6px',
            }}>
              Password
            </span>
            <div style={{ position: 'relative' }}>
              <input
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('gui.login.password_placeholder')}
                autoComplete="current-password"
                autoFocus
                required
                disabled={loading}
                style={{
                  width:        '100%',
                  padding:      '9px 38px 9px 12px',
                  borderRadius: 'var(--radius-md)',
                  border:       '1px solid var(--color-border)',
                  background:   'var(--color-bg)',
                  color:        'var(--color-text)',
                  fontSize:     '16px',
                  boxSizing:    'border-box',
                  outline:      'none',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                tabIndex={-1}
                style={{
                  position:   'absolute',
                  right:      '8px',
                  top:        '50%',
                  transform:  'translateY(-50%)',
                  background: 'none',
                  border:     'none',
                  cursor:     'pointer',
                  color:      'var(--color-text-muted)',
                  fontSize:   '15px',
                  padding:    '2px',
                }}
              >
                {showPass ? '🙈' : '👁'}
              </button>
            </div>
          </label>

          {/* Error */}
          {error && (
            <div style={{
              background:   'var(--color-danger-bg, #fee2e2)',
              border:       '1px solid var(--color-danger)',
              borderRadius: 'var(--radius-md)',
              padding:      '10px 12px',
              fontSize:     '15px',
              color:        'var(--color-danger)',
              marginBottom: '16px',
            }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width:          '100%',
              padding:        '10px',
              borderRadius:   'var(--radius-md)',
              border:         'none',
              background:     loading || !password ? 'var(--color-border)' : 'var(--color-accent)',
              color:          loading || !password ? 'var(--color-text-muted)' : '#fff',
              fontSize:       '16px',
              fontWeight:     600,
              cursor:         loading || !password ? 'default' : 'pointer',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            '8px',
              transition:     'background 0.15s ease',
            }}
          >
            {loading
              ? <><LoadingSpinner size="sm" /> Signing in…</>
              : 'Sign In'
            }
          </button>
        </form>
      </div>
    </div>
  );
}
