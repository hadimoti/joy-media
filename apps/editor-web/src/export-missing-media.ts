import type { SpikeProject, TransitionV1 } from '@joy-media/project-schema';
import type { MissingMediaEntry } from './missing-media.js';
import { formatMonitorTimecode } from './monitor/monitor-timecode.js';
import { flattenRootTimelineVideoClips } from './timeline-nested-playback.js';

/**
 * One timeline clip, as the export sees it, whose file is missing from this profile (T-R04).
 * Export draws such a clip as black and silent when the owner chooses "Export anyway".
 */
export interface MissingExportClip {
  readonly clipId: string;
  readonly assetId: string;
  /** The file's name, as the project records it. */
  readonly name: string;
  /** True when the clip's picture source is missing. */
  readonly missingVisualSource: boolean;
  /** True when the configured audio source is missing. */
  readonly missingAudioSource: boolean;
  /** Root-timeline start and end, in microseconds. */
  readonly startUs: number;
  readonly endUs: number;
}

export type ExportAudioClipSources = Readonly<
  Record<string, { readonly sourceAssetId?: string } | undefined>
>;

/**
 * The clips whose visual or configured audio source is missing, in root-timeline order. It walks
 * the same flattened clips the export walks, so the warning and export agree. A clip with no file
 * (text, captions and the like) is never listed.
 */
export function missingExportClips(
  project: SpikeProject,
  missing: readonly MissingMediaEntry[],
  audioClipSources: ExportAudioClipSources = {},
): readonly MissingExportClip[] {
  if (missing.length === 0) return [];
  const byAsset = new Map(missing.map((entry) => [entry.assetId, entry]));
  const clips: MissingExportClip[] = [];
  for (const clip of flattenRootTimelineVideoClips(project)) {
    const visualEntry = byAsset.get(clip.assetId);
    const audioAssetId = audioClipSources[clip.id]?.sourceAssetId ?? clip.assetId;
    const audioEntry = audioAssetId === undefined ? undefined : byAsset.get(audioAssetId);
    const entry = visualEntry ?? audioEntry;
    if (entry === undefined) continue;
    clips.push({
      clipId: clip.id,
      assetId: entry.assetId,
      name: entry.record.displayName,
      missingVisualSource: visualEntry !== undefined,
      missingAudioSource: audioEntry !== undefined,
      startUs: clip.startUs,
      endUs: clip.startUs + clip.durationUs,
    });
  }
  return clips;
}

/** The ids of the listed clips, for leaving them out of the export's source preparation. */
export function missingExportClipIds(clips: readonly MissingExportClip[]): ReadonlySet<string> {
  return new Set(clips.map((clip) => clip.clipId));
}

/** The clips that have no picture source; their video stays black when export continues. */
export function missingExportVisualClipIds(
  clips: readonly MissingExportClip[],
): ReadonlySet<string> {
  return new Set(clips.filter((clip) => clip.missingVisualSource).map((clip) => clip.clipId));
}

/** The clips that have no configured audio source; their audio is silent when export continues. */
export function missingExportAudioClipIds(
  clips: readonly MissingExportClip[],
): ReadonlySet<string> {
  return new Set(clips.filter((clip) => clip.missingAudioSource).map((clip) => clip.clipId));
}

/** `hh:mm:ss:ff - hh:mm:ss:ff` for a listed clip, at the project's frame rate. */
export function formatMissingExportRange(clip: MissingExportClip, fps: number): string {
  return `${formatMonitorTimecode(clip.startUs, fps)} - ${formatMonitorTimecode(clip.endUs, fps)}`;
}

/**
 * True when the export has nothing to draw and must stop. With missing clips accepted ("Export
 * anyway") an empty visual set is allowed: the export draws the timeline's background for the
 * full duration, and the missing clips' places stay empty.
 */
export function exportLacksVisualSource(
  sourcedVisualClipCount: number,
  hasHtmlScenes: boolean,
  missingClipCount: number,
): boolean {
  return sourcedVisualClipCount === 0 && !hasHtmlScenes && missingClipCount === 0;
}

interface ClipListLike {
  readonly tracks: readonly {
    readonly clips: readonly {
      readonly id: string;
      readonly startUs: number;
      readonly durationUs: number;
    }[];
  }[];
}

/** A clip's place on the timeline, in microseconds. */
interface ClipRange {
  readonly startUs: number;
  readonly durationUs: number;
}

/** The export's frame grid, as the frame loop renders it (App's export `paintFrame`). */
interface ExportFrames {
  readonly durationUs: number;
  readonly frameRate: number;
  readonly frameCount: number;
}

