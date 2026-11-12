import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { NodePoint } from '@joy-media/render-ir';
import { scopedKeyTable } from '../keyboard-shortcuts.js';
import { MONITOR_KEY_SCOPE } from './MonitorViewport.js';
import { nudgeDelta } from './monitor-transform-maths.js';
import {
  gestureLabel,
  nudgePatches,
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

  return useMemo(() => ({ startGesture, nudge }), [nudge, startGesture]);
}
