import type { TimeUs } from '@joy-media/project-schema';
import type { SpikeCommand } from '@joy-media/commands';
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

export interface DragPreview {
  readonly clipId: string;
  readonly originalStartUs: TimeUs;
  readonly proposedStartUs: TimeUs;
  readonly snappedStartUs: TimeUs;
}
/** Pointer movement stays ephemeral; only the final semantic command is durable. */
export function previewMove(
  clipId: string,
  originalStartUs: TimeUs,
  proposedStartUs: TimeUs,
  candidates: readonly TimeUs[],
  viewport: TimelineViewport,
): DragPreview {
  return {
    clipId,
    originalStartUs,
    proposedStartUs,
    snappedStartUs: snapTime(proposedStartUs, candidates, viewport),
  };
}
export function commitMove(
  compositionId: string,
  trackId: string,
  preview: DragPreview,
): SpikeCommand {
  return {
    type: 'timeline.moveClip',
    payload: { compositionId, trackId, clipId: preview.clipId, newStartUs: preview.snappedStartUs },
  };
}
export function visibleRange(
  viewport: TimelineViewport,
  widthPx: number,
): { readonly startUs: TimeUs; readonly endUs: TimeUs } {
  return { startUs: viewport.originUs, endUs: pixelToTime(widthPx, viewport) };
}
