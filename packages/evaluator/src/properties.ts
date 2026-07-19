/** Pure active-interval and static-property evaluation (WP-01.3). */

import { rangeContainsUs } from '@joy-media/project-schema';
import type { TimeUs } from '@joy-media/project-schema';

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

/** Static values are immutable for a frame; animation/keyframes enter a later evaluator pass. */
export interface StaticProperty<T> {
  readonly value: T;
  readonly enabled?: boolean;
}

export function evaluateStaticProperty<T>(property: StaticProperty<T>): T | undefined {
  return property.enabled === false ? undefined : property.value;
}
