import type { Composition } from '@joy-media/project-schema';
import type { TimelineTrackKind } from './timeline-track-kind.js';
import { timelineTrackCode } from './timeline-track-kind.js';

/** Allocate a collision-free, monotonic presentation id for a new track. */
const reservations = new WeakMap<object, Set<string>>();

export function allocateTimelineTrackId(
  composition: Pick<Composition, 'tracks'>,
  kind: TimelineTrackKind,
): string {
  const used = new Set(composition.tracks.map((track) => track.id));
  const key = composition as object;
  const reserved = reservations.get(key) ?? new Set<string>();
  reservations.set(key, reserved);
  const prefix = kind === 'audio' ? 'A' : kind === 'script' ? 'S' : 'V';
  let maxIndex = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of used) {
    const match = pattern.exec(id);
    if (match !== null) maxIndex = Math.max(maxIndex, Number(match[1]));
  }
  let index = Math.max(1, maxIndex + 1);
  let candidate = timelineTrackCode(kind, index);
  while (used.has(candidate) || reserved.has(candidate)) {
    candidate = timelineTrackCode(kind, ++index);
  }
  reserved.add(candidate);
  return candidate;
}
