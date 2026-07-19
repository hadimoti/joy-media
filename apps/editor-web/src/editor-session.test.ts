import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('EditorSession', () => {
  it('persists timeline and inspector commands, including undo and redo', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.dispatchTimeline({
      label: 'Split product',
      commands: [
        {
          type: 'timeline.splitClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'product',
            atUs: 15_000_000,
            newClipId: 'product-b',
          },
        },
      ],
    });
    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 120 },
        },
      ],
    });
    session.undo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
    session.redo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(120);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.timelineProject.compositions.root?.tracks[0]?.clips).toHaveLength(4);
    expect(reopened.visualProject.visualObjects['intro-title']?.transform.x).toBe(120);
  });
});
