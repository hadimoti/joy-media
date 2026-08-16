import { applyTransaction } from '@joy-media/commands';
import type { Composition } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  buildTimelineMediaImportTransaction,
  type TimelineMediaAsset,
} from './timeline-media-import.js';

describe('buildTimelineMediaImportTransaction', () => {
  it('places a batch on matching tracks without overlap and preserves real durations', () => {
    const composition = baseComposition();
    const assets: TimelineMediaAsset[] = [
      media('video-a', 'video', 3_000_000),
      media('video-b', 'image'),
      media('audio-a', 'audio', 1_000_000),
    ];
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      assets,
      1_000_000,
      new Set(),
      (asset) => `import-${asset.id}`,
    );
    const project = {
      schemaVersion: 0 as const,
      id: 'project',
      rootCompositionId: composition.id,
      compositions: { [composition.id]: composition },
    };
    const result = applyTransaction(project, transaction).project;
    const video = result.compositions.root!.tracks.find((track) => track.id === 'video-main')!;

    expect(transaction.commands).toHaveLength(3);
    expect(
      video.clips.map((clip) => ({
        assetId: clip.kind === 'video' ? clip.assetId : clip.compositionId,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
      })),
    ).toEqual([
      { assetId: 'existing-video', startUs: 0, durationUs: 5_000_000 },
      { assetId: 'video-a', startUs: 5_000_000, durationUs: 3_000_000 },
      { assetId: 'video-b', startUs: 8_000_000, durationUs: 5_000_000 },
      { assetId: 'audio-a', startUs: 13_000_000, durationUs: 1_000_000 },
    ]);
  });

  it('creates each missing semantic track once within the same transaction', () => {
    const composition = { ...baseComposition(), tracks: [] };
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      [media('voice-a', 'audio'), media('voice-b', 'audio'), media('still', 'image')],
      0,
      new Set(),
      (asset) => `import-${asset.id}`,
    );

    expect(transaction.commands.map((command) => command.type)).toEqual([
      'timeline.addTrack',
      'timeline.insertClip',
      'timeline.insertClip',
      'timeline.insertClip',
    ]);
    expect(transaction.commands[0]).toMatchObject({
      payload: { track: { id: 'track-1', clips: [] } },
    });
    expect(transaction.commands[1]).toMatchObject({
      payload: { trackId: 'track-1', clip: { assetId: 'voice-a', startUs: 0 } },
    });
    expect(transaction.commands[2]).toMatchObject({
      payload: { trackId: 'track-1', clip: { assetId: 'voice-b', startUs: 5_000_000 } },
    });
    expect(transaction.commands[3]).toMatchObject({
      payload: { trackId: 'track-1', clip: { assetId: 'still', startUs: 10_000_000 } },
    });
  });

  it('never inserts into a locked matching track', () => {
    const composition = baseComposition();
    const transaction = buildTimelineMediaImportTransaction(
      composition,
      [media('new-video', 'video')],
      0,
      new Set(['video-main']),
      () => 'new-clip',
    );
    expect(transaction.commands).toEqual([
      expect.objectContaining({
        type: 'timeline.insertClip',
        payload: expect.objectContaining({ trackId: 'audio-main' }),
      }),
    ]);
  });
});

function media(
  id: string,
  kind: TimelineMediaAsset['kind'],
  durationUs?: number,
): TimelineMediaAsset {
  return {
    id,
    kind,
    displayName: `${id}.bin`,
    descriptor: durationUs === undefined ? {} : { durationUs },
  };
}

function baseComposition(): Composition {
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
        id: 'audio-main',
        kind: 'video',
        order: 1,
        enabled: true,
        clips: [
          {
            id: 'voice-existing',
            kind: 'video',
            assetId: 'voice-existing',
            startUs: 0,
            durationUs: 2_000_000,
            sourceInUs: 0,
          },
        ],
      },
    ],
  };
}
