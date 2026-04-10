// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { API_PATHS } from '../api/paths';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';


const MIN_PASSWORD_LENGTH = 12;

export function Setup() {
  const navigate           = useNavigate();
  const { onLoginSuccess } = useAuth();

  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [showPass,  setShowPass]  = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(API_PATHS.authSetup(), {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-SIDJUA-Request': '1',
        },
        body: JSON.stringify({ password }),
      });

      if (res.status === 409) {
        setError('Setup already completed. Please log in.');
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
  }, [password, confirm, onLoginSuccess, navigate]);

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
        maxWidth:     '420px',
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding:      '36px 32px',
        boxShadow:    'var(--shadow-md)',
      }}>
        {/* Logo / Title */}
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
            fontSize:  '14px',
            color:     'var(--color-text-secondary)',
            marginTop: '6px',
          }}>
            Set an admin password to continue
          </p>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          {/* Password */}
          <label style={{ display: 'block', marginBottom: '16px' }}>
            <span style={{
              display:      'block',
              fontSize:     '13px',
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
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
                required
                disabled={loading}
                style={{
                  width:        '100%',
                  padding:      '9px 38px 9px 12px',
                  borderRadius: 'var(--radius-md)',
                  border:       '1px solid var(--color-border)',
                  background:   'var(--color-bg)',
                  color:        'var(--color-text)',
                  fontSize:     '14px',
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
                  fontSize:   '13px',
                  padding:    '2px',
                }}
              >
                {showPass ? '🙈' : '👁'}
              </button>
            </div>
          </label>

          {/* Confirm */}
          <label style={{ display: 'block', marginBottom: '20px' }}>
            <span style={{
              display:      'block',
              fontSize:     '13px',
              fontWeight:   600,
              color:        'var(--color-text)',
              marginBottom: '6px',
            }}>
              Confirm password
            </span>
            <input
              type={showPass ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              autoComplete="new-password"
              required
              disabled={loading}
              style={{
                width:        '100%',
                padding:      '9px 12px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-border)',
                background:   'var(--color-bg)',
                color:        'var(--color-text)',
                fontSize:     '14px',
                boxSizing:    'border-box',
                outline:      'none',
              }}
            />
          </label>

          {/* Error */}
          {error && (
            <div style={{
              background:   'var(--color-danger-bg, #fee2e2)',
              border:       '1px solid var(--color-danger)',
              borderRadius: 'var(--radius-md)',
              padding:      '10px 12px',
              fontSize:     '13px',
              color:        'var(--color-danger)',
              marginBottom: '16px',
            }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !password || !confirm}
            style={{
              width:        '100%',
              padding:      '10px',
              borderRadius: 'var(--radius-md)',
              border:       'none',
              background:   loading || !password || !confirm ? 'var(--color-border)' : 'var(--color-accent)',
              color:        loading || !password || !confirm ? 'var(--color-text-muted)' : '#fff',
              fontSize:     '14px',
              fontWeight:   600,
              cursor:       loading || !password || !confirm ? 'default' : 'pointer',
              display:      'flex',
              alignItems:   'center',
              justifyContent: 'center',
              gap:          '8px',
              transition:   'background 0.15s ease',
            }}
          >
            {loading
              ? <><LoadingSpinner size="sm" /> Setting up…</>
              : 'Set Password & Continue'
            }
          </button>
        </form>

        <p style={{
          marginTop:  '20px',
          fontSize:   '12px',
          color:      'var(--color-text-muted)',
          textAlign:  'center',
          lineHeight: 1.5,
        }}>
          This password protects access to the SIDJUA admin interface.
          Store it securely.
        </p>
      </div>
    </div>
  );
}
