import type { Clip, TimeUs } from '@joy-media/project-schema';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';

export const MIN_PIXELS_PER_SECOND = 5;
export const MAX_PIXELS_PER_SECOND = 200;
export const DEFAULT_FREEZE_HOLD_US = 1_000_000;

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

/** CapCut-style fit: map full composition duration into the visible lane width. */
export function fitPixelsPerSecond(durationUs: number, widthPx: number, paddingPx = 24): number {
  const usable = Math.max(1, widthPx - paddingPx);
  const seconds = Math.max(1 / 1_000_000, durationUs / 1_000_000);
  const fitted = usable / seconds;
  // Fit is allowed below the manual zoom-slider minimum. Otherwise a long
  // video (for example 2h) can never fit in the viewport despite Fit being on.
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(1e-9, fitted));
}

export function clampPixelsPerSecond(value: number): number {
  if (!Number.isFinite(value)) return MIN_PIXELS_PER_SECOND;
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, value));
}

/** Nice major step candidates in microseconds (expanding with zoom-out). */
const RULER_MAJOR_US = [
  100_000, // 0.1s
  200_000,
  500_000,
  1_000_000, // 1s
  2_000_000,
  5_000_000,
  10_000_000,
  15_000_000,
  30_000_000,
  60_000_000, // 1m
  120_000_000,
  300_000_000, // 5m
  600_000_000,
  1_800_000_000, // 30m
  3_600_000_000, // 1h
  7_200_000_000, // 2h
  21_600_000_000, // 6h
  43_200_000_000, // 12h
  86_400_000_000, // 24h
] as const;

export interface RulerTick {
  readonly timeUs: TimeUs;
  readonly xPx: number;
  readonly major: boolean;
}

export interface BuildRulerTicksInput {
  readonly durationUs: TimeUs;
  readonly pixelsPerSecond: number;
  readonly originUs?: TimeUs;
  /** Minimum pixel gap between major ticks (default 80). */
  readonly minMajorPx?: number;
}

function pickMajorUs(pixelsPerSecond: number, minMajorPx: number): number {
  const pps = Math.max(1e-9, pixelsPerSecond);
  for (const majorUs of RULER_MAJOR_US) {
    const px = (majorUs / 1_000_000) * pps;
    if (px >= minMajorPx) return majorUs;
  }
  return RULER_MAJOR_US[RULER_MAJOR_US.length - 1]!;
}

function minorDivisor(majorUs: number): number {
  // Prefer /5; use /4 when major is a multiple of 2s but not 5/10/15…
  if (majorUs % 5_000_000 === 0) return 5;
  if (majorUs === 2_000_000 || majorUs === 200_000) return 4;
  return 5;
}

/** Build major/minor ruler ticks for the visible timeline span. */
export function buildRulerTicks(input: BuildRulerTicksInput): readonly RulerTick[] {
  const durationUs = Math.max(0, input.durationUs);
  const originUs = input.originUs ?? 0;
  const minMajorPx = input.minMajorPx ?? 80;
  const pps = Math.min(MAX_PIXELS_PER_SECOND, Math.max(1e-9, input.pixelsPerSecond));
  const viewport: TimelineViewport = { originUs, pixelsPerSecond: pps };
  const majorUs = pickMajorUs(pps, minMajorPx);
  const minorUs = Math.max(1, Math.round(majorUs / minorDivisor(majorUs)));

  const endUs = originUs + durationUs;
  const firstIndex = Math.ceil(originUs / minorUs);
  const lastIndex = Math.floor(endUs / minorUs);
  const ticks: RulerTick[] = [];

  for (let i = firstIndex; i <= lastIndex; i++) {
    const t = i * minorUs;
    if (t < originUs || t > endUs) continue;
    ticks.push({
      timeUs: t as TimeUs,
      xPx: timeToPixel(t as TimeUs, viewport),
      major: t % majorUs === 0,
    });
  }

  // Ensure origin is present when missing (e.g. not on the minor grid).
  if (ticks.length === 0 || ticks[0]!.timeUs !== originUs) {
    ticks.unshift({
      timeUs: originUs as TimeUs,
      xPx: timeToPixel(originUs as TimeUs, viewport),
      major: originUs % majorUs === 0,
    });
  }

  return ticks;
}

