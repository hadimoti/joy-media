import { applyTransaction } from '@joy-media/commands';
import type { Composition } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  buildTimelineMediaImportTransaction,
  type TimelineMediaAsset,
} from './timeline-media-import.js';

// Add to timeline passes the live playhead with the "first-free" placement (defect 213): the clip starts at the
// playhead on the first visual track that is free there, instead of after whatever the first track already holds.
describe('Add to timeline placement (defect 213)', () => {
  const asset: TimelineMediaAsset = {
    id: 'clip-source',
    kind: 'video',
    displayName: 'source.mp4',
    descriptor: { durationUs: 3_000_000 },
  };

  it('puts the clip at the playhead on the first track that is free there', () => {
    const composition = twoVisualTracks();
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      [asset],
      1_000_000,
      new Set(),
      () => 'clip-new',
      { mode: 'first-free', startUs: 1_000_000 },
    );
    const result = applyTransaction(projectOf(composition), transaction).project;
    const second = result.compositions.root!.tracks.find((track) => track.id === 'video-second')!;

    expect(second.clips.map((clip) => ({ id: clip.id, startUs: clip.startUs }))).toEqual([
      { id: 'clip-new', startUs: 1_000_000 },
    ]);
  });

  it('uses the playhead on the first track when that track is free there', () => {
    const composition = twoVisualTracks();
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      [asset],
      7_000_000,
      new Set(),
      () => 'clip-new',
      { mode: 'first-free', startUs: 7_000_000 },
    );
    const result = applyTransaction(projectOf(composition), transaction).project;
    const first = result.compositions.root!.tracks.find((track) => track.id === 'video-main')!;

    expect(first.clips.find((clip) => clip.id === 'clip-new')?.startUs).toBe(7_000_000);
  });

  it('keeps the append placement when no placement mode is given', () => {
    const composition = twoVisualTracks();
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      [asset],
      1_000_000,
      new Set(),
      () => 'clip-new',
    );
    const result = applyTransaction(projectOf(composition), transaction).project;
    const first = result.compositions.root!.tracks.find((track) => track.id === 'video-main')!;

    expect(first.clips.find((clip) => clip.id === 'clip-new')?.startUs).toBe(5_000_000);
  });
});

function twoVisualTracks(): Composition {
  return {
    id: 'root',
    name: 'Root',
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    durationUs: 30_000_000,
    tracks: [
      {
        id: 'video-main',
        kind: 'video',
        family: 'visual',
        order: 0,
        enabled: true,
        clips: [
          {
            id: 'existing-video-clip',
            kind: 'video',
            assetId: 'existing-video',
            startUs: 0,
            durationUs: 5_000_000,
            sourceInUs: 0,
          },
        ],
      },
      {
        id: 'video-second',
        kind: 'video',
        family: 'visual',
        order: 1,
        enabled: true,
        clips: [],
      },
    ],
  };
}

function projectOf(composition: Composition) {
  return {
    schemaVersion: 0 as const,
    id: 'project',
    rootCompositionId: composition.id,
    compositions: { [composition.id]: composition },
  };
}
