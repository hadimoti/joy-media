import type { Composition } from '@joy-media/project-schema';

/** Default screen tolerance in pixels for snapping to timeline anchors. */
export const DEFAULT_SNAP_THRESHOLD_PX = 8;

export interface TimelineSnapOptions {
  readonly rawTimeUs: number;
  readonly snapping: boolean;
  readonly anchorsUs?: readonly number[];
  readonly frameUs: number;
  readonly toleranceUs?: number;
}

/**
 * Snaps a timeline microsecond timestamp.
 * - When snapping is ON: snaps to the nearest anchor (playhead, marker, clip edge)
 *   if within toleranceUs (screen distance); otherwise falls back to frame steps.
 * - When snapping is OFF: returns the raw time free of anchor or frame quantization.
 */
export function snapTimelineTimeUs({
  rawTimeUs,
  snapping,
  anchorsUs = [],
  frameUs,
  toleranceUs = 0,
}: TimelineSnapOptions): number {
  const raw = Number.isFinite(rawTimeUs) ? Math.max(0, rawTimeUs) : 0;
  if (!snapping) {
    return Math.round(raw);
  }

  const tolerance = Number.isFinite(toleranceUs) ? Math.max(0, toleranceUs) : 0;
  let nearest: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const anchor of anchorsUs) {
    if (!Number.isFinite(anchor) || anchor < 0) continue;
    const distance = Math.abs(anchor - raw);
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }

  if (nearest !== undefined && nearestDistance <= tolerance) {
    return Math.round(nearest);
  }

  const frame = Number.isFinite(frameUs) && frameUs > 0 ? frameUs : 1;
  return Math.max(0, Math.round(Math.round(raw / frame) * frame));
}

/**
 * Collects snap target timestamps (playhead, markers, and clip start/end edges).
 */
export function collectTimelineSnapAnchors({
  composition,
  markers = [],
  playheadUs,
  excludeClipId,
}: {
  readonly composition?: Composition;
  readonly markers?: readonly { readonly timeUs: number }[];
  readonly playheadUs?: number;
  readonly excludeClipId?: string;
}): readonly number[] {
  const anchors = new Set<number>();

  if (playheadUs !== undefined && Number.isFinite(playheadUs) && playheadUs >= 0) {
    anchors.add(Math.round(playheadUs));
  }

  for (const marker of markers) {
    if (Number.isFinite(marker.timeUs) && marker.timeUs >= 0) {
      anchors.add(Math.round(marker.timeUs));
    }
  }

  if (composition) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (excludeClipId !== undefined && clip.id === excludeClipId) continue;
        if (Number.isFinite(clip.startUs) && clip.startUs >= 0) {
          anchors.add(Math.round(clip.startUs));
          anchors.add(Math.round(clip.startUs + clip.durationUs));
        }
      }
    }
  }

  return [...anchors].sort((a, b) => a - b);
}
