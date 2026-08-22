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
  it('recovers the same durable project revision and advances it for either document slice', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const initialRevision = session.projectRevisionId;

    session.dispatchTimeline({
      label: 'Trim intro',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            newEndUs: 9_000_000,
          },
        },
      ],
    });
    const timelineRevision = session.projectRevisionId;
    expect(timelineRevision).not.toBe(initialRevision);

    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 40 },
        },
      ],
    });
    const completeDocumentRevision = session.projectRevisionId;
    expect(completeDocumentRevision).not.toBe(timelineRevision);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.projectRevisionId).toBe(completeDocumentRevision);
  });

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

  it('records a compound template apply as one undo step and restores both buses', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeEntries = session.historyEntries.length;
    const nextDocument = {
      ...session.visualProject,
      visualObjects: {
        ...session.visualProject.visualObjects,
        'intro-title': {
          ...session.visualProject.visualObjects['intro-title']!,
          transform: {
            ...session.visualProject.visualObjects['intro-title']!.transform,
            x: 321,
          },
        },
      },
    };

    session.dispatchCompound('Apply saved title', {
      document: nextDocument,
      timeline: {
        label: 'Apply saved title',
        commands: [
          {
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              newEndUs: 9_000_000,
            },
          },
        ],
      },
    });

    expect(session.historyEntries).toHaveLength(beforeEntries + 1);
    expect(session.historyEntries.at(-1)?.source).toBe('compound');
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      9_000_000,
    );

    session.undo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      10_000_000,
    );

    session.redo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      9_000_000,
    );
  });

  it('validates every part before writing a compound transaction', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeDocument = session.visualProject;
    const beforeEntries = session.historyEntries.length;
    const nextDocument = {
      ...beforeDocument,
      title: 'must not commit',
    };

    expect(() =>
      session.dispatchCompound('Invalid template apply', {
        document: nextDocument,
        timeline: {
          label: 'Invalid template apply',
          commands: [
            {
              type: 'timeline.trimClipEnd',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'missing-clip',
                newEndUs: 1,
              },
            },
          ],
        },
      }),
    ).toThrow();
    expect(session.visualProject).toBe(beforeDocument);
    expect(session.historyEntries).toHaveLength(beforeEntries);
  });
});
