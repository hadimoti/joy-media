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

  it('jumps to a history restore point like a Photoshop history panel', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 50 },
        },
      ],
    });
    session.dispatchVisualObjects({
      label: 'Move title again',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 90 },
        },
      ],
    });
    const entries = session.historyEntries;
    expect(entries.map((e) => e.label)).toEqual(['Document', 'Move title', 'Move title again']);
    expect(entries.at(-1)?.direction).toBe('current');

    session.jumpToHistory(entries[1]!.sequence);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(50);
    expect(session.historyCursorSequence).toBe(entries[1]!.sequence);
    expect(session.historyEntries.find((e) => e.direction === 'current')?.label).toBe('Move title');

    session.jumpToHistory(0);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);

    session.jumpToHistory(entries[2]!.sequence);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(90);
  });
});
