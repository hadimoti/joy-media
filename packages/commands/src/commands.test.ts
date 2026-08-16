import { describe, expect, it } from 'vitest';
import type { SpikeProject } from '@joy-media/project-schema';
import { validateSpikeProject } from '@joy-media/project-schema';
import {
  emptySpikeProject,
  makeCompositionClip,
  makeVideoClip,
  SECOND_US,
  withClips,
} from '@joy-media/test-fixtures';
import type { SpikeCommand } from './commands.js';
import { applyCommand, COMMAND_REGISTRY, CommandError } from './commands.js';

const TARGET = { compositionId: 'root', trackId: 'track-0' } as const;

function baseProject(): SpikeProject {
  return withClips(emptySpikeProject(), 'track-0', [
    makeVideoClip('clip-a', 0, 2 * SECOND_US),
    makeVideoClip('clip-b', 3 * SECOND_US, 2 * SECOND_US),
  ]);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe(code);
    return;
  }
  throw new Error(`expected CommandError ${code}, but nothing was thrown`);
}

function clipsOf(
  project: SpikeProject,
): ReadonlyArray<{ id: string; startUs: number; durationUs: number }> {
  return project.compositions['root']!.tracks[0]!.clips.map((c) => ({
    id: c.id,
    startUs: c.startUs,
    durationUs: c.durationUs,
  }));
}