/** The time frame `index` is painted at: the frame loop's formula, capped to the last microsecond. */
function exportFrameSampleUs(index: number, frames: ExportFrames): number {
  return Math.min(frames.durationUs - 1, Math.floor((index * 1_000_000) / frames.frameRate));
}

/**
 * Whether a frame of the export is painted at a time inside the range. Frames are a frame apart, so a range that lies
 * between two frames is never painted, even when it overlaps the export: a title active from 4.99 s to 5 s of a 5 s
 * export at 30 fps misses the last frame, which is painted at 4.9667 s (review P2).
 */
function exportFrameSamplesRange(range: ClipRange, frames: ExportFrames): boolean {
  const startUs = Math.max(0, range.startUs);
  const endUs = range.startUs + range.durationUs;
  // The first frame painted at or after startUs. Starting one frame early absorbs float rounding at the boundary.
  let index = Math.max(0, Math.ceil((startUs * frames.frameRate) / 1_000_000) - 1);
  for (; index < frames.frameCount; index += 1) {
    const sampleUs = exportFrameSampleUs(index, frames);
    if (sampleUs >= endUs) return false;
    if (sampleUs >= startUs) return true;
  }
  return false;
}

/**
 * Whether a title or a shape is drawn in the export: a frame of the export is painted inside a visible timeline clip
 * that binds it, or no clip binds it (an old project's overlay stays visible, as isBoundObjectActive draws it). Such an
 * object draws over the background, so a project made only of titles has a visual source even with no video clip
 * (defect 211). A clip outside the export length (review P1), or one that no frame falls in (review P2), does not
 * count. Every range of a clip counts, because isBoundObjectActive reads every composition.
 */
export function exportHasDrawnTextOrShape(input: {
  readonly visualObjects: Readonly<Record<string, { readonly id: string; readonly kind: string }>>;
  /** `pluginData['joy.clipObjects']`: clip id to object id. */
  readonly clipObjects: unknown;
  readonly compositionSets: readonly Readonly<Record<string, ClipListLike>>[];
  readonly hiddenClipIds: ReadonlySet<string>;
  /** The export length in microseconds, as the frame loop renders it. */
  readonly durationUs: number;
  /** The export's frame rate and frame count: the frame loop paints each frame at its own sample time. */
  readonly frameRate: number;
  readonly frameCount: number;
}): boolean {
  const bindings: Record<string, unknown> =
    input.clipObjects !== null &&
    typeof input.clipObjects === 'object' &&
    !Array.isArray(input.clipObjects)
      ? (input.clipObjects as Record<string, unknown>)
      : {};
  const visibleClipRanges = new Map<string, ClipRange[]>();
  for (const compositions of input.compositionSets) {
    for (const composition of Object.values(compositions)) {
      for (const track of composition.tracks) {
        for (const clip of track.clips) {
          if (input.hiddenClipIds.has(clip.id)) continue;
          const ranges = visibleClipRanges.get(clip.id) ?? [];
          ranges.push({ startUs: clip.startUs, durationUs: clip.durationUs });
          visibleClipRanges.set(clip.id, ranges);
        }
      }
    }
  }
  const frames: ExportFrames = {
    durationUs: input.durationUs,
    frameRate: input.frameRate,
    frameCount: input.frameCount,
  };
  const boundToVisibleClip = new Set<string>();
  const boundToAnyClip = new Set<string>();
  for (const [clipId, objectId] of Object.entries(bindings)) {
    if (typeof objectId !== 'string') continue;
    boundToAnyClip.add(objectId);
    const ranges = visibleClipRanges.get(clipId) ?? [];
    if (ranges.some((range) => exportFrameSamplesRange(range, frames))) {
      boundToVisibleClip.add(objectId);
    }
  }
  return Object.values(input.visualObjects).some(
    (object) =>
      (object.kind === 'text' || object.kind === 'shape') &&
      (boundToVisibleClip.has(object.id) || !boundToAnyClip.has(object.id)),
  );
}

/**
 * The transitions the export may draw. A transition with a missing clip on either side is
 * dropped, so the clip that is present plays as a plain cut and nothing blends against nothing.
 */
export function transitionsWithoutMissingClips(
  transitions: readonly TransitionV1[],
  missingClipIds: ReadonlySet<string>,
): readonly TransitionV1[] {
  if (missingClipIds.size === 0) return transitions;
  return transitions.filter(
    (transition) =>
      !missingClipIds.has(transition.leftClipId) && !missingClipIds.has(transition.rightClipId),
  );
}
