import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { objectIdToClipIds } from './monitor-ids.js';
import {
  applyWorldChange,
  cleanNumber,
  turn,
  worldDeltaToParentSpace,
  type LocalTransform,
  type ParentTransform,
} from './monitor-transform-maths.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  type MonitorTransformTarget,
} from './monitor-transform-targets.js';
import { calculateMediaFitTransform, drawnAssetId } from '../media-fit-transform.js';

const TRANSFORM_CHANNELS = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg'] as const;
const POSITION_CHANNELS = ['x', 'y'] as const;
const STATE_EPSILON = 1e-6;
const NO_PARENT: ParentTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 };
const CENTRE_ANIMATED_MESSAGE =
  'Position is animated or expression-driven, so Centre cannot set it here.';
const RESET_ANIMATED_MESSAGE =
  'Position, size or rotation is animated or expression-driven, so Reset cannot set it here.';
const NO_SIZE_MESSAGE = 'This element has no size, so Reset cannot centre it.';

type TransformProperty = (typeof TRANSFORM_CHANNELS)[number];

export interface MonitorContextTransformState {
  /** Why both actions are off: the camera, a locked track, or a parent or canvas that cannot be used. */
  readonly disabledReason?: string;
  /** Why only Centre is off: its position is animated or expression-driven. */
  readonly centreDisabledReason?: string;
  /** Why only Reset is off: a rotation, size or position channel is animated or expression-driven. */
  readonly resetDisabledReason?: string;
  readonly alreadyCentred: boolean;
  readonly alreadyReset: boolean;
  readonly centreTransaction?: VisualObjectTransaction;
  readonly resetTransaction?: VisualObjectTransaction;
}

export interface MonitorContextTransformInput {
  readonly objectId: string;
  readonly object: VisualObjectV1;
  readonly project: JoyProjectV1;
  readonly target: MonitorTransformTarget;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly activeCamera?: boolean;
}

function valuesDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > STATE_EPSILON;
}

function trackIsLocked(project: JoyProjectV1, clipId: string): boolean {
  return Object.values(project.compositions).some((composition) =>
    composition.tracks.some(
      (track) => track.locked === true && track.clips.some((clip) => clip.id === clipId),
    ),
  );
}

function parentIsLocked(project: JoyProjectV1, target: MonitorTransformTarget): boolean {
  return (
    target.ancestorObjectIds?.some((parentId) =>
      objectIdToClipIds(project, parentId).some((clipId) => trackIsLocked(project, clipId)),
    ) ?? false
  );
}

/** True when one of the channels is animated or driven by an expression. */
function animatedOrExpression(
  object: VisualObjectV1,
  channels: readonly TransformProperty[],
): boolean {
  return channels.some(
    (channel) =>
      object.animations?.[channel] !== undefined || object.expressions?.[channel] !== undefined,
  );
}

/**
 * Why both actions are off. The Monitor gesture's reason comes first so the two
 * stay in step. An animated parent does not block: like the box gesture, the
 * values are read at the playhead.
 */
function sharedDisabledReason(input: MonitorContextTransformInput): string | undefined {
  const blocked = input.target.blocked.move;
  if (blocked !== undefined) return TRANSFORM_BLOCK_MESSAGES[blocked];
  if (input.activeCamera === true) return TRANSFORM_BLOCK_MESSAGES.camera;
  if (parentIsLocked(input.project, input.target))
    return 'A parent of this element is on a locked track.';
  if (
    !Number.isFinite(input.frameWidth) ||
    !Number.isFinite(input.frameHeight) ||
    input.frameWidth <= 0 ||
    input.frameHeight <= 0
  )
    return 'The canvas size is unavailable.';
  return undefined;
}

function transaction(
  label: 'Centre in frame' | 'Reset transform',
  objectId: string,
  keys: readonly TransformProperty[],
  transform: LocalTransform,
): VisualObjectTransaction {
  return {
    label,
    commands: keys.map((key) => ({
      type: 'object.setTransformProperty',
      payload: { objectId, key, value: transform[key] },
    })),
  };
}

/**
 * The scale a new object of this kind gets: the Fit scale of its visible media
 * (the crop is part of the visible box), or 1 for everything else.
 */
function defaultScale(input: MonitorContextTransformInput): {
  readonly scaleX: number;
  readonly scaleY: number;
} {
  const assetId = drawnAssetId(input.project, input.object, input.target.clipId);
  const asset = assetId === undefined ? undefined : input.project.assets[assetId];
  const width = asset?.descriptor?.width;
  const height = asset?.descriptor?.height;
  if (
    (asset?.kind !== 'video' && asset?.kind !== 'image') ||
    width === undefined ||
    height === undefined
  )
    return { scaleX: 1, scaleY: 1 };
  const fitted = calculateMediaFitTransform({
    sourceWidth: width,
    sourceHeight: height,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    mode: 'fit',
    crop: input.object.transform.crop,
  });
  return fitted === undefined
    ? { scaleX: 1, scaleY: 1 }
    : { scaleX: fitted.scaleX, scaleY: fitted.scaleY };
}