describe('applyCommand', () => {
  it('publishes every supported command through the registry', () => {
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual([
      'property.setTrackEnabled',
      'timeline.addTrack',
      'timeline.createCompound',
      'timeline.duplicateClip',
      'timeline.freezeFrame',
      'timeline.insertClip',
      'timeline.joinClips',
      'timeline.moveClip',
      'timeline.moveElement',
      'timeline.removeClip',
      'timeline.removeTrack',
      'timeline.renameTrack',
      'timeline.reorderTrack',
      'timeline.restoreCompound',
      'timeline.restoreTrackClips',
      'timeline.setClipRate',
      'timeline.setCompositionDimensions',
      'timeline.setTimeRemap',
      'timeline.splitClip',
      'timeline.toggleClipReverse',
      'timeline.trimClipEnd',
      'timeline.trimClipStart',
    ]);
  });
  it('inserts a clip into a gap and inverts to a remove', () => {
    const project = baseProject();
    const command: SpikeCommand = {
      type: 'timeline.insertClip',
      payload: { ...TARGET, clip: makeVideoClip('clip-c', 2 * SECOND_US, SECOND_US) },
    };
    const { project: next, inverse } = applyCommand(project, command);
    expect(clipsOf(next).map((c) => c.id)).toEqual(['clip-a', 'clip-c', 'clip-b']);
    expect(inverse.type).toBe('timeline.removeClip');
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('requires clips to be inserted separately so adding a track remains undo-safe', () => {
    const track = {
      id: 'undo-safe-track',
      kind: 'video' as const,
      order: 1,
      enabled: true,
      clips: [makeVideoClip('clip-c', 0, SECOND_US)],
    };
    expectCode(
      () =>
        applyCommand(emptySpikeProject(), {
          type: 'timeline.addTrack',
          payload: { compositionId: 'root', track },
        }),
      'COMMAND_VALIDATION_UNSUPPORTED',
    );
  });

  it('rejects overlapping inserts and duplicate ids', () => {
    const project = baseProject();
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.insertClip',
          payload: { ...TARGET, clip: makeVideoClip('clip-x', SECOND_US, SECOND_US) },
        }),
      'COMMAND_VALIDATION_OVERLAP',
    );
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.insertClip',
          payload: { ...TARGET, clip: makeVideoClip('clip-a', 6 * SECOND_US, SECOND_US) },
        }),
      'COMMAND_VALIDATION_DUPLICATE_ID',
    );
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.insertClip',
          payload: { ...TARGET, clip: makeVideoClip('clip-z', 6 * SECOND_US, 0) },
        }),
      'COMMAND_VALIDATION_RANGE',
    );
  });

  it('removes and re-inserts a clip losslessly', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.removeClip',
      payload: { ...TARGET, clipId: 'clip-a' },
    });
    expect(clipsOf(next).map((c) => c.id)).toEqual(['clip-b']);
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('moves a clip and inverts to a move back', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.moveClip',
      payload: { ...TARGET, clipId: 'clip-a', newStartUs: 6 * SECOND_US },
    });
    expect(clipsOf(next)).toEqual([
      { id: 'clip-b', startUs: 3 * SECOND_US, durationUs: 2 * SECOND_US },
      { id: 'clip-a', startUs: 6 * SECOND_US, durationUs: 2 * SECOND_US },
    ]);
    expect(applyCommand(next, inverse).project).toEqual(project);
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.moveClip',
          payload: { ...TARGET, clipId: 'clip-a', newStartUs: 4 * SECOND_US },
        }),
      'COMMAND_VALIDATION_OVERLAP',
    );
  });

  it('moves an element between neutral tracks and inverts losslessly', () => {
    const project = {
      ...baseProject(),
      compositions: {
        root: {
          ...baseProject().compositions.root!,
          tracks: [
            ...baseProject().compositions.root!.tracks,
            {
              id: 'track-1',
              kind: 'video' as const,
              name: 'Layer 2',
              order: 1,
              enabled: true,
              clips: [],
            },
          ],
        },
      },
    };
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.moveElement',
      payload: {
        compositionId: 'root',
        sourceTrackId: 'track-0',
        targetTrackId: 'track-1',
        clipId: 'clip-a',
        newStartUs: 0,
      },
    });
    expect(next.compositions.root!.tracks.find((track) => track.id === 'track-0')!.clips).toEqual([
      expect.objectContaining({ id: 'clip-b' }),
    ]);
    expect(next.compositions.root!.tracks.find((track) => track.id === 'track-1')!.clips).toEqual([
      expect.objectContaining({ id: 'clip-a' }),
    ]);
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('reorders and renames a track with exact inverses', () => {
    const project = baseProject();
    const reordered = applyCommand(project, {
      type: 'timeline.reorderTrack',
      payload: { compositionId: 'root', trackId: 'track-0', newOrder: 4 },
    });
    expect(reordered.project.compositions.root!.tracks[0]!.order).toBe(4);
    expect(applyCommand(reordered.project, reordered.inverse).project).toEqual(project);

    const renamed = applyCommand(project, {
      type: 'timeline.renameTrack',
      payload: { compositionId: 'root', trackId: 'track-0', newName: 'Foreground' },
    });
    expect(renamed.project.compositions.root!.tracks[0]!.name).toBe('Foreground');
    expect(applyCommand(renamed.project, renamed.inverse).project).toEqual(project);
  });

  it('trim start shifts the source in-point by the same delta', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.trimClipStart',
      payload: { ...TARGET, clipId: 'clip-a', newStartUs: SECOND_US / 2 },
    });
    const clip = next.compositions['root']!.tracks[0]!.clips[0]!;
    expect(clip).toMatchObject({
      startUs: SECOND_US / 2,
      durationUs: 1.5 * SECOND_US,
      sourceInUs: 5.5 * SECOND_US,
    });
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('trim start cannot underflow the source', () => {
    // clip-a has sourceInUs = 5 s; extending its start to -6 s is impossible anyway
    // (negative start), but shrinking source below 0 via a legal start is the case
    // to catch: give the clip a tiny sourceIn and extend the start leftward.
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-s', 2 * SECOND_US, SECOND_US, { sourceInUs: SECOND_US }),
    ]);
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.trimClipStart',
          payload: { ...TARGET, clipId: 'clip-s', newStartUs: SECOND_US / 2 },
        }),
      'COMMAND_VALIDATION_SOURCE_UNDERFLOW',
    );
  });

  it('trim end adjusts duration and inverts', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.trimClipEnd',
      payload: { ...TARGET, clipId: 'clip-a', newEndUs: SECOND_US },
    });
    expect(clipsOf(next)[0]).toMatchObject({ id: 'clip-a', durationUs: SECOND_US });
    expect(applyCommand(next, inverse).project).toEqual(project);
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.trimClipEnd',
          payload: { ...TARGET, clipId: 'clip-a', newEndUs: 0 },
        }),
      'COMMAND_VALIDATION_RANGE',
    );
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.trimClipEnd',
          payload: { ...TARGET, clipId: 'clip-a', newEndUs: 4 * SECOND_US },
        }),
      'COMMAND_VALIDATION_OVERLAP',
    );
  });

  it('split produces two source-continuous clips; join is its exact inverse', () => {
    const project = baseProject();
    const split: SpikeCommand = {
      type: 'timeline.splitClip',
      payload: { ...TARGET, clipId: 'clip-a', atUs: SECOND_US / 2, newClipId: 'clip-a2' },
    };
    const { project: next, inverse } = applyCommand(project, split);
    expect(clipsOf(next)).toEqual([
      { id: 'clip-a', startUs: 0, durationUs: SECOND_US / 2 },
      { id: 'clip-a2', startUs: SECOND_US / 2, durationUs: 1.5 * SECOND_US },
      { id: 'clip-b', startUs: 3 * SECOND_US, durationUs: 2 * SECOND_US },
    ]);
    const second = next.compositions['root']!.tracks[0]!.clips[1]!;
    expect(second).toMatchObject({ sourceInUs: 5.5 * SECOND_US, assetId: 'asset-clip-a' });
    expect(inverse.type).toBe('timeline.joinClips');
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('split works on nested composition clips via childOffset continuity', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeCompositionClip('clip-n', 0, 2 * SECOND_US, 'root-child', SECOND_US),
    ]);
    // add the referenced child composition so validation passes
    const child = {
      ...project.compositions['root']!,
      id: 'root-child',
      name: 'Child',
      tracks: [],
    };
    const valid: SpikeProject = {
      ...project,
      compositions: { ...project.compositions, 'root-child': child },
    };
    expect(validateSpikeProject(valid)).toEqual([]);
    const { project: next, inverse } = applyCommand(valid, {
      type: 'timeline.splitClip',
      payload: { ...TARGET, clipId: 'clip-n', atUs: SECOND_US / 2, newClipId: 'clip-n2' },
    });
    const secondHalf = next.compositions['root']!.tracks[0]!.clips[1]!;
    expect(secondHalf).toMatchObject({ kind: 'composition', childOffsetUs: 1.5 * SECOND_US });
    expect(applyCommand(next, inverse).project).toEqual(valid);
  });

  it('join refuses non-adjacent or source-discontinuous clips', () => {
    const project = baseProject();
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.joinClips',
          payload: { ...TARGET, firstClipId: 'clip-a', secondClipId: 'clip-b' },
        }),
      'COMMAND_VALIDATION_NOT_ADJACENT',
    );
    // adjacent but different assets
    const adjacent = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('left', 0, SECOND_US),
      makeVideoClip('right', SECOND_US, SECOND_US),
    ]);
    expectCode(
      () =>
        applyCommand(adjacent, {
          type: 'timeline.joinClips',
          payload: { ...TARGET, firstClipId: 'left', secondClipId: 'right' },
        }),
      'COMMAND_VALIDATION_NOT_ADJACENT',
    );
  });

  it('property change captures the old value in its inverse', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'property.setTrackEnabled',
      payload: { ...TARGET, enabled: false },
    });
    expect(next.compositions['root']!.tracks[0]!.enabled).toBe(false);
    expect(inverse).toEqual({
      type: 'property.setTrackEnabled',
      payload: { ...TARGET, enabled: true },
    });
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('rejects unknown targets with a coded error and never mutates input', () => {
    const project = baseProject();
    const snapshot = JSON.parse(JSON.stringify(project));
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.removeClip',
          payload: { compositionId: 'root', trackId: 'nope', clipId: 'clip-a' },
        }),
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
    );
    expect(project).toEqual(snapshot);
  });

  it('rejects commands whose result would be structurally invalid (cycle guard)', () => {
    // Inserting a clip that nests the root composition into itself must fail.
    const project = baseProject();
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.insertClip',
          payload: {
            ...TARGET,
            clip: makeCompositionClip('clip-cycle', 6 * SECOND_US, SECOND_US, 'root'),
          },
        }),
      'COMMAND_VALIDATION_RESULT_INVALID',
    );
  });

  it('commands serialize to JSON and apply identically after a round-trip', () => {
    const project = baseProject();
    const command: SpikeCommand = {
      type: 'timeline.splitClip',
      payload: { ...TARGET, clipId: 'clip-a', atUs: SECOND_US, newClipId: 'clip-a2' },
    };
    const revived = JSON.parse(JSON.stringify(command)) as SpikeCommand;
    expect(applyCommand(project, revived).project).toEqual(applyCommand(project, command).project);
  });

  it('duplicates a clip immediately after the original and inverts to remove', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
    ]);
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.duplicateClip',
      payload: { ...TARGET, clipId: 'clip-a', newClipId: 'clip-a-copy' },
    });
    expect(clipsOf(next)).toEqual([
      { id: 'clip-a', startUs: 0, durationUs: 2 * SECOND_US },
      { id: 'clip-a-copy', startUs: 2 * SECOND_US, durationUs: 2 * SECOND_US },
    ]);
    expect(inverse.type).toBe('timeline.removeClip');
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('rejects duplicate when the landing range overlaps', () => {
    const project = baseProject();
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.duplicateClip',
          payload: { ...TARGET, clipId: 'clip-a', newClipId: 'clip-a-copy' },
        }),
      'COMMAND_VALIDATION_OVERLAP',
    );
  });

  it('rejects duplicating a compound clip until it has an independent child composition', () => {
    const base = emptySpikeProject();
    const child = { ...base.compositions.root!, id: 'child', name: 'Child', tracks: [] };
    const project = withClips(
      {
        ...base,
        compositions: { ...base.compositions, child },
      },
      'track-0',
      [makeCompositionClip('compound-a', 0, 2 * SECOND_US, 'child')],
    );

    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.duplicateClip',
          payload: { ...TARGET, clipId: 'compound-a', newClipId: 'compound-copy' },
        }),
      'COMMAND_VALIDATION_UNSUPPORTED',
    );
  });

  it('sets clip rate and preserves source range by rescaling duration', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
    ]);
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.setClipRate',
      payload: { ...TARGET, clipId: 'clip-a', playbackRate: 2 },
    });
    const clip = next.compositions['root']!.tracks[0]!.clips[0]!;
    expect(clip.kind).toBe('video');
    if (clip.kind !== 'video') throw new Error('expected video');
    expect(clip.playbackRate).toBe(2);
    expect(clip.durationUs).toBe(SECOND_US);
    const restored = applyCommand(next, inverse).project;
    const back = restored.compositions['root']!.tracks[0]!.clips[0]!;
    expect(back.durationUs).toBe(2 * SECOND_US);
    expect(back.kind === 'video' && back.playbackRate === undefined).toBe(true);
  });

  it('sets a monotonic time remap and restores the legacy mapping on undo', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US, { playbackRate: 2, reversed: true }),
    ]);
    const timeRemap = {
      version: 2 as const,
      direction: 'forward' as const,
      keyframes: [
        { timeUs: 0, sourceTimeUs: 3 * SECOND_US, interpolation: 'linear' as const },
        { timeUs: SECOND_US, sourceTimeUs: 4 * SECOND_US, interpolation: 'linear' as const },
        { timeUs: 2 * SECOND_US, sourceTimeUs: 6 * SECOND_US, interpolation: 'linear' as const },
      ],
    };
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.setTimeRemap',
      payload: { ...TARGET, clipId: 'clip-a', timeRemap },
    });
    const clip = next.compositions.root!.tracks[0]!.clips[0]!;
    expect(clip).toMatchObject({ kind: 'video', timeRemap });
    expect((clip as Extract<typeof clip, { kind: 'video' }>).playbackRate).toBe(2);
    expect((clip as Extract<typeof clip, { kind: 'video' }>).reversed).toBe(true);
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('freezes at playhead, ripples the right half, and restores on undo', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
      makeVideoClip('clip-b', 3 * SECOND_US, SECOND_US),
    ]);
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.freezeFrame',
      payload: {
        ...TARGET,
        clipId: 'clip-a',
        atUs: SECOND_US,
        holdUs: SECOND_US,
        freezeClipId: 'clip-a-freeze',
        rightClipId: 'clip-a-right',
      },
    });
    expect(clipsOf(next)).toEqual([
      { id: 'clip-a', startUs: 0, durationUs: SECOND_US },
      { id: 'clip-a-freeze', startUs: SECOND_US, durationUs: SECOND_US },
      { id: 'clip-a-right', startUs: 2 * SECOND_US, durationUs: SECOND_US },
      { id: 'clip-b', startUs: 4 * SECOND_US, durationUs: SECOND_US },
    ]);
    const freeze = next.compositions['root']!.tracks[0]!.clips.find(
      (c) => c.id === 'clip-a-freeze',
    );
    expect(freeze?.kind === 'video' && freeze.playbackRate === 0).toBe(true);
    expect(inverse.type).toBe('timeline.restoreTrackClips');
    expect(applyCommand(next, inverse).project).toEqual(project);
  });

  it('reverses a video clip with its source window intact and toggles back exactly', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US, { sourceInUs: 5 * SECOND_US }),
    ]);
    const command: SpikeCommand = {
      type: 'timeline.toggleClipReverse',
      payload: { ...TARGET, clipId: 'clip-a' },
    };
    const { project: reversed, inverse } = applyCommand(project, command);
    const clip = reversed.compositions.root!.tracks[0]!.clips[0]!;
    expect(clip).toMatchObject({ kind: 'video', reversed: true, sourceInUs: 7 * SECOND_US - 1 });
    expect(applyCommand(reversed, inverse).project).toEqual(project);
  });

  it('rejects reverse on a frozen clip because a locked frame has no direction', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, SECOND_US, { playbackRate: 0 }),
    ]);
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.toggleClipReverse',
          payload: { ...TARGET, clipId: 'clip-a' },
        }),
      'COMMAND_VALIDATION_UNSUPPORTED',
    );
  });

  it('keeps fractional-rate reverse endpoints on the canonical last source frame', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, 3, { sourceInUs: 100, playbackRate: 0.5 }),
    ]);
    const { project: reversed } = applyCommand(project, {
      type: 'timeline.toggleClipReverse',
      payload: { ...TARGET, clipId: 'clip-a' },
    });
    const clip = reversed.compositions.root!.tracks[0]!.clips[0]!;
    expect(clip.kind === 'video' && clip.sourceInUs).toBe(101);
  });

  it('merges contiguous clips into an editable child composition and undo restores every byte', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, SECOND_US),
      makeVideoClip('clip-b', SECOND_US, SECOND_US),
      makeVideoClip('clip-c', 3 * SECOND_US, SECOND_US),
    ]);
    const command: SpikeCommand = {
      type: 'timeline.createCompound',
      payload: {
        ...TARGET,
        clipIds: ['clip-a', 'clip-b'],
        compoundCompositionId: 'compound-1',
        compoundClipId: 'compound-clip-1',
        name: 'Opening montage',
      },
    };
    const { project: merged, inverse } = applyCommand(project, command);
    const parentClips = merged.compositions.root!.tracks[0]!.clips;
    expect(parentClips).toMatchObject([
      {
        id: 'compound-clip-1',
        kind: 'composition',
        startUs: 0,
        durationUs: 2 * SECOND_US,
        compositionId: 'compound-1',
      },
      { id: 'clip-c' },
    ]);
    expect(merged.compositions['compound-1']).toMatchObject({
      name: 'Opening montage',
      durationUs: 2 * SECOND_US,
      tracks: [
        {
          clips: [
            { id: 'clip-a', startUs: 0 },
            { id: 'clip-b', startUs: SECOND_US },
          ],
        },
      ],
    });
    expect(inverse.type).toBe('timeline.restoreCompound');
    expect(applyCommand(merged, inverse).project).toEqual(project);
  });

  it('refuses to merge a non-contiguous selection instead of overlapping an intervening clip', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 0, SECOND_US),
      makeVideoClip('clip-b', SECOND_US, SECOND_US),
      makeVideoClip('clip-c', 2 * SECOND_US, SECOND_US),
    ]);
    expectCode(
      () =>
        applyCommand(project, {
          type: 'timeline.createCompound',
          payload: {
            ...TARGET,
            clipIds: ['clip-a', 'clip-c'],
            compoundCompositionId: 'compound-1',
            compoundClipId: 'compound-clip-1',
          },
        }),
      'COMMAND_VALIDATION_COMPOUND_NON_CONTIGUOUS',
    );
  });

  it('changes composition dimensions as one reversible command without changing clips', () => {
    const project = baseProject();
    const { project: next, inverse } = applyCommand(project, {
      type: 'timeline.setCompositionDimensions',
      payload: { compositionId: 'root', width: 1080, height: 1080 },
    });
    expect(next.compositions.root).toMatchObject({ width: 1080, height: 1080 });
    expect(next.compositions.root!.tracks).toEqual(project.compositions.root!.tracks);
    expect(applyCommand(next, inverse).project).toEqual(project);
  });
});
