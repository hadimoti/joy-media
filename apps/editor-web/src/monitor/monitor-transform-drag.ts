import type { NodePoint } from '@joy-media/render-ir';
import {
  applyWorldChange,
  moveTransform,
  rotateTransform,
  scaleTransform,
  type DrawnTransform,
  type LocalTransform,
  type MonitorScaleHandle,
  type ScaleModifiers,
} from './monitor-transform-maths.js';
import {
  GESTURE_CHANNELS,
  gestureBlockReason,
  type MonitorTransformTarget,
  type TransformBlockReason,
} from './monitor-transform-targets.js';

/**
 * One Monitor transform gesture (ADR-0046 section 5.5, T-M05a): pointer-down
 * begins, every move only previews, release writes exactly one undo step and
 * Escape (or a lost pointer) restores the picture and writes nothing. It is
 * the `TransientPropertyInteraction` shape (begin, update, commit, cancel) for
 * a whole transform instead of one number.
 */

export type MonitorTransformGesture =
  | { readonly kind: 'move' }
  | { readonly kind: 'scale'; readonly handle: MonitorScaleHandle }
  | { readonly kind: 'rotate' };

/** New local values per visual object id. */
export type TransformPatches = ReadonlyMap<string, LocalTransform>;

export interface MonitorTransformHost {
  /** Shows the values live (the picture, the box and the Inspector); writes nothing. */
  readonly preview: (patches: TransformPatches) => void;
  /** Writes the values as one undo step. */
  readonly commit: (label: string, patches: TransformPatches) => void;
  /** Drops the live values (the document was never changed). */
  readonly cancel: () => void;
}

/** The undo label of a gesture. */
export function gestureLabel(gesture: MonitorTransformGesture | 'nudge'): string {
  if (gesture === 'nudge') return 'Nudge on the Monitor';
  if (gesture.kind === 'move') return 'Move on the Monitor';
  if (gesture.kind === 'scale') return 'Scale on the Monitor';
  return 'Rotate on the Monitor';
}

function drawnAfter(
  target: MonitorTransformTarget,
  gesture: MonitorTransformGesture,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
): DrawnTransform {
  const { geometry } = target;
  if (gesture.kind === 'move')
    return moveTransform(geometry.transform, { x: now.x - start.x, y: now.y - start.y });
  if (gesture.kind === 'scale')
    return scaleTransform(geometry, gesture.handle, start, now, modifiers);
  return rotateTransform(geometry, start, now, { shift: modifiers.shift });
}

/**
 * The new local values of every target for a gesture from `start` to `now`.
 * Only the values the gesture owns are changed; each object appears once.
 * `undefined` when the gesture is not allowed on these targets.
 */
export function gesturePatches(
  targets: readonly MonitorTransformTarget[],
  gesture: MonitorTransformGesture,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
): TransformPatches | undefined {
  if (targets.length === 0) return undefined;
  if (gesture.kind !== 'move' && targets.length !== 1) return undefined;
  if (gestureBlockReason(targets, gesture.kind) !== undefined) return undefined;
  const channels = GESTURE_CHANNELS[gesture.kind];
  const patches = new Map<string, LocalTransform>();
  for (const target of targets) {
    if (target.objectId === undefined || patches.has(target.objectId)) continue;
    const after = drawnAfter(target, gesture, start, now, modifiers);
    const changed = applyWorldChange(target.local, target.geometry.transform, after, target.parent);
    if (changed === undefined) return undefined;
    const next = { ...target.local };
    for (const channel of channels) next[channel] = changed[channel];
    patches.set(target.objectId, next);
  }
  return patches;
}

/** True when any patch differs from the target's current values. */
export function patchesChange(
  targets: readonly MonitorTransformTarget[],
  patches: TransformPatches,
): boolean {
  return targets.some((target) => {
    if (target.objectId === undefined) return false;
    const next = patches.get(target.objectId);
    if (next === undefined) return false;
    return (Object.keys(next) as (keyof LocalTransform)[]).some(
      (key) => next[key] !== target.local[key],
    );
  });
}

/** A gesture in progress. `end` is safe to call more than once. */
export interface MonitorTransformDrag {
  readonly gesture: MonitorTransformGesture;
  readonly update: (now: NodePoint, modifiers: ScaleModifiers) => void;
  /** `true` writes one undo step (when something changed); `false` restores. */
  readonly end: (commit: boolean) => void;
  readonly active: () => boolean;
}

/** Starts a gesture, or returns the reason it is not allowed. */
export function startTransformDrag(
  targets: readonly MonitorTransformTarget[],
  gesture: MonitorTransformGesture,
  start: NodePoint,
  host: MonitorTransformHost,
): MonitorTransformDrag | { readonly blocked: TransformBlockReason | 'nothing' } {
  const reason = gestureBlockReason(targets, gesture.kind);
  if (reason !== undefined) return { blocked: reason };
  if (
    targets.every((target) => target.objectId === undefined) ||
    (gesture.kind !== 'move' && targets.length !== 1)
  )
    return { blocked: 'nothing' };
  let latest: TransformPatches | undefined;
  let open = true;
  return {
    gesture,
    update(now, modifiers) {
      if (!open) return;
      const patches = gesturePatches(targets, gesture, start, now, modifiers);
      if (patches === undefined) return;
      latest = patches;
      host.preview(patches);
    },
    end(commit) {
      if (!open) return;
      open = false;
      if (commit && latest !== undefined && patchesChange(targets, latest))
        host.commit(gestureLabel(gesture), latest);
      else host.cancel();
    },
    active: () => open,
  };
}

/** The values one arrow-key press writes (one undo step), or `undefined` when not allowed. */
export function nudgePatches(
  targets: readonly MonitorTransformTarget[],
  delta: NodePoint,
): TransformPatches | undefined {
  const patches = gesturePatches(targets, { kind: 'move' }, { x: 0, y: 0 }, delta, {
    shift: false,
    alt: false,
  });
  return patches !== undefined && patchesChange(targets, patches) ? patches : undefined;
}
