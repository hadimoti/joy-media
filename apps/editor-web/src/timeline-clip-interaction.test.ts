import { describe, expect, it } from 'vitest';
import { ProjectHistory } from '@joy-media/commands';
import type { Clip, Composition, SpikeProject } from '@joy-media/project-schema';
import {
  buildTimelineClipInsertTransaction,
  buildTimelineClipGroupMoveTransaction,
  buildTimelineClipMoveTransaction,
  buildTimelineClipReplaceTransaction,
  keyboardTrimTimeUs,
} from './timeline-clip-interaction.js';

const CLIP: Clip = {
  id: 'clip-a',
  kind: 'video',
  assetId: 'asset-a',
  startUs: 1_000_000,
  durationUs: 2_000_000,
  sourceInUs: 0,
};

describe('timeline clip interaction', () => {
  it('inserts media between clips and pushes later clips as one undo step', () => {
    const left = { ...CLIP, id: 'left', startUs: 0, durationUs: 1_000_000 };
    const right = { ...CLIP, id: 'right', startUs: 3_000_000, durationUs: 1_000_000 };
    const composition = baseComposition([left, right]);
    const initial = projectWith(composition);
    const transaction = buildTimelineClipInsertTransaction({
      composition,
      trackId: 'V1',
      asset: { assetId: 'asset-new', displayName: 'new.mp4', durationUs: 2_000_000 },
      clipId: 'inserted',
      startUs: 1_500_000,
    });
    expect(transaction).toBeDefined();
    if (transaction === undefined) return;

    const history = new ProjectHistory(initial);
    history.apply(transaction);
    expect(
      history.present.compositions.root!.tracks[0]!.clips.map((clip) => ({
        id: clip.id,
        startUs: clip.startUs,
      })),
    ).toEqual([
      { id: 'left', startUs: 0 },
      { id: 'inserted', startUs: 1_500_000 },
      { id: 'right', startUs: 5_000_000 },
    ]);
    expect(history.undo()).toEqual(initial);
  });

  it('replaces a clip asset without changing its timing and one undo restores it', () => {
    const original = { ...CLIP, startUs: 4_000_000, sourceInUs: 750_000 };
    const composition = baseComposition([original]);
    const initial = projectWith(composition);
    const transaction = buildTimelineClipReplaceTransaction({
      composition,
      trackId: 'V1',
      clip: original,
      assetId: 'asset-replacement',
      displayName: 'replacement.mp4',
    });
    expect(transaction).toBeDefined();
    if (transaction === undefined) return;

    const history = new ProjectHistory(initial);
    history.apply(transaction);
    expect(history.present.compositions.root!.tracks[0]!.clips[0]).toEqual({
      ...original,
      assetId: 'asset-replacement',
    });
    expect(history.undo()).toEqual(initial);
  });

  it('builds one semantic atomic transaction for a cross-track move', () => {
    expect(
      buildTimelineClipMoveTransaction({
        compositionId: 'root',
        sourceTrackId: 'V1',
        targetTrackId: 'V2',
        clip: CLIP,
        targetClips: [],
        newStartUs: 4_000_000,
      }),
    ).toEqual({
      label: 'Move clip-a to V2',
      commands: [
        {
          type: 'timeline.moveElement',
          payload: {
            compositionId: 'root',
            sourceTrackId: 'V1',
            targetTrackId: 'V2',
            clipId: 'clip-a',
            newStartUs: 4_000_000,
          },
        },
      ],
    });
  });

  it('rejects an overlapping destination before dispatch', () => {
    expect(
      buildTimelineClipMoveTransaction({
        compositionId: 'root',
        sourceTrackId: 'V1',
        targetTrackId: 'V2',
        clip: CLIP,
        targetClips: [{ ...CLIP, id: 'occupied', startUs: 2_000_000 }],
        newStartUs: 3_000_000,
      }),
    ).toBeUndefined();
  });

  it('builds one atomic command for a selected group move', () => {
    expect(
      buildTimelineClipGroupMoveTransaction({
        compositionId: 'root',
        moves: [
          { sourceTrackId: 'V1', targetTrackId: 'V1', clipId: 'clip-a', newStartUs: 2_000_000 },
          { sourceTrackId: 'V1', targetTrackId: 'V1', clipId: 'clip-b', newStartUs: 4_000_000 },
        ],
      }),
    ).toMatchObject({
      label: 'Move 2 selected clips',
      commands: [
        {
          type: 'timeline.moveElements',
          payload: { moves: [{ clipId: 'clip-a' }, { clipId: 'clip-b' }] },
        },
      ],
    });
  });

  it('nudges either trim edge and clamps it to a valid range', () => {
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'start',
        key: 'ArrowRight',
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(1_100_000);
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'end',
        key: 'ArrowLeft',
        shiftKey: true,
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(2_000_000);
    expect(
      keyboardTrimTimeUs({
        clip: { ...CLIP, startUs: 0 },
        edge: 'start',
        key: 'ArrowLeft',
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(0);
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'end',
        key: 'Enter',
        timelineDurationUs: 10_000_000,
      }),
    ).toBeUndefined();
  });
});

function baseComposition(clips: readonly Clip[]): Composition {
  return {
    id: 'root',
    name: 'Root',
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    durationUs: 30_000_000,
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        family: 'visual',
        order: 0,
        enabled: true,
        clips: [...clips],
      },
    ],
  };
}

function projectWith(composition: Composition): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'project',
    rootCompositionId: composition.id,
    compositions: { [composition.id]: composition },
  };
}
