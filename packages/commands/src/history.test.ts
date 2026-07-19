import { describe, expect, it } from 'vitest';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import type { SpikeCommand } from './commands.js';
import { applyCommand, CommandError } from './commands.js';
import { applyTransaction, ProjectHistory } from './history.js';

const TARGET = { compositionId: 'root', trackId: 'track-0' } as const;

const insert = (id: string, startUs: number, durationUs: number): SpikeCommand => ({
  type: 'timeline.insertClip',
  payload: { ...TARGET, clip: makeVideoClip(id, startUs, durationUs) },
});

describe('applyTransaction', () => {
  it('applies commands atomically as one unit', () => {
    const project = emptySpikeProject();
    const { project: next, record } = applyTransaction(project, {
      label: 'Insert two clips',
      commands: [insert('a', 0, SECOND_US), insert('b', SECOND_US, SECOND_US)],
    });
    expect(next.compositions['root']!.tracks[0]!.clips).toHaveLength(2);
    expect(record.inverses).toHaveLength(2);
    // undoing via the recorded inverses restores the original
    let undone = next;
    for (const inverseCommand of record.inverses) {
      undone = applyCommand(undone, inverseCommand).project;
    }
    expect(undone).toEqual(project);
  });

  it('a failing command aborts the whole transaction and leaves state untouched', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('existing', 2 * SECOND_US, SECOND_US),
    ]);
    const snapshot = JSON.parse(JSON.stringify(project));
    expect(() =>
      applyTransaction(project, {
        label: 'Partially invalid',
        commands: [
          insert('ok', 0, SECOND_US),
          insert('overlaps', 2 * SECOND_US, SECOND_US), // collides with "existing"
        ],
      }),
    ).toThrow(CommandError);
    expect(project).toEqual(snapshot);
  });

  it('rejects empty transactions', () => {
    expect(() => applyTransaction(emptySpikeProject(), { label: 'Empty', commands: [] })).toThrow(
      CommandError,
    );
  });
});

describe('ProjectHistory', () => {
  it('undo/redo walk the transaction stack; labels explain what will be undone', () => {
    const history = new ProjectHistory(emptySpikeProject());
    const initial = history.present;

    history.apply({ label: 'Insert a', commands: [insert('a', 0, SECOND_US)] });
    const afterA = history.present;
    history.apply({
      label: 'Trim a',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: { ...TARGET, clipId: 'a', newEndUs: SECOND_US / 2 },
        },
      ],
    });
    const afterTrim = history.present;

    expect(history.undoLabel).toBe('Trim a');
    expect(history.undo()).toEqual(afterA);
    expect(history.undo()).toEqual(initial);
    expect(history.canUndo).toBe(false);

    expect(history.redo()).toEqual(afterA);
    expect(history.redo()).toEqual(afterTrim);
    expect(history.canRedo).toBe(false);
  });

  it('a new transaction clears the redo stack', () => {
    const history = new ProjectHistory(emptySpikeProject());
    history.apply({ label: 'Insert a', commands: [insert('a', 0, SECOND_US)] });
    history.undo();
    expect(history.canRedo).toBe(true);
    history.apply({ label: 'Insert b', commands: [insert('b', 0, SECOND_US)] });
    expect(history.canRedo).toBe(false);
  });

  it('coalesces matching continuous interactions into one semantic undo step', () => {
    const history = new ProjectHistory(emptySpikeProject());
    history.apply({
      label: 'Disable track',
      coalesceKey: 'track-0-enabled',
      commands: [{ type: 'property.setTrackEnabled', payload: { ...TARGET, enabled: false } }],
    });
    history.apply({
      label: 'Enable track',
      coalesceKey: 'track-0-enabled',
      commands: [{ type: 'property.setTrackEnabled', payload: { ...TARGET, enabled: true } }],
    });
    expect(history.undoLabel).toBe('Enable track');
    expect(history.undo()).toEqual(emptySpikeProject());
    expect(history.canUndo).toBe(false);
  });

  it('throws coded errors when stacks are empty', () => {
    const history = new ProjectHistory(emptySpikeProject());
    expect(() => history.undo()).toThrow(CommandError);
    expect(() => history.redo()).toThrow(CommandError);
  });

  it('replaying the serialized command log reproduces the final state', () => {
    const history = new ProjectHistory(emptySpikeProject());
    const log: SpikeCommand[] = [];
    const transactions = [
      { label: 't1', commands: [insert('a', 0, SECOND_US), insert('b', 2 * SECOND_US, SECOND_US)] },
      {
        label: 't2',
        commands: [
          {
            type: 'timeline.splitClip',
            payload: { ...TARGET, clipId: 'a', atUs: SECOND_US / 2, newClipId: 'a2' },
          } satisfies SpikeCommand,
        ],
      },
      {
        label: 't3',
        commands: [
          {
            type: 'timeline.moveClip',
            payload: { ...TARGET, clipId: 'b', newStartUs: 5 * SECOND_US },
          } satisfies SpikeCommand,
        ],
      },
    ];
    for (const tx of transactions) {
      history.apply(tx);
      log.push(...tx.commands);
    }
    // serialize -> revive -> replay against the same initial project
    const revived = JSON.parse(JSON.stringify(log)) as SpikeCommand[];
    let replayed = emptySpikeProject();
    for (const command of revived) {
      replayed = applyCommand(replayed, command).project;
    }
    expect(replayed).toEqual(history.present);
  });
});
