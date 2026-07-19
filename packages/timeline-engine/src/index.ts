import type { TimeUs } from '@joy-media/project-schema';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
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

export interface TimelineSelection {
  readonly clipIds: readonly string[];
}
export function toggleSelection(selection: TimelineSelection, clipId: string): TimelineSelection {
  return selection.clipIds.includes(clipId)
    ? { clipIds: selection.clipIds.filter((id) => id !== clipId) }
    : { clipIds: [...selection.clipIds, clipId] };
}
export function trimCommand(
  compositionId: string,
  trackId: string,
  clipId: string,
  edge: 'start' | 'end',
  timeUs: TimeUs,
): SpikeCommand {
  return edge === 'start'
    ? {
        type: 'timeline.trimClipStart',
        payload: { compositionId, trackId, clipId, newStartUs: timeUs },
      }
    : {
        type: 'timeline.trimClipEnd',
        payload: { compositionId, trackId, clipId, newEndUs: timeUs },
      };
}
export function splitCommand(
  compositionId: string,
  trackId: string,
  clipId: string,
  atUs: TimeUs,
  newClipId: string,
): SpikeCommand {
  return {
    type: 'timeline.splitClip',
    payload: { compositionId, trackId, clipId, atUs, newClipId },
  };
}
export interface TimedClip {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
}
export function rippleDelete(
  compositionId: string,
  trackId: string,
  clips: readonly TimedClip[],
  clipId: string,
): CommandTransaction {
  const target = clips.find((clip) => clip.id === clipId);
  if (target === undefined) throw new RangeError(`unknown clip ${clipId}`);
  const commands: SpikeCommand[] = [
    { type: 'timeline.removeClip', payload: { compositionId, trackId, clipId } },
  ];
  for (const clip of clips
    .filter((item) => item.startUs >= target.startUs + target.durationUs)
    .sort((a, b) => a.startUs - b.startUs))
    commands.push({
      type: 'timeline.moveClip',
      payload: {
        compositionId,
        trackId,
        clipId: clip.id,
        newStartUs: clip.startUs - target.durationUs,
      },
    });
  return { label: 'Ripple delete', commands };
}

export interface TimelineTrackView {
  readonly id: string;
  readonly heightPx: number;
  readonly locked: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
}
export function virtualTracks(
  tracks: readonly TimelineTrackView[],
  scrollTopPx: number,
  viewportHeightPx: number,
): readonly TimelineTrackView[] {
  let offset = 0;
  return tracks.filter((track) => {
    const top = offset;
    offset += track.heightPx;
    return top + track.heightPx >= scrollTopPx && top <= scrollTopPx + viewportHeightPx;
  });
}
export function toggleTrackFlag(
  track: TimelineTrackView,
  flag: 'locked' | 'muted' | 'solo',
): TimelineTrackView {
  return { ...track, [flag]: !track[flag] };
}
