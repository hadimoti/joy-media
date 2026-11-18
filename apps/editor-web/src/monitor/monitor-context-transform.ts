import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { objectIdToClipIds } from './monitor-ids.js';
import { applyWorldChange, turn, type LocalTransform } from './monitor-transform-maths.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  type MonitorTransformTarget,
} from './monitor-transform-targets.js';
import { calculateMediaFitTransform } from '../media-fit-transform.js';

const TRANSFORM_CHANNELS = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg'] as const;
const STATE_EPSILON = 1e-6;

type TransformProperty = (typeof TRANSFORM_CHANNELS)[number];

export interface MonitorContextTransformState {
  readonly disabledReason?: string;
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

function hasTransformAnimationOrExpression(object: VisualObjectV1): boolean {
  return TRANSFORM_CHANNELS.some(
    (channel) =>
      object.animations?.[channel] !== undefined || object.expressions?.[channel] !== undefined,
  );
}

function disabledReason(input: MonitorContextTransformInput): string | undefined {
  const blocked = input.target.blocked.move;
  if (blocked !== undefined) return TRANSFORM_BLOCK_MESSAGES[blocked];
  if (input.activeCamera === true) return TRANSFORM_BLOCK_MESSAGES.camera;
  if (parentIsLocked(input.project, input.target))
    return 'A parent of this element is on a locked track.';
  if (
    input.target.ancestorObjectIds?.some((id) => {
      const parent = input.project.visualObjects[id];
      return parent !== undefined && hasTransformAnimationOrExpression(parent);
    })
  )
    return 'A parent of this element has an animated or expression-driven transform.';
  if (hasTransformAnimationOrExpression(input.object))
    return 'This element has an animated or expression-driven transform.';
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

function resetScale(
  object: VisualObjectV1,
  project: JoyProjectV1,
  frameWidth: number,
  frameHeight: number,
): { readonly scaleX: number; readonly scaleY: number } {
  const asset = object.assetId === undefined ? undefined : project.assets[object.assetId];
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
    frameWidth,
    frameHeight,
    mode: 'fit',
  });
  return fitted === undefined
    ? { scaleX: 1, scaleY: 1 }
    : { scaleX: fitted.scaleX, scaleY: fitted.scaleY };
}

function samePosition(a: LocalTransform, b: LocalTransform): boolean {
  return !valuesDiffer(a.x, b.x) && !valuesDiffer(a.y, b.y);
}

function sameResetTransform(a: LocalTransform, b: LocalTransform): boolean {
  return TRANSFORM_CHANNELS.every((channel) => !valuesDiffer(a[channel], b[channel]));
}

/** Build one undoable Centre and Reset edit from the Monitor's drawn geometry. */
export function monitorContextTransformState(
  input: MonitorContextTransformInput,
): MonitorContextTransformState {
  const unavailable = disabledReason(input);
  if (unavailable !== undefined)
    return { disabledReason: unavailable, alreadyCentred: false, alreadyReset: false };

  const before = input.target.geometry.transform;
  const centreDelta = {
    x: input.frameWidth / 2 - input.target.geometry.center.x,
    y: input.frameHeight / 2 - input.target.geometry.center.y,
  };
  const centreAfter = {
    ...before,
    x: before.x + centreDelta.x,
    y: before.y + centreDelta.y,
  };
  const centredLocal = applyWorldChange(
    input.target.local,
    before,
    centreAfter,
    input.target.parent,
  );
  if (centredLocal === undefined)
    return {
      disabledReason: TRANSFORM_BLOCK_MESSAGES['parent-zero-scale'],
      alreadyCentred: false,
      alreadyReset: false,
    };

  // Recover the local offset between the object's rotation origin and its box
  // centre so Reset can centre the box after returning rotation and scale.
  const centreFromOrigin = {
    x: input.target.geometry.center.x - input.target.geometry.origin.x,
    y: input.target.geometry.center.y - input.target.geometry.origin.y,
  };
  const unrotatedCentreOffset = turn(centreFromOrigin, -before.rotationDeg);
  const localCentreOffset = {
    x: unrotatedCentreOffset.x / before.scaleX,
    y: unrotatedCentreOffset.y / before.scaleY,
  };
  const scale = resetScale(input.object, input.project, input.frameWidth, input.frameHeight);
  const resetAfter = {
    x: input.frameWidth / 2 - localCentreOffset.x * scale.scaleX,
    y: input.frameHeight / 2 - localCentreOffset.y * scale.scaleY,
    scaleX: scale.scaleX,
    scaleY: scale.scaleY,
    rotationDeg: 0,
  };
  const resetLocal = applyWorldChange(input.target.local, before, resetAfter, input.target.parent);
  if (resetLocal === undefined)
    return {
      disabledReason: TRANSFORM_BLOCK_MESSAGES['parent-zero-scale'],
      alreadyCentred: false,
      alreadyReset: false,
    };

  const alreadyCentred = samePosition(input.target.local, centredLocal);
  const alreadyReset = sameResetTransform(input.target.local, resetLocal);
  return {
    alreadyCentred,
    alreadyReset,
    ...(alreadyCentred
      ? {}
      : {
          centreTransaction: transaction(
            'Centre in frame',
            input.objectId,
            ['x', 'y'],
            centredLocal,
          ),
        }),
    ...(alreadyReset
      ? {}
      : {
          resetTransaction: transaction(
            'Reset transform',
            input.objectId,
            TRANSFORM_CHANNELS,
            resetLocal,
          ),
        }),
  };
}
