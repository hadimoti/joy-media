import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { createAgentCommandBus } from './agent-command-bus.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function clipIdsOf(session: EditorSession, trackId: string): readonly string[] {
  return (
    session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === trackId)
      ?.clips.map((c) => c.id) ?? []
  );
}

describe('createAgentCommandBus (WP-15.1)', () => {
  it('dispatches a real transaction through the same EditorSession the human Timeline panel uses', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const bus = createAgentCommandBus(session);

    const result = bus.dispatchTimeline(
      [
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
      'Agent: split product clip',
    );

    expect(result.success).toBe(true);
    expect(clipIdsOf(session, 'track-0')).toEqual(['intro', 'product', 'product-b', 'outro']);

    // It's one ordinary entry in the real undo/redo stack, not a side channel.
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(clipIdsOf(session, 'track-0')).toEqual(['intro', 'product', 'outro']);
    session.redo();
    expect(clipIdsOf(session, 'track-0')).toEqual(['intro', 'product', 'product-b', 'outro']);
  });

  it('returns the real command error instead of throwing or silently succeeding', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const bus = createAgentCommandBus(session);

    const result = bus.dispatchTimeline(
      [
        {
          type: 'timeline.moveClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'product',
            newStartUs: 0, // overlaps 'intro'
          },
        },
      ],
      'Agent: move product clip',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('COMMAND_VALIDATION_OVERLAP');
    expect(clipIdsOf(session, 'track-0')).toEqual(['intro', 'product', 'outro']);
    expect(session.canUndo).toBe(false);
  });

  it('persists an agent transaction across a session reload, exactly like a human edit', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const bus = createAgentCommandBus(session);
    bus.dispatchTimeline(
      [
        {
          type: 'timeline.removeClip',
          payload: { compositionId: 'root', trackId: 'track-1', clipId: 'b-roll-a' },
        },
      ],
      'Agent: remove b-roll-a',
    );

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(clipIdsOf(reopened, 'track-1')).toEqual(['b-roll-b']);
  });
});
