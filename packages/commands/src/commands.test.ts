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
      'timeline.insertClip',
      'timeline.joinClips',
      'timeline.moveClip',
      'timeline.removeClip',
      'timeline.splitClip',
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
});
