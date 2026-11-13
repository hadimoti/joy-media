import type { NodePoint } from '@joy-media/render-ir';
import { DEFAULT_TRANSFORM_ANCHOR } from '@joy-media/project-schema';
import {
  applyWorldChange,
  moveTransform,
  rotateTransform,
  scaleTransform,
  type DrawnTransform,
  type LocalTransform,
  type MonitorScaleHandle,
  type ScaleModifiers,
  type TransformBoxGeometry,
} from './monitor-transform-maths.js';
import {
  groupGeometry,
  groupScaleOf,
  groupTurnOf,
  rotateMemberAbout,
  scaleMemberAbout,
} from './monitor-transform-group.js';
import { moveAnchor } from './monitor-transform-anchor.js';
import type { TransformPatch } from './monitor-transform-keyframes.js';
import {
  GESTURE_CHANNELS,
  gestureBlockReason,
  type MonitorTransformGestureKind,
  type MonitorTransformTarget,
  type TransformBlockReason,
} from './monitor-transform-targets.js';

/**
 * One Monitor transform gesture (ADR-0046 section 5.5, T-M05a): pointer-down
 * begins, every move only previews, release writes exactly one undo step and
 * Escape (or a lost pointer) restores the picture and writes nothing. It is
 * the `TransientPropertyInteraction` shape (begin, update, commit, cancel) for
 * a whole transform instead of one number.
 *
 * T-M05b adds the anchor point (one element), and scale and rotate for a group
 * of several selected elements (the group box's handles). A value with a
 * curve is written as a keyframe at the playhead by the host on release.
 */

export type MonitorTransformGesture =
  | { readonly kind: 'move' }
  | { readonly kind: 'scale'; readonly handle: MonitorScaleHandle }
  | { readonly kind: 'rotate' }
  | { readonly kind: 'anchor' }
  | { readonly kind: 'group-scale'; readonly handle: MonitorScaleHandle }
  | { readonly kind: 'group-rotate' };

export type { TransformPatch } from './monitor-transform-keyframes.js';

/** New local values per visual object id. */
export type TransformPatches = ReadonlyMap<string, TransformPatch>;

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
  if (gesture.kind === 'scale' || gesture.kind === 'group-scale') return 'Scale on the Monitor';
  if (gesture.kind === 'anchor') return 'Move the anchor point on the Monitor';
  return 'Rotate on the Monitor';
}

/** The document values a gesture writes (besides the anchor itself). */
function channelsOf(gesture: MonitorTransformGesture): readonly (keyof LocalTransform)[] {
  switch (gesture.kind) {
    case 'group-scale':
      return GESTURE_CHANNELS.scale;
    case 'group-rotate':
      // Turning about the group centre moves each element round it.
      return ['x', 'y', 'rotationDeg'];
    case 'anchor':
      // The position changes only to keep a turned picture still.
      return GESTURE_CHANNELS.move;
    default:
      return GESTURE_CHANNELS[gesture.kind];
  }
}

/** Why a gesture cannot run on these targets (the first reason found), or `undefined`. */
export function gestureBlockReasonFor(
  targets: readonly MonitorTransformTarget[],
  gesture: MonitorTransformGesture,
): TransformBlockReason | undefined {
  const kinds: readonly MonitorTransformGestureKind[] =
    gesture.kind === 'group-scale'
      ? ['scale']
      : gesture.kind === 'group-rotate'
        ? ['rotate', 'move']
        : gesture.kind === 'anchor'
          ? []
          : [gesture.kind];
  for (const kind of kinds) {
    const reason = gestureBlockReason(targets, kind);
    if (reason !== undefined) return reason;
  }
  if (gesture.kind === 'anchor')
    return targets.find((target) => target.anchorBlocked !== undefined)?.anchorBlocked;
  return undefined;
}

/** True when the gesture fits this many targets: one element, or a group of several. */
function fitsSelection(gesture: MonitorTransformGesture, count: number): boolean {
  if (gesture.kind === 'move') return count > 0;
  if (gesture.kind === 'group-scale' || gesture.kind === 'group-rotate') return count > 1;
  return count === 1;
}

