/**
 * Builders for P00 spike projects (master plan §36-P0). Pure data, no I/O.
 */

import type {
  Clip,
  Composition,
  CompositionClip,
  SpikeProject,
  Track,
  VideoClip,
} from '@joy-media/project-schema';
import { rational } from '@joy-media/project-schema';

export const SECOND_US = 1_000_000;

export interface EmptySpikeProjectOptions {
  readonly trackCount?: number;
  readonly durationUs?: number;
  readonly frameRate?: { num: number; den: number };
}

/** A valid single-composition project with `trackCount` empty video tracks. */
export function emptySpikeProject(options: EmptySpikeProjectOptions = {}): SpikeProject {
  const trackCount = options.trackCount ?? 2;
  const rate = options.frameRate ?? { num: 30000, den: 1001 };
  const tracks: Track[] = [];
  for (let i = 0; i < trackCount; i++) {
    tracks.push({ id: `track-${i}`, kind: 'video', order: i, enabled: true, clips: [] });
  }
  const root: Composition = {
    id: 'root',
    name: 'Root',
    width: 1080,
    height: 1920,
    frameRate: rational(rate.num, rate.den),
    durationUs: options.durationUs ?? 60 * SECOND_US,
    tracks,
  };
  return {
    schemaVersion: 0,
    id: 'spike-project',
    rootCompositionId: root.id,
    compositions: { [root.id]: root },
  };
}

/** A video clip with a comfortable default source in-point so start-trims stay legal. */
export function makeVideoClip(
  id: string,
  startUs: number,
  durationUs: number,
  overrides: Partial<Omit<VideoClip, 'kind' | 'id'>> = {},
): VideoClip {
  return {
    kind: 'video',
    id,
    startUs,
    durationUs,
    assetId: `asset-${id}`,
    sourceInUs: 5 * SECOND_US,
    ...overrides,
  };
}

export function makeCompositionClip(
  id: string,
  startUs: number,
  durationUs: number,
  compositionId: string,
  childOffsetUs = 0,
): CompositionClip {
  return { kind: 'composition', id, startUs, durationUs, compositionId, childOffsetUs };
}

/** Returns a copy of the project with `clips` placed on one track (sorted by start). */
export function withClips(
  project: SpikeProject,
  trackId: string,
  clips: readonly Clip[],
): SpikeProject {
  const compId = project.rootCompositionId;
  const comp = project.compositions[compId];
  if (comp === undefined) throw new Error(`fixture: missing root composition`);
  const tracks = comp.tracks.map((track) =>
    track.id === trackId
      ? { ...track, clips: [...clips].sort((a, b) => a.startUs - b.startUs) }
      : track,
  );
  return {
    ...project,
    compositions: { ...project.compositions, [compId]: { ...comp, tracks } },
  };
}
