// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Toast notification system
 *
 * Provides a context-based toast stack with auto-dismiss, progress bar,
 * and optional undo button. Up to 3 toasts visible at a time.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';


export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  type?:       ToastType;
  /** Duration in ms. 0 = manual dismiss only. Default: 3000 (7000 if onUndo set) */
  duration?:   number;
  undoLabel?:  string;
  onUndo?:     () => void;
}

interface ToastEntry {
  id:         string;
  message:    string;
  type:       ToastType;
  duration:   number;
  undoLabel?: string;
  onUndo?:    () => void;
}

interface ToastContextValue {
  toasts:  ToastEntry[];
  show:    (message: string, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
}


const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS       = 3;
const DEFAULT_DURATION = 3_000;
const UNDO_DURATION    = 7_000;


export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const show = useCallback((message: string, opts: ToastOptions = {}): string => {
    const id       = crypto.randomUUID();
    const type     = opts.type ?? 'info';
    const duration = opts.duration !== undefined
      ? opts.duration
      : (opts.onUndo ? UNDO_DURATION : DEFAULT_DURATION);

    const entry: ToastEntry = { id, message, type, duration, undoLabel: opts.undoLabel, onUndo: opts.onUndo };

    setToasts((prev) => {
      const next = [...prev, entry];
      return next.slice(-MAX_TOASTS);
    });

    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toasts, show, dismiss }}>
      {children}
      <ToastStack />
    </ToastContext.Provider>
  );
}


function ToastStack() {
  const ctx = useContext(ToastContext)!;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position:      'fixed',
        bottom:        '24px',
        right:         '24px',
        display:       'flex',
        flexDirection: 'column',
        gap:           '10px',
        zIndex:        9999,
        pointerEvents: 'none',
      }}
    >
      {ctx.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={ctx.dismiss} />
      ))}
    </div>
  );
}


const TYPE_ICONS: Record<ToastType, React.ReactElement> = {
  success: <CheckCircle size={16} />,
  error:   <XCircle     size={16} />,
  warning: <AlertTriangle size={16} />,
  info:    <Info         size={16} />,
};

const TYPE_BORDER: Record<ToastType, string> = {
  success: 'var(--color-success)',
  error:   'var(--color-danger)',
  warning: 'var(--color-warning)',
  info:    'var(--color-info)',
};

const TYPE_BG: Record<ToastType, string> = {
  success: 'var(--color-success-bg)',
  error:   'var(--color-danger-bg)',
  warning: 'var(--color-warning-bg)',
  info:    'var(--color-info-bg)',
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast:     ToastEntry;
  onDismiss: (id: string) => void;
}) {
  const borderColor = TYPE_BORDER[toast.type];
  const bgColor     = TYPE_BG[toast.type];

  // Track progress for the shrinking bar
  const [progress, setProgress] = useState(100);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (toast.duration <= 0) return;
    const raf = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      setProgress(Math.max(0, 100 - (elapsed / toast.duration) * 100));
    }, 50);
    return () => clearInterval(raf);
  }, [toast.duration]);

  function handleUndo() {
    toast.onUndo?.();
    onDismiss(toast.id);
  }

  return (
    <div
      role="alert"
      style={{
        pointerEvents: 'all',
        minWidth:      '280px',
        maxWidth:      '400px',
        background:    'var(--color-surface)',
        border:        `1px solid ${borderColor}`,
        borderLeft:    `4px solid ${borderColor}`,
        borderRadius:  'var(--radius-md)',
        boxShadow:     'var(--shadow-md)',
        overflow:      'hidden',
        animation:     'toastIn 200ms ease',
      }}
    >
      {/* Body */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px' }}>
        <span style={{ color: borderColor, flexShrink: 0, marginTop: '1px' }}>
          {TYPE_ICONS[toast.type]}
        </span>
        <span style={{ fontSize: '15px', color: 'var(--color-text)', flex: 1, lineHeight: 1.4 }}>
          {toast.message}
        </span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          {toast.onUndo && (
            <button
              onClick={handleUndo}
              style={{
                padding:      '2px 10px',
                borderRadius: 'var(--radius-sm)',
                border:       `1px solid ${borderColor}`,
                background:   bgColor,
                color:        borderColor,
                fontSize:     '16px',
                fontWeight:   600,
                cursor:       'pointer',
              }}
            >
              {toast.undoLabel ?? 'Undo'}
            </button>
          )}
          <button
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            style={{
              background: 'none',
              border:     'none',
              cursor:     'pointer',
              color:      'var(--color-text-muted)',
              padding:    '0',
              display:    'flex',
              alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {toast.duration > 0 && (
        <div style={{ height: '2px', background: 'var(--color-border)' }}>
          <div
            style={{
              height:     '100%',
              width:      `${progress}%`,
              background: borderColor,
              transition: 'width 50ms linear',
            }}
          />
        </div>
      )}
    </div>
  );
}


export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');

  // Memoize so the returned object is stable across re-renders.
  // Without this, callers that include the toast object in useCallback deps
  // would create new callbacks on every render, triggering infinite useEffect loops.
  return useMemo(() => ({
    show:    ctx.show,
    dismiss: ctx.dismiss,
    success: (msg: string, opts?: Omit<ToastOptions, 'type'>) =>
      ctx.show(msg, { ...opts, type: 'success' }),
    error: (msg: string, opts?: Omit<ToastOptions, 'type'>) =>
      ctx.show(msg, { ...opts, type: 'error' }),
    warning: (msg: string, opts?: Omit<ToastOptions, 'type'>) =>
      ctx.show(msg, { ...opts, type: 'warning' }),
    info: (msg: string, opts?: Omit<ToastOptions, 'type'>) =>
      ctx.show(msg, { ...opts, type: 'info' }),
  }), [ctx.show, ctx.dismiss]);
}
