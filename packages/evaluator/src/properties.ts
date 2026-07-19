/** Pure active-interval and static-property evaluation (WP-01.3, WP-04.1). */

import { rangeContainsUs } from '@joy-media/project-schema';
import type { TimeUs, VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { resolveObjectTransform } from '@joy-media/motion-core';

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