function samePosition(a: LocalTransform, b: LocalTransform): boolean {
  return !valuesDiffer(a.x, b.x) && !valuesDiffer(a.y, b.y);
}

function sameResetTransform(a: LocalTransform, b: LocalTransform): boolean {
  return (
    samePosition(a, b) &&
    !valuesDiffer(a.scaleX, b.scaleX) &&
    !valuesDiffer(a.scaleY, b.scaleY) &&
    !valuesDiffer(a.rotationDeg, b.rotationDeg)
  );
}

/**
 * The object's own values that return it to its defaults (no rotation, the
 * default scale) with its drawn box centred in the frame. The renderer places
 * the rotation origin through the parent, and draws the box from there with the
 * parent's turn and scale applied, so the offset from the origin to the box
 * centre is scaled and turned the same way before the origin is placed.
 */
function resetLocalValues(
  target: MonitorTransformTarget,
  scale: { readonly scaleX: number; readonly scaleY: number },
  frameWidth: number,
  frameHeight: number,
): LocalTransform | undefined {
  const { geometry } = target;
  const before = geometry.transform;
  if (Math.abs(before.scaleX) < STATE_EPSILON || Math.abs(before.scaleY) < STATE_EPSILON)
    return undefined;
  // The box centre relative to the rotation origin, in the object's own unrotated, unscaled units.
  const fromOrigin = turn(
    { x: geometry.center.x - geometry.origin.x, y: geometry.center.y - geometry.origin.y },
    -before.rotationDeg,
  );
  const offset = { x: fromOrigin.x / before.scaleX, y: fromOrigin.y / before.scaleY };
  const parent = target.parent ?? NO_PARENT;
  // With rotation 0 and the default scale, the centre sits this far from the origin in canvas space.
  const centreFromOrigin = turn(
    {
      x: offset.x * scale.scaleX * parent.scaleX,
      y: offset.y * scale.scaleY * parent.scaleY,
    },
    parent.rotationDeg,
  );
  const origin = {
    x: frameWidth / 2 - centreFromOrigin.x,
    y: frameHeight / 2 - centreFromOrigin.y,
  };
  const local = worldDeltaToParentSpace(
    { x: origin.x - parent.x, y: origin.y - parent.y },
    target.parent,
  );
  if (local === undefined) return undefined;
  return {
    x: cleanNumber(local.x),
    y: cleanNumber(local.y),
    scaleX: scale.scaleX,
    scaleY: scale.scaleY,
    rotationDeg: 0,
  };
}

/** Build one undoable Centre and Reset edit from the Monitor's drawn geometry. */
export function monitorContextTransformState(
  input: MonitorContextTransformInput,
): MonitorContextTransformState {
  const shared = sharedDisabledReason(input);
  if (shared !== undefined)
    return { disabledReason: shared, alreadyCentred: false, alreadyReset: false };

  const { target, frameWidth, frameHeight } = input;
  const centreBlocked = animatedOrExpression(input.object, POSITION_CHANNELS);
  const resetBlocked = animatedOrExpression(input.object, TRANSFORM_CHANNELS);

  // Centre moves the whole drawn box: a world translation, so scale and rotation stay as they are.
  const before = target.geometry.transform;
  const centreAfter = {
    ...before,
    x: before.x + (frameWidth / 2 - target.geometry.center.x),
    y: before.y + (frameHeight / 2 - target.geometry.center.y),
  };
  const centredLocal = applyWorldChange(target.local, before, centreAfter, target.parent);
  if (centredLocal === undefined)
    return {
      disabledReason: TRANSFORM_BLOCK_MESSAGES['parent-zero-scale'],
      alreadyCentred: false,
      alreadyReset: false,
    };
  const alreadyCentred = samePosition(target.local, centredLocal);

  const resetLocal = resetLocalValues(target, defaultScale(input), frameWidth, frameHeight);
  const alreadyReset = resetLocal !== undefined && sameResetTransform(target.local, resetLocal);
  const resetDisabledReason = resetBlocked
    ? RESET_ANIMATED_MESSAGE
    : resetLocal === undefined
      ? NO_SIZE_MESSAGE
      : undefined;

  const centreTransaction =
    centreBlocked || alreadyCentred
      ? undefined
      : transaction('Centre in frame', input.objectId, POSITION_CHANNELS, centredLocal);
  const resetTransaction =
    resetBlocked || resetLocal === undefined || alreadyReset
      ? undefined
      : transaction('Reset transform', input.objectId, TRANSFORM_CHANNELS, resetLocal);

  return {
    alreadyCentred,
    alreadyReset,
    ...(centreBlocked ? { centreDisabledReason: CENTRE_ANIMATED_MESSAGE } : {}),
    ...(resetDisabledReason === undefined ? {} : { resetDisabledReason }),
    ...(centreTransaction === undefined ? {} : { centreTransaction }),
    ...(resetTransaction === undefined ? {} : { resetTransaction }),
  };
}
