export interface TimelineRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface TimelinePoint {
  readonly x: number;
  readonly y: number;
}

/** Normalize a pointer rectangle so all drag directions share one hit-test path. */
export function normalizeTimelineRect(origin: TimelinePoint, point: TimelinePoint): TimelineRect {
  return {
    left: Math.min(origin.x, point.x),
    top: Math.min(origin.y, point.y),
    right: Math.max(origin.x, point.x),
    bottom: Math.max(origin.y, point.y),
  };
}

/** Inclusive edge intersection matches the visible selection outline. */
export function timelineRectsIntersect(left: TimelineRect, right: TimelineRect): boolean {
  return (
    left.left <= right.right &&
    left.right >= right.left &&
    left.top <= right.bottom &&
    left.bottom >= right.top
  );
}

/** A small movement remains an ordinary empty-lane click. */
export function hasExceededMarqueeThreshold(
  origin: TimelinePoint,
  point: TimelinePoint,
  thresholdPx = 4,
): boolean {
  return Math.hypot(point.x - origin.x, point.y - origin.y) >= thresholdPx;
}

export function unionTimelineSelection(
  baselineIds: readonly string[],
  hitIds: readonly string[],
  additive: boolean,
): readonly string[] {
  if (!additive) return [...hitIds];
  const seen = new Set(baselineIds);
  for (const id of hitIds) seen.add(id);
  return [...seen];
}
