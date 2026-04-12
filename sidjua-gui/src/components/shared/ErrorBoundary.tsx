// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import { GUI_ERRORS } from '../../i18n/gui-errors';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In production this would go to a real error tracker
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          role="alert"
          style={{
            padding:         '32px',
            textAlign:       'center',
            color:           'var(--color-danger)',
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: '8px' }}>{GUI_ERRORS['GUI-GENERIC-001'].message}</p>
          <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            {this.state.error?.message ?? GUI_ERRORS['GUI-GENERIC-001'].suggestion}
          </p>
          <button
            onClick={this.handleReset}
            style={{
              padding:         '6px 16px',
              borderRadius:    'var(--radius-md)',
              border:          '1px solid var(--color-border)',
              background:      'var(--color-surface)',
              color:           'var(--color-text)',
              cursor:          'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
