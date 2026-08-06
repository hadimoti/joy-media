/**
 * Timeline playback helpers (gap-tolerant advance + clip lookup).
 *
 * JOY-00X regression: playback stopped after the first clip because, when a
 * clip ended into a gap (non-contiguous clips), `syncMediaToPlayhead` found no
 * clip at the boundary and returned `false` — silently ending playback. These
 * helpers keep playback advancing to the next video clip, skipping gaps.
 */

export interface PlaybackClip {
  readonly kind: 'video' | 'audio' | 'caption' | string;
  readonly id: string;
  readonly startUs: number;
  readonly durationUs: number;
}

export interface PlaybackTrack {
  readonly id: string;
  readonly clips: readonly PlaybackClip[];
}

export interface PlaybackComposition {
  readonly id: string;
  readonly durationUs: number;
  readonly tracks: readonly PlaybackTrack[];
}

export interface PlaybackProject {
  readonly compositions: Readonly<Record<string, PlaybackComposition>>;
  readonly rootCompositionId: string;
}

/** The video clip whose [startUs, startUs+durationUs) intervals cover `playheadUs`. */
export function activeVideoClipAt(
  project: PlaybackProject,
  playheadUs: number,
): PlaybackClip | undefined {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return undefined;
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      if (
        clip.kind === 'video' &&
        playheadUs >= clip.startUs &&
        playheadUs < clip.startUs + clip.durationUs
      ) {
        return clip;
      }
    }
  }
  return undefined;
}

/**
 * Earliest video clip that starts at or after `afterUs` (across all tracks).
 * Returns `undefined` when nothing plays at/after that time. Used to advance
 * playback across gaps instead of stopping.
 */
export function nextVideoClipAtOrAfter(
  project: PlaybackProject,
  afterUs: number,
): PlaybackClip | undefined {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return undefined;
  let best: PlaybackClip | undefined;
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'video') continue;
      if (clip.startUs < afterUs) continue;
      if (best === undefined || clip.startUs < best.startUs) best = clip;
    }
  }
  return best;
}
