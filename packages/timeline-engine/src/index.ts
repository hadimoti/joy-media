import type { TimeUs } from '@joy-media/project-schema';
export interface TimelineViewport {
  readonly originUs: TimeUs;
  readonly pixelsPerSecond: number;
}
export function timeToPixel(timeUs: TimeUs, viewport: TimelineViewport): number {
  return ((timeUs - viewport.originUs) / 1_000_000) * viewport.pixelsPerSecond;
}
export function pixelToTime(pixel: number, viewport: TimelineViewport): TimeUs {
  return Math.max(
    0,
    Math.round(viewport.originUs + (pixel / viewport.pixelsPerSecond) * 1_000_000),
  );
}
/** Returns the closest magnetic candidate inside the screen-space threshold. */
export function snapTime(
  proposedUs: TimeUs,
  candidates: readonly TimeUs[],
  viewport: TimelineViewport,
  thresholdPx = 8,
): TimeUs {
  const thresholdUs = (thresholdPx / viewport.pixelsPerSecond) * 1_000_000;
  const nearest = candidates.reduce<TimeUs | undefined>(
    (best, candidate) =>
      best === undefined || Math.abs(candidate - proposedUs) < Math.abs(best - proposedUs)
        ? candidate
        : best,
    undefined,
  );
  return nearest !== undefined && Math.abs(nearest - proposedUs) <= thresholdUs
    ? nearest
    : proposedUs;
}
