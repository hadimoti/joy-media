import type { Clip, TimeUs } from '@joy-media/project-schema';
import { normalizePlaybackRate } from '@joy-media/project-schema';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';

export const MIN_PIXELS_PER_SECOND = 5;
export const MAX_PIXELS_PER_SECOND = 200;
export const DEFAULT_FREEZE_HOLD_US = 1_000_000;

export interface SourceTimeClip {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
  readonly sourceInUs: TimeUs;
  readonly playbackRate?: number;
}

export interface SourceTimeTransition {
  readonly rightClipId: string;
  readonly durationUs: TimeUs;
}

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

/**
 * End-exclusive composition playhead -> source time; returns undefined outside the clip body.
 * Fractional playback-rate math rounds down so every returned source time stays on an integer
 * microsecond boundary.
 */
export function sourceTimeAtPlayhead(clip: SourceTimeClip, playheadUs: number): number | undefined {
  if (playheadUs < clip.startUs || playheadUs >= clip.startUs + clip.durationUs) return undefined;
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return clip.sourceInUs;
  return floorSourceTime(clip.sourceInUs + (playheadUs - clip.startUs) * rate);
}

/** Last playable integer source sample before the clip's source-out boundary. */
export function finalSourceTimeUs(clip: SourceTimeClip): number {
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return clip.sourceInUs;
  return Math.max(clip.sourceInUs, ceilSourceTime(clip.sourceInUs + clip.durationUs * rate) - 1);
}

/**
 * Pure frame-planning helper: before a clip starts, transitions may preview the incoming clip
 * from the overlap window; after the clip ends, clamp to the last playable sample.
 */
export function sourceTimeForTransitionSample(
  clip: SourceTimeClip,
  playheadUs: number,
  transition?: SourceTimeTransition,
): number {
  if (transition !== undefined && clip.id === transition.rightClipId && playheadUs < clip.startUs) {
    const rate = normalizePlaybackRate(clip.playbackRate);
    if (rate === 0) return clip.sourceInUs;
    const windowStart = clip.startUs - transition.durationUs;
    return Math.min(
      finalSourceTimeUs(clip),
      floorSourceTime(clip.sourceInUs + Math.max(0, playheadUs - windowStart) * rate),
    );
  }
  const sourceTimeUs = sourceTimeAtPlayhead(clip, playheadUs);
  if (sourceTimeUs !== undefined) return sourceTimeUs;
  if (playheadUs < clip.startUs) return clip.sourceInUs;
  return finalSourceTimeUs(clip);
}

function floorSourceTime(value: number): number {
  return Math.floor(value);
}

function ceilSourceTime(value: number): number {
  return Math.ceil(value);
}

/** CapCut-style fit: map full composition duration into the visible lane width. */
export function fitPixelsPerSecond(durationUs: number, widthPx: number, paddingPx = 24): number {
  const usable = Math.max(1, widthPx - paddingPx);
  const seconds = Math.max(1 / 1_000_000, durationUs / 1_000_000);
  const fitted = usable / seconds;
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, fitted));
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
  const pps = Math.max(1e-6, pixelsPerSecond);
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
  const pps = clampPixelsPerSecond(input.pixelsPerSecond);
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

/** Clip rate badge label for the timeline UI (`2×`; freeze uses a snowflake). */
export function clipRateLabel(clip: Clip): string | undefined {
  if (clip.kind !== 'video') return undefined;
  const rate = clip.playbackRate;
  if (rate === undefined || rate === 1) return undefined;
  if (rate === 0) return '❄';
  const rounded = Number.isInteger(rate) ? String(rate) : rate.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}×`;
}
