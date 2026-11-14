import { describe, expect, it } from 'vitest';
import { ProjectHistory } from '@joy-media/commands';
import type { Clip, Composition, SpikeProject } from '@joy-media/project-schema';
import {
  buildTimelineClipInsertTransaction,
  buildTimelineClipGroupMoveTransaction,
  buildDuplicateSelectionTransaction,
  buildTimelineClipMoveTransaction,
  nearestFreeStartUs,
  planClipLandings,
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

describe('nearestFreeStartUs (a drop on a taken spot)', () => {
  const clip = (id: string, startUs: number, durationUs: number) => ({
    ...CLIP,
    id,
    startUs,
    durationUs,
  });

  it('keeps a free drop where it is', () => {
    expect(
      nearestFreeStartUs({
        clips: [clip('a', 0, 2_000_000)],
        durationUs: 1_000_000,
        desiredStartUs: 5_000_000,
      }),
    ).toBe(5_000_000);
  });

  it('moves a drop on a taken spot to the nearest free start, after or before the clip', () => {
    const clips = [clip('a', 2_000_000, 4_000_000)];
    expect(nearestFreeStartUs({ clips, durationUs: 1_000_000, desiredStartUs: 5_000_000 })).toBe(
      6_000_000,
    );
    expect(nearestFreeStartUs({ clips, durationUs: 1_000_000, desiredStartUs: 2_500_000 })).toBe(
      1_000_000,
    );
  });

  it('does not count the clip that is being moved on its own track', () => {
    const clips = [clip('self', 2_000_000, 4_000_000)];
    expect(
      nearestFreeStartUs({
        clips,
        durationUs: 4_000_000,
        desiredStartUs: 3_000_000,
        ignoreClipId: 'self',
      }),
    ).toBe(3_000_000);
  });

  it('never returns a spot that overlaps, also when the gaps are too small', () => {
    const clips = [clip('a', 0, 3_000_000), clip('b', 4_000_000, 3_000_000)];
    expect(nearestFreeStartUs({ clips, durationUs: 2_000_000, desiredStartUs: 1_000_000 })).toBe(
      7_000_000,
    );
  });
});

describe('planClipLandings (a clip or a group lands at the nearest free spot)', () => {
  const clip = (id: string, startUs: number, durationUs: number): Clip => ({
    ...CLIP,
    id,
    startUs,
    durationUs,
  });
  const member = (c: Clip, track = 'V1', target = track) => ({
    clip: c,
    sourceTrackId: track,
    targetTrackId: target,
  });

  it('keeps a free single drop and shifts a taken one', () => {
    const a = clip('a', 0, 1_000_000);
    const b = clip('b', 4_000_000, 2_000_000);
    const tracks = [{ id: 'V1', clips: [a, b] }];
    expect(
      planClipLandings({
        members: [member(a)],
        tracks,
        anchorClipId: 'a',
        desiredStartUs: 2_000_000,
      })?.[0]?.startUs,
    ).toBe(2_000_000);
    expect(
      planClipLandings({
        members: [member(a)],
        tracks,
        anchorClipId: 'a',
        desiredStartUs: 5_000_000,
      })?.[0]?.startUs,
    ).toBe(6_000_000);
  });

  it('moves a group together, keeping its shape, past an obstacle', () => {
    const a = clip('a', 0, 1_000_000);
    const b = clip('b', 2_000_000, 1_000_000);
    const wall = clip('wall', 5_000_000, 2_000_000);
    const tracks = [{ id: 'V1', clips: [a, b, wall] }];
    const landings = planClipLandings({
      members: [member(a), member(b)],
      tracks,
      anchorClipId: 'a',
      desiredStartUs: 6_000_000,
    });
    // b would sit at 8 s inside the wall: the whole group slides past it, as one.
    expect(landings?.map((landing) => landing.startUs)).toEqual([7_000_000, 9_000_000]);
    const gap = (landings?.[1]?.startUs ?? 0) - (landings?.[0]?.startUs ?? 0);
    expect(gap).toBe(2_000_000);
  });

  it('lets the group land before the obstacle when that is nearer', () => {
    const a = clip('a', 0, 1_000_000);
    const b = clip('b', 1_000_000, 1_000_000);
    const wall = clip('wall', 6_000_000, 2_000_000);
    const landings = planClipLandings({
      members: [member(a), member(b)],
      tracks: [{ id: 'V1', clips: [a, b, wall] }],
      anchorClipId: 'a',
      desiredStartUs: 5_500_000,
    });
    expect(landings?.map((landing) => landing.startUs)).toEqual([4_000_000, 5_000_000]);
  });

  it('never sends a clip before the start of the track', () => {
    const a = clip('a', 2_000_000, 1_000_000);
    const b = clip('b', 3_000_000, 1_000_000);
    const landings = planClipLandings({
      members: [member(a), member(b)],
      tracks: [{ id: 'V1', clips: [a, b] }],
      anchorClipId: 'a',
      desiredStartUs: -5_000_000,
    });
    expect(landings?.map((landing) => landing.startUs)).toEqual([0, 1_000_000]);
  });

  it('does not count the moved clips as obstacles and lands on another row', () => {
    const a = clip('a', 0, 2_000_000);
    const other = clip('other', 1_000_000, 3_000_000);
    const landings = planClipLandings({
      members: [member(a, 'V1', 'V2')],
      tracks: [
        { id: 'V1', clips: [a] },
        { id: 'V2', clips: [other] },
      ],
      anchorClipId: 'a',
      desiredStartUs: 1_500_000,
    });
    expect(landings?.[0]).toMatchObject({ targetTrackId: 'V2', startUs: 4_000_000 });
  });

  it('builds a group transaction that applies cleanly', () => {
    const a = clip('a', 0, 1_000_000);
    const b = clip('b', 2_000_000, 1_000_000);
    const wall = clip('wall', 5_000_000, 2_000_000);
    const composition = baseComposition([a, b, wall]);
    const landings = planClipLandings({
      members: [member(a), member(b)],
      tracks: composition.tracks,
      anchorClipId: 'a',
      desiredStartUs: 6_000_000,
    });
    const transaction = buildTimelineClipGroupMoveTransaction({
      compositionId: composition.id,
      moves: (landings ?? []).map((landing) => ({
        sourceTrackId: landing.sourceTrackId,
        targetTrackId: landing.targetTrackId,
        clipId: landing.clipId,
        newStartUs: landing.startUs,
      })),
    });
    expect(transaction).toBeDefined();
    const history = new ProjectHistory(projectWith(composition));
    history.apply(transaction!);
    const clips = history.present.compositions[composition.id]?.tracks[0]?.clips ?? [];
    expect(clips.find((c) => c.id === 'a')?.startUs).toBe(7_000_000);
    expect(clips.find((c) => c.id === 'b')?.startUs).toBe(9_000_000);
  });
});

describe('buildDuplicateSelectionTransaction (Ctrl/Cmd+D)', () => {
  const composition = {
    id: 'root',
    tracks: [
      {
        id: 'V1',
        locked: false,
        clips: [
          { ...CLIP, id: 'a', startUs: 0, durationUs: 2_000_000 },
          { ...CLIP, id: 'b', startUs: 2_000_000, durationUs: 2_000_000 },
        ],
      },
      { id: 'V2', locked: true, clips: [{ ...CLIP, id: 'c', startUs: 0, durationUs: 1_000_000 }] },
    ],
  } as unknown as Composition;

  it('duplicates every selected clip in one transaction, copies after copies on the same track', () => {
    const { transaction, lockedSkipped } = buildDuplicateSelectionTransaction({
      composition,
      selectedIds: ['a', 'b'],
      label: () => 'clip',
      idSuffix: 'x',
    });
    expect(lockedSkipped).toBe(0);
    expect(transaction?.label).toBe('Duplicate 2 clips');
    const starts = transaction?.commands.map(
      (command) => (command.payload as { newStartUs: number }).newStartUs,
    );
    expect(starts).toEqual([4_000_000, 6_000_000]);
  });

  it('leaves out clips on a locked track and says how many', () => {
    const { transaction, lockedSkipped } = buildDuplicateSelectionTransaction({
      composition,
      selectedIds: ['c'],
      label: () => 'clip',
      idSuffix: 'x',
    });
    expect(transaction).toBeUndefined();
    expect(lockedSkipped).toBe(1);
  });
});
