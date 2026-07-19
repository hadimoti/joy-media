import { describe, expect, it } from 'vitest';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import { EditorCommandController } from './command-controller.js';
describe('EditorCommandController', () => {
  it('routes durable edits through command history', () => {
    const controller = new EditorCommandController(emptySpikeProject());
    controller.dispatch({
      label: 'Insert intro',
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clip: makeVideoClip('intro', 0, 1_000_000),
          },
        },
      ],
    });
    expect(controller.undoLabel).toBe('Insert intro');
    expect(controller.undo().compositions.root?.tracks[0]?.clips).toHaveLength(0);
  });
});
