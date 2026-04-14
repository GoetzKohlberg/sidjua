// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — useUndo hook
 *
 * Undo action registry. Tracks up to 20 undoable actions and
 * handles Ctrl+Z / Cmd+Z globally. Each registered action shows
 * a toast with an undo button.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useToast } from '../components/shared/Toast';
import { uuidV4 }   from '../lib/uuid';

interface UndoEntry {
  id:  string;
  fn:  () => void | Promise<void>;
}


const MAX_ENTRIES = 20;
const stack: UndoEntry[] = [];


export function useUndo() {
  const { show, dismiss } = useToast();
  // Map from undoId → toastId so we can dismiss the toast on undo
  const toastMap = useRef(new Map<string, string>());

  const executeUndo = useCallback(async (id: string) => {
    const idx = stack.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const [entry] = stack.splice(idx, 1);
    const toastId = toastMap.current.get(id);
    if (toastId) dismiss(toastId);
    toastMap.current.delete(id);
    await entry.fn();
  }, [dismiss]);

  // Global keyboard shortcut — Ctrl+Z / Cmd+Z undoes last entry
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z' || e.shiftKey) return;
      if (stack.length === 0) return;
      e.preventDefault();
      const last = stack[stack.length - 1];
      if (last) void executeUndo(last.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [executeUndo]);

  /**
   * Register an undoable action and show a toast with an undo button.
   *
   * @param toastMessage  The toast message shown to the user.
   * @param undoFn        Called when the user clicks Undo or presses Ctrl+Z.
   * @returns             The undo entry ID.
   */
  const addUndo = useCallback(
    (toastMessage: string, undoFn: () => void | Promise<void>): string => {
      const id: string = uuidV4();
      stack.push({ id, fn: undoFn });
      if (stack.length > MAX_ENTRIES) stack.shift();

      const toastId = show(toastMessage, {
        type:      'success',
        undoLabel: 'Undo',
        onUndo:    () => { void executeUndo(id); },
      });
      toastMap.current.set(id, toastId);
      return id;
    },
    [show, executeUndo],
  );

  return { addUndo };
}
