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
  /** Root-timeline start and end, in microseconds. */
  readonly startUs: number;
  readonly endUs: number;
}

/**
 * The clips that the export would read from a missing file, in root-timeline order. It walks the
 * same flattened clips the export walks, so the warning and the export agree. A clip with no file
 * (text, captions and the like) is never listed.
 */
export function missingExportClips(
  project: SpikeProject,
  missing: readonly MissingMediaEntry[],
): readonly MissingExportClip[] {
  if (missing.length === 0) return [];
  const byAsset = new Map(missing.map((entry) => [entry.assetId, entry]));
  const clips: MissingExportClip[] = [];
  for (const clip of flattenRootTimelineVideoClips(project)) {
    const entry = byAsset.get(clip.assetId);
    if (entry === undefined) continue;
    clips.push({
      clipId: clip.id,
      assetId: clip.assetId,
      name: entry.record.displayName,
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