/** Compact ruler label: `M:SS` or `H:MM:SS` when ≥ 1 hour. */
export function formatRulerLabel(timeUs: TimeUs): string {
  const totalSec = Math.max(0, Math.floor(timeUs / 1_000_000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface TimedClip {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
}

/** Earliest start ≥ clip end that fits `clip.durationUs` without overlapping siblings. */
export function placeDuplicateAfter(clip: TimedClip, trackClips: readonly TimedClip[]): TimeUs {
  let candidate = clip.startUs + clip.durationUs;
  const others = [...trackClips]
    .filter((item) => item.id !== clip.id)
    .sort((a, b) => a.startUs - b.startUs);
  for (const other of others) {
    const otherEnd = other.startUs + other.durationUs;
    if (candidate + clip.durationUs <= other.startUs) break;
    if (candidate < otherEnd) candidate = otherEnd;
  }
  return candidate;
}

/** Returns the closest magnetic candidate inside the screen-space threshold. */
export function snapTime(
  proposedUs: TimeUs,
  candidates: readonly TimeUs[],
  viewport: TimelineViewport,
  thresholdPx = 8,
): TimeUs {
  if (candidates.length === 0) return proposedUs;
  const thresholdUs = (thresholdPx / viewport.pixelsPerSecond) * 1_000_000;
  let nearest: TimeUs;
  if (candidates.length >= 32) {
    const sorted = [...candidates].sort((a, b) => a - b);
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! < proposedUs) lo = mid + 1;
      else hi = mid;
    }
    const a = lo > 0 ? sorted[lo - 1]! : sorted[lo]!;
    const b = sorted[lo]!;
    const c = lo + 1 < sorted.length ? sorted[lo + 1]! : b;
    let best = b;
    if (Math.abs(a - proposedUs) < Math.abs(best - proposedUs)) best = a;
    if (Math.abs(c - proposedUs) < Math.abs(best - proposedUs)) best = c;
    nearest = best;
  } else {
    let best: TimeUs | undefined;
    for (const candidate of candidates) {
      if (best === undefined || Math.abs(candidate - proposedUs) < Math.abs(best - proposedUs)) {
        best = candidate;
      }
    }
    nearest = best!;
  }
  return Math.abs(nearest - proposedUs) <= thresholdUs ? nearest : proposedUs;
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

/**
 * The selection operation requested by a concrete editor gesture.
 *
 * Keeping this separate from the UI is important: a normal click replaces a
 * selection, whereas the platform modifier is the only gesture that toggles a
 * second clip into it.  The old timeline only exposed `toggleSelection`, which
 * made a normal click accumulate clips by accident.
 */
export type TimelineSelectionOperation = 'replace' | 'toggle' | 'clear';

/** Apply one atomic, de-duplicated selection gesture. */
export function applyTimelineSelection(
  selection: TimelineSelection,
  operation: TimelineSelectionOperation,
  clipIds: readonly string[] = [],
): TimelineSelection {
  const nextIds = [...new Set(clipIds)];
  if (operation === 'clear') return { clipIds: [] };
  if (operation === 'replace') return { clipIds: nextIds };

  const selected = new Set(selection.clipIds);
  for (const clipId of nextIds) {
    if (selected.has(clipId)) selected.delete(clipId);
    else selected.add(clipId);
  }
  return { clipIds: [...selected] };
}

export function toggleSelection(selection: TimelineSelection, clipId: string): TimelineSelection {
  return applyTimelineSelection(selection, 'toggle', [clipId]);
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

export function duplicateClipCommand(
  compositionId: string,
  trackId: string,
  clip: TimedClip,
  trackClips: readonly TimedClip[],
  newClipId: string,
): SpikeCommand {
  return {
    type: 'timeline.duplicateClip',
    payload: {
      compositionId,
      trackId,
      clipId: clip.id,
      newClipId,
      newStartUs: placeDuplicateAfter(clip, trackClips),
    },
  };
}

export function freezeFrameCommand(
  compositionId: string,
  trackId: string,
  clipId: string,
  atUs: TimeUs,
  freezeClipId: string,
  rightClipId: string,
  holdUs: TimeUs = DEFAULT_FREEZE_HOLD_US,
): SpikeCommand {
  return {
    type: 'timeline.freezeFrame',
    payload: {
      compositionId,
      trackId,
      clipId,
      atUs,
      holdUs,
      freezeClipId,
      rightClipId,
    },
  };
}

/** Reverse is a semantic direction toggle, not a negative browser playback rate. */
export function toggleClipReverseCommand(
  compositionId: string,
  trackId: string,
  clipId: string,
): SpikeCommand {
  return {
    type: 'timeline.toggleClipReverse',
    payload: { compositionId, trackId, clipId },
  };
}

/**
 * Build the replayable intent for an editable compound clip. The command layer
 * validates that the ids form a contiguous selection and derives the child
 * composition from the actual clips at execution time.
 */
export function createCompoundCommand(
  compositionId: string,
  trackId: string,
  clipIds: readonly string[],
  compoundCompositionId: string,
  compoundClipId: string,
  name?: string,
): SpikeCommand {
  return {
    type: 'timeline.createCompound',
    payload: {
      compositionId,
      trackId,
      clipIds,
      compoundCompositionId,
      compoundClipId,
      ...(name === undefined ? {} : { name }),
    },
  };
}

export interface TimelineTrackView {
  readonly id: string;
  readonly heightPx: number;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly solo: boolean;
  readonly muted?: boolean;
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
  flag: 'locked' | 'visible' | 'solo' | 'muted',
): TimelineTrackView {
  return { ...track, [flag]: !track[flag] };
}

/** Clip rate badge label for the timeline UI (`2×`; freeze uses a snowflake). */
export function clipRateLabel(clip: Clip): string | undefined {
  if (clip.kind !== 'video') return undefined;
  const rate = clip.playbackRate;
  if (rate === undefined || rate === 1) return clip.reversed === true ? '↺' : undefined;
  if (rate === 0) return '❄';
  const rounded = Number.isInteger(rate) ? String(rate) : rate.toFixed(2).replace(/\.?0+$/, '');
  return `${clip.reversed === true ? '↺ ' : ''}${rounded}×`;
}
