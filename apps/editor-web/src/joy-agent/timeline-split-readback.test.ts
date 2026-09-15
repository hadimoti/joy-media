import { applyTransaction, type SpikeCommand } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { assertTimelineSplitProjectReadback } from './timeline-split-readback.js';

function splitCommand(newClipId = 'product-split'): SpikeCommand {
  return {
    type: 'timeline.splitClip',
    payload: {
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'product',
      atUs: 15_000_000,
      newClipId,
    },
  };
}

function splitProject(before: SpikeProject, command = splitCommand()): SpikeProject {
  return applyTransaction(before, { label: 'Split product', commands: [command] }).project;
}

describe('timeline split project-state readback', () => {
  it('verifies both durable source-continuous halves of the exact approved split', () => {
    const before = buildReferenceSpikeProject();
    const after = splitProject(before);

    expect(() => assertTimelineSplitProjectReadback(before, after, splitCommand())).not.toThrow();
    expect(after.compositions.root?.tracks[0]?.clips).toMatchObject([
      { id: 'intro', startUs: 0, durationUs: 10_000_000 },
      { id: 'product', startUs: 10_000_000, durationUs: 5_000_000, sourceInUs: 5_000_000 },
      {
        id: 'product-split',
        startUs: 15_000_000,
        durationUs: 5_000_000,
        sourceInUs: 10_000_000,
      },
      { id: 'outro', startUs: 20_000_000, durationUs: 10_000_000 },
    ]);
  });

  it('rejects malformed split payloads before treating any project state as verified', () => {
    const before = buildReferenceSpikeProject();
    const malformed = {
      type: 'timeline.splitClip',
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'product',
        atUs: 15_000_000,
        newClipId: '',
      },
    } as unknown as SpikeCommand;

    expect(() => assertTimelineSplitProjectReadback(before, before, malformed)).toThrow(
      'JOY_CODE_TIMELINE_SPLIT_READBACK_INVALID',
    );
  });

  it('rejects stale or mismatched project state instead of reporting a split that did not land', () => {
    const before = buildReferenceSpikeProject();
    const command = splitCommand();
    expect(() => assertTimelineSplitProjectReadback(before, before, command)).toThrow(
      'JOY_CODE_TIMELINE_SPLIT_READBACK_STALE',
    );

    const mismatchedCommand = {
      type: 'timeline.splitClip' as const,
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'product',
        atUs: 14_000_000,
        newClipId: 'product-split',
      },
    } satisfies SpikeCommand;
    expect(() =>
      assertTimelineSplitProjectReadback(before, splitProject(before), mismatchedCommand),
    ).toThrow('JOY_CODE_TIMELINE_SPLIT_READBACK_MISMATCH');
  });

  it('rejects a different command kind rather than relabeling it as split coverage', () => {
    const before = buildReferenceSpikeProject();
    const unsupported = {
      type: 'timeline.moveClip',
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'product',
        newStartUs: 10_000_000,
      },
    } as SpikeCommand;

    expect(() => assertTimelineSplitProjectReadback(before, before, unsupported)).toThrow(
      'JOY_CODE_TIMELINE_SPLIT_READBACK_UNSUPPORTED_COMMAND',
    );
  });
});
