import { applyTransaction, type SpikeCommand } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { trimCommand } from '@joy-media/timeline-engine';
import { describe, expect, it } from 'vitest';
import { buildTimelineClipMoveTransaction } from '../timeline-clip-interaction.js';
import {
  assertTimelineMoveProjectReadback,
  assertTimelineTrimProjectReadback,
} from './timeline-edit-readback.js';

function trimCommands(): readonly SpikeCommand[] {
  return [
    trimCommand('root', 'track-0', 'product', 'start', 12_000_000),
    trimCommand('root', 'track-0', 'product', 'end', 18_000_000),
  ];
}

function applyCommands(before: SpikeProject, commands: readonly SpikeCommand[]): SpikeProject {
  return applyTransaction(before, { label: 'Manual timeline edit', commands }).project;
}

function moveProject(): SpikeProject {
  const before = buildReferenceSpikeProject();
  const root = before.compositions.root!;
  return {
    ...before,
    compositions: {
      ...before.compositions,
      root: {
        ...root,
        tracks: root.tracks.map((track) =>
          track.id === 'track-0'
            ? {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === 'product' ? { ...clip, durationUs: 4_000_000 } : clip,
                ),
              }
            : track,
        ),
      },
    },
  };
}

function manualMoveCommand(before: SpikeProject): SpikeCommand {
  const track = before.compositions.root!.tracks.find((candidate) => candidate.id === 'track-0')!;
  const clip = track.clips.find((candidate) => candidate.id === 'product')!;
  const manual = buildTimelineClipMoveTransaction({
    compositionId: 'root',
    sourceTrackId: track.id,
    targetTrackId: track.id,
    clip,
    targetClips: track.clips,
    newStartUs: 15_000_000,
  });
  if (manual === undefined || manual.commands.length !== 1)
    throw new Error('fixture move must use one canonical manual command');
  return manual.commands[0]!;
}

describe('timeline trim and same-track move project-state readback', () => {
  it('verifies the durable clip state from the exact paired manual trim commands', () => {
    const before = buildReferenceSpikeProject();
    const commands = trimCommands();
    const after = applyCommands(before, commands);

    expect(() => assertTimelineTrimProjectReadback(before, after, commands)).not.toThrow();
    expect(
      after.compositions.root?.tracks[0]?.clips.find((clip) => clip.id === 'product'),
    ).toMatchObject({
      id: 'product',
      startUs: 12_000_000,
      durationUs: 6_000_000,
      sourceInUs: 7_000_000,
    });
  });

  it('verifies the durable clip state from the exact same-track manual move command', () => {
    const before = moveProject();
    const command = manualMoveCommand(before);
    const after = applyCommands(before, [command]);

    expect(() => assertTimelineMoveProjectReadback(before, after, command)).not.toThrow();
    expect(
      after.compositions.root?.tracks[0]?.clips.find((clip) => clip.id === 'product'),
    ).toMatchObject({ id: 'product', startUs: 15_000_000, durationUs: 4_000_000 });
  });

  it('rejects malformed or wrong command contracts before reporting a timeline edit', () => {
    const before = buildReferenceSpikeProject();
    const malformedStart = {
      type: 'timeline.trimClipStart',
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'product',
        newStartUs: 12_000_000,
        ignored: 'hostile-extra',
      },
    } as unknown as SpikeCommand;
    expect(() =>
      assertTimelineTrimProjectReadback(before, before, [malformedStart, trimCommands()[1]!]),
    ).toThrow('JOY_CODE_TIMELINE_EDIT_READBACK_INVALID');

    expect(() => assertTimelineMoveProjectReadback(before, before, trimCommands()[0]!)).toThrow(
      'JOY_CODE_TIMELINE_EDIT_READBACK_UNSUPPORTED_COMMAND',
    );
  });

  it('rejects no-op, stale cross-project, and mismatched durable state', () => {
    const before = buildReferenceSpikeProject();
    const noOp = [
      trimCommand('root', 'track-0', 'product', 'start', 10_000_000),
      trimCommand('root', 'track-0', 'product', 'end', 20_000_000),
    ];
    expect(() => assertTimelineTrimProjectReadback(before, before, noOp)).toThrow(
      'JOY_CODE_TIMELINE_EDIT_READBACK_INVALID',
    );

    const crossProject = {
      type: 'timeline.moveClip',
      payload: {
        compositionId: 'other-project-root',
        trackId: 'track-0',
        clipId: 'product',
        newStartUs: 15_000_000,
      },
    } as SpikeCommand;
    expect(() => assertTimelineMoveProjectReadback(before, before, crossProject)).toThrow(
      'JOY_CODE_TIMELINE_EDIT_READBACK_STALE',
    );

    const commands = trimCommands();
    expect(() => assertTimelineTrimProjectReadback(before, before, commands)).toThrow(
      'JOY_CODE_TIMELINE_EDIT_READBACK_MISMATCH',
    );
  });
});
