import type { SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, withClips } from './spike.js';

/** Frozen 30-second social edit shared by timeline, playback, persistence, and export tests. */
export interface ReferenceProject {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly durationUs: number;
  readonly formats: readonly { readonly width: number; readonly height: number }[];
}
export const REFERENCE_PROJECT: ReferenceProject = {
  id: 'golden-social-edit',
  revision: 1,
  title: 'Golden 30-second social edit',
  durationUs: 30_000_000,
  formats: [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ],
};

/**
 * A complete editable timeline for the reference manifest. Source names are
 * synthetic so the fixture remains redistributable and deterministic.
 */
export function buildReferenceSpikeProject(): SpikeProject {
  const base = emptySpikeProject({
    trackCount: 2,
    durationUs: REFERENCE_PROJECT.durationUs,
    frameRate: { num: 30, den: 1 },
  });
  const project = { ...base, id: REFERENCE_PROJECT.id };
  return withClips(
    withClips(project, 'track-0', [
      makeVideoClip('intro', 0, 10_000_000),
      makeVideoClip('product', 10_000_000, 10_000_000),
      makeVideoClip('outro', 20_000_000, 10_000_000),
    ]),
    'track-1',
    [makeVideoClip('b-roll-a', 0, 15_000_000), makeVideoClip('b-roll-b', 15_000_000, 15_000_000)],
  );
}