/** What a group gesture shares between its elements: the group box. */
interface GestureContext {
  readonly group?: TransformBoxGeometry;
}

function drawnAfter(
  target: MonitorTransformTarget,
  gesture: MonitorTransformGesture,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
  context: GestureContext,
): DrawnTransform | undefined {
  const { geometry } = target;
  switch (gesture.kind) {
    case 'move':
      return moveTransform(geometry.transform, { x: now.x - start.x, y: now.y - start.y });
    case 'scale':
      return scaleTransform(geometry, gesture.handle, start, now, modifiers);
    case 'rotate':
      return rotateTransform(geometry, start, now, { shift: modifiers.shift });
    case 'anchor':
      return moveAnchor(geometry, start, now)?.transform;
    case 'group-scale':
      return context.group === undefined
        ? undefined
        : scaleMemberAbout(
            geometry,
            groupScaleOf(context.group, gesture.handle, start, now, modifiers),
          );
    case 'group-rotate':
      return context.group === undefined
        ? undefined
        : rotateMemberAbout(
            geometry,
            context.group.center,
            groupTurnOf(context.group, start, now, { shift: modifiers.shift }),
          );
  }
}

/**
 * The new local values of every target for a gesture from `start` to `now`.
 * Only the values the gesture owns are changed; each object appears once.
 * The patches are hierarchy-aware: when an element's parent (or any
 * ancestor) is selected too, only the topmost selected ancestor gets a patch
 * and the element follows it through the hierarchy. Patching both would move
 * the child twice, because its patch is local to the parent's old values.
 * `undefined` when the gesture is not allowed on these targets.
 */
export function gesturePatches(
  targets: readonly MonitorTransformTarget[],
  gesture: MonitorTransformGesture,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
): TransformPatches | undefined {
  if (!fitsSelection(gesture, targets.length)) return undefined;
  if (gestureBlockReasonFor(targets, gesture) !== undefined) return undefined;
  const channels = channelsOf(gesture);
  const context: GestureContext =
    gesture.kind === 'group-scale' || gesture.kind === 'group-rotate'
      ? (() => {
          const group = groupGeometry(targets.map((target) => target.geometry));
          return group === undefined ? {} : { group };
        })()
      : {};
  const selectedObjects = new Set(
    targets.flatMap((target) => (target.objectId === undefined ? [] : [target.objectId])),
  );
  const patches = new Map<string, TransformPatch>();
  for (const target of targets) {
    if (target.objectId === undefined || patches.has(target.objectId)) continue;
    if (target.ancestorObjectIds?.some((id) => selectedObjects.has(id)) === true) continue;
    const after = drawnAfter(target, gesture, start, now, modifiers, context);
    if (after === undefined) return undefined;
    const changed = applyWorldChange(target.local, target.geometry.transform, after, target.parent);
    if (changed === undefined) return undefined;
    const next: { -readonly [K in keyof TransformPatch]: TransformPatch[K] } = {
      ...target.local,
    };
    for (const channel of channels) next[channel] = changed[channel];
    if (gesture.kind === 'anchor') {
      const anchor = moveAnchor(target.geometry, start, now)?.anchor;
      if (anchor === undefined) return undefined;
      next.anchorX = anchor.x;
      next.anchorY = anchor.y;
    }
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
    const anchor = target.anchor ?? { x: DEFAULT_TRANSFORM_ANCHOR, y: DEFAULT_TRANSFORM_ANCHOR };
    return (
      (Object.keys(target.local) as (keyof LocalTransform)[]).some(
        (key) => next[key] !== target.local[key],
      ) ||
      (next.anchorX !== undefined && next.anchorX !== anchor.x) ||
      (next.anchorY !== undefined && next.anchorY !== anchor.y)
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
  const reason = gestureBlockReasonFor(targets, gesture);
  if (reason !== undefined) return { blocked: reason };
  if (
    targets.every((target) => target.objectId === undefined) ||
    !fitsSelection(gesture, targets.length)
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
