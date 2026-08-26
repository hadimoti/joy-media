/** Pure active-interval and static-property evaluation (WP-01.3, WP-04.1, WP-10.1, WP-10.4). */

import { rangeContainsUs } from '@joy-media/project-schema';
import type { TimeUs, VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { resolveObjectTransform } from '@joy-media/motion-core/transform';
import type { ExpressionChannelDiagnostic } from '@joy-media/motion-core/expression';
import { resolveObjectTransformWithExpressions } from '@joy-media/motion-core/expression';
import {
  resolveObjectTransformThroughCamera,
  resolveObjectTransformThroughCameraWithExpressions,
} from '@joy-media/camera-core';

export interface TimedEntity {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
  readonly order: number;
  readonly enabled?: boolean;
}

/** Returns draw-order entities active in the end-exclusive interval at `timeUs`. */
export function queryActiveIntervals<T extends TimedEntity>(
  entities: readonly T[],
  timeUs: TimeUs,
): readonly T[] {
  return entities
    .filter(
      (entity) =>
        entity.enabled !== false &&
        rangeContainsUs({ startUs: entity.startUs, durationUs: entity.durationUs }, timeUs),
    )
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** Static values are immutable for a frame; keyframed channels are evaluated separately. */
export interface StaticProperty<T> {
  readonly value: T;
  readonly enabled?: boolean;
}

export function evaluateStaticProperty<T>(property: StaticProperty<T>): T | undefined {
  return property.enabled === false ? undefined : property.value;
}

/**
 * The keyframe pass promised by WP-01.3: an object's effective transform at
 * `timeUs`, with any animated channels sampled and the rest left static. The
 * interpolation math itself lives in `@joy-media/motion-core`; the evaluator is
 * the single place that turns document state into per-frame values.
 */
export function evaluateAnimatedTransform(
  object: VisualObjectV1,
  timeUs: TimeUs,
): VisualObjectTransformV1 {
  return resolveObjectTransform(object, timeUs);
}

/**
 * An object's effective transform at `timeUs`, composed under its parent chain
 * and, when the composition has an `activeCameraId`, projected through that
 * depth-only 2.5D camera (§20.3, ADR-0015, WP-10.1). `cameraId` undefined
 * reproduces `evaluateAnimatedTransform`'s parenting-only behavior exactly, so
 * compositions without a camera are unaffected.
 */
export function evaluateCameraTransform(
  objectId: string,
  cameraId: string | undefined,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  compHeight: number,
): VisualObjectTransformV1 {
  return resolveObjectTransformThroughCamera(objectId, cameraId, objectsById, timeUs, compHeight);
}

export interface EvaluatedExpressionTransform {
  readonly transform: VisualObjectTransformV1;
  readonly diagnostics: readonly ExpressionChannelDiagnostic[];
}

/**
 * An object's effective transform at `timeUs`, honoring per-channel restricted
 * expressions ahead of animation curves/static values (§20.3, ADR-0015,
 * WP-10.4). Never throws for a bad expression — a failing channel falls back
 * to its curve/static value and reports a diagnostic instead. Does **not**
 * compose camera projection — use `evaluateCameraExpressionTransform` (WP-10.5)
 * when both a camera and expressions are in play.
 */
export function evaluateExpressionTransform(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
): EvaluatedExpressionTransform {
  return resolveObjectTransformWithExpressions(objectId, objectsById, timeUs);
}

/**
 * An object's effective transform at `timeUs`, composing parenting, per-channel
 * restricted expressions (anywhere in the parent/camera chain), and — when
 * `cameraId` is given — depth-only 2.5D camera projection, all together
 * (§20.3, ADR-0015, WP-10.5). `cameraId` undefined reproduces
 * `evaluateExpressionTransform`'s parenting+expression behavior exactly, so
 * the no-camera regression guarantee holds for this entry point too.
 */
export function evaluateCameraExpressionTransform(
  objectId: string,
  cameraId: string | undefined,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  compHeight: number,
): EvaluatedExpressionTransform {
  return resolveObjectTransformThroughCameraWithExpressions(
    objectId,
    cameraId,
    objectsById,
    timeUs,
    compHeight,
  );
}
