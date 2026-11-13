import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { NodePoint } from '@joy-media/render-ir';
import { scopedKeyTable } from '../keyboard-shortcuts.js';
import { MONITOR_KEY_SCOPE } from './MonitorViewport.js';
import { nudgeDelta } from './monitor-transform-maths.js';
import {
  keyboardChangePatches,
  keyboardRotateDegrees,
  keyboardScaleFactor,
  type KeyboardChange,
} from './monitor-keyboard.js';
import {
  gestureLabel,
  nudgePatches,
  patchesChange,
  startTransformDrag,
  type MonitorTransformDrag,
  type MonitorTransformGesture,
  type MonitorTransformHost,
} from './monitor-transform-drag.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  gestureBlockReason,
  type MonitorTransformTarget,
} from './monitor-transform-targets.js';

/**
 * The Monitor's transform controller (T-M05a): starts drags for the box and
 * the viewport, cancels one on Escape, and owns the arrow-key nudge through the
 * focus-based key table (ADR-0046 B5, scope `monitor`): the arrows nudge only
 * while the pointer is over the Monitor or focus is in it, and only when the
 * selection is drawn on the Monitor; otherwise the global seek keys apply.
 */

export interface UseMonitorTransformOptions {
  /** The targets of these clips (the selection when omitted) on the frame drawn last. */
  readonly readTargets: (clipIds?: readonly string[]) => readonly MonitorTransformTarget[];
  readonly host: MonitorTransformHost;
  /** Says why a gesture was refused (a short message for a toast). */
  readonly onBlocked?: (message: string) => void;
}

export interface MonitorTransformController {
  /** Starts a gesture at a canvas point; `undefined` when it is not allowed. */
  readonly startGesture: (
    gesture: MonitorTransformGesture,
    start: NodePoint,
    clipIds?: readonly string[],
  ) => MonitorTransformDrag | undefined;
  /** One arrow-key press: one undo step. True when the key belonged to the Monitor. */
  readonly nudge: (key: string, shift: boolean) => boolean;
}

export function useMonitorTransform(
  options: UseMonitorTransformOptions,
): MonitorTransformController {
  const latest = useRef(options);
  latest.current = options;
  const activeRef = useRef<MonitorTransformDrag | undefined>(undefined);

  const startGesture = useCallback(
    (gesture: MonitorTransformGesture, start: NodePoint, clipIds?: readonly string[]) => {
      if (activeRef.current?.active() === true) activeRef.current.end(false);
      const targets = latest.current.readTargets(clipIds);
      const started = startTransformDrag(targets, gesture, start, latest.current.host);
      if ('blocked' in started) {
        if (started.blocked !== 'nothing')
          latest.current.onBlocked?.(TRANSFORM_BLOCK_MESSAGES[started.blocked]);
        return undefined;
      }
      activeRef.current = started;
      return started;
    },
    [],
  );

  const nudge = useCallback((key: string, shift: boolean) => {
    const delta = nudgeDelta(key, shift);
    if (delta === undefined) return false;
    if (activeRef.current?.active() === true) return true;
    const targets = latest.current.readTargets();
    if (targets.length === 0) return false;
    const reason = gestureBlockReason(targets, 'move');
    if (reason !== undefined) {
      latest.current.onBlocked?.(TRANSFORM_BLOCK_MESSAGES[reason]);
      return true;
    }
    const patches = nudgePatches(targets, delta);
    if (patches !== undefined) latest.current.host.commit(gestureLabel('nudge'), patches);
    return true;
  }, []);

  // Alt+arrow scale and [ ] rotate (T-M12): one undo step per press, through the same host as a drag.
  const keyboardChange = useCallback((change: KeyboardChange) => {
    if (activeRef.current?.active() === true) return;
    const targets = latest.current.readTargets();
    if (targets.length === 0) return;
    const reason = gestureBlockReason(targets, change.kind);
    if (reason !== undefined) {
      latest.current.onBlocked?.(TRANSFORM_BLOCK_MESSAGES[reason]);
      return;
    }
    const patches = keyboardChangePatches(targets, change);
    if (patches === undefined || !patchesChange(targets, patches)) return;
    const gesture =
      change.kind === 'scale'
        ? { kind: 'scale' as const, handle: 'se' as const }
        : { kind: 'rotate' as const };
    latest.current.host.commit(gestureLabel(gesture), patches);
  }, []);

  // Escape cancels a drag in progress: the picture goes back, nothing is written.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || activeRef.current?.active() !== true) return;
      event.preventDefault();
      event.stopPropagation();
      activeRef.current.end(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (activeRef.current?.active() === true) activeRef.current.end(false);
    };
  }, []);

  // Arrow keys through the focus-based key table (scope `monitor`).
  useEffect(
    () =>
      scopedKeyTable.register({
        scope: MONITOR_KEY_SCOPE,
        match: (event) =>
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          nudgeDelta(event.key, event.shiftKey) !== undefined &&
          latest.current.readTargets().length > 0,
        run: (event) => {
          nudge(event.key, event.shiftKey);
        },
      }),
    [nudge],
  );

  // Alt+arrows scale the selection, [ ] and { } rotate it (T-M12).
  useEffect(
    () =>
      scopedKeyTable.register({
        scope: MONITOR_KEY_SCOPE,
        match: (event) =>
          event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          keyboardScaleFactor(event.key, event.shiftKey) !== undefined &&
          latest.current.readTargets().length > 0,
        run: (event) => {
          const factor = keyboardScaleFactor(event.key, event.shiftKey);
          if (factor !== undefined) keyboardChange({ kind: 'scale', factor });
        },
      }),
    [keyboardChange],
  );
  useEffect(
    () =>
      scopedKeyTable.register({
        scope: MONITOR_KEY_SCOPE,
        match: (event) =>
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          keyboardRotateDegrees(event.code ?? '', event.shiftKey) !== undefined &&
          latest.current.readTargets().length > 0,
        run: (event) => {
          const degrees = keyboardRotateDegrees(event.code ?? '', event.shiftKey);
          if (degrees !== undefined) keyboardChange({ kind: 'rotate', degrees });
        },
      }),
    [keyboardChange],
  );

  return useMemo(() => ({ startGesture, nudge }), [nudge, startGesture]);
}
