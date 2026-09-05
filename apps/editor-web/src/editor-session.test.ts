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

  it('preserves an intentional 16:9 canvas across a fresh session', () => {
    const storage = memoryStorage();
    const initialTimeline = buildReferenceSpikeProject();
    const initialVisual = {
      ...INITIAL_EDITOR_PROJECT,
      compositions: {
        ...INITIAL_EDITOR_PROJECT.compositions,
        root: {
          ...INITIAL_EDITOR_PROJECT.compositions.root!,
          width: 1920,
          height: 1080,
        },
      },
    };
    const session = new EditorSession(storage, initialTimeline, initialVisual);
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1920, height: 1080 });

    const reopened = new EditorSession(storage, initialTimeline, initialVisual);
    expect(reopened.visualProject.compositions.root).toMatchObject({
      width: 1920,
      height: 1080,
    });
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

  it('restores whole-project replacements without asking command history to undo them', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.replaceVisualProject({
      ...session.visualProject,
      title: 'Temporary replacement',
    });

    expect(session.visualProject.title).toBe('Temporary replacement');
    expect(() => session.jumpToHistory(0)).not.toThrow();
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
  });

  it('does not let derived metadata consume the undo entry for a timeline edit', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const initialCount =
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips.length;
    session.dispatchTimeline({
      label: 'Split product',
      commands: [
        {
          type: 'timeline.splitClip',
          payload: {
            compositionId: session.timelineProject.rootCompositionId,
            trackId: 'track-0',
            clipId: 'product',
            atUs: 15_000_000,
            newClipId: 'product-b',
          },
        },
      ],
    });
    session.synchronizeVisualProject({
      ...session.visualProject,
      exportPreset: 'youtube-1080',
    });

    expect(session.historyEntries.at(-1)?.label).toBe('Split product');
    session.undo();
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialCount);
    session.redo();
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialCount + 1);
  });

  it('keeps the live document and revision unchanged when metadata persistence fails', () => {
    const values = new Map<string, string>();
    let rejectWrites = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectWrites) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        values.set(key, value);
      },
    };
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const before = session.visualProject;
    const revision = session.projectRevisionId;
    rejectWrites = true;

    expect(() =>
      session.synchronizeVisualProject({
        ...before,
        exportPreset: 'youtube-1080',
      }),
    ).toThrow('Storage quota exceeded');
    expect(session.visualProject).toBe(before);
    expect(session.projectRevisionId).toBe(revision);
  });

  it('does not advance replacement, Undo, or Redo state when snapshot persistence fails', () => {
    const values = new Map<string, string>();
    let rejectWrites = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectWrites) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        values.set(key, value);
      },
    };
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const original = session.visualProject;
    const originalRevision = session.projectRevisionId;
    rejectWrites = true;
    expect(() => session.replaceVisualProject({ ...original, title: 'Must not appear' })).toThrow(
      'Storage quota exceeded',
    );
    expect(session.visualProject).toBe(original);
    expect(session.projectRevisionId).toBe(originalRevision);
    expect(session.canUndo).toBe(false);

    rejectWrites = false;
    session.replaceVisualProject({ ...original, title: 'Durable replacement' });
    const replacementRevision = session.projectRevisionId;
    const replacementCursor = session.historyCursorSequence;
    rejectWrites = true;
    expect(() => session.undo()).toThrow('Storage quota exceeded');
    expect(session.visualProject.title).toBe('Durable replacement');
    expect(session.projectRevisionId).toBe(replacementRevision);
    expect(session.historyCursorSequence).toBe(replacementCursor);

    rejectWrites = false;
    session.undo();
    expect(session.visualProject.title).toBe(original.title);
    rejectWrites = true;
    expect(() => session.redo()).toThrow('Storage quota exceeded');
    expect(session.visualProject.title).toBe(original.title);
    expect(session.historyCursorSequence).toBe(0);

    rejectWrites = false;
    session.redo();
    expect(session.visualProject.title).toBe('Durable replacement');
  });

  it('rolls back every compound log and live history when apply, Undo, or Redo persistence fails', () => {
    const values = new Map<string, string>();
    let writes = 0;
    let rejectWrite = Number.POSITIVE_INFINITY;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === rejectWrite)
          throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const initialTimeline = buildReferenceSpikeProject();
    const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    const initialRevision = session.projectRevisionId;
    const initialClipCount =
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips.length;
    const compound = () =>
      session.dispatchCompound('Split and rename', {
        timeline: {
          label: 'Split product',
          commands: [
            {
              type: 'timeline.splitClip',
              payload: {
                compositionId: session.timelineProject.rootCompositionId,
                trackId: 'track-0',
                clipId: 'product',
                atUs: 15_000_000,
                newClipId: 'product-compound-b',
              },
            },
          ],
        },
        document: { ...session.visualProject, title: 'Compound title' },
      });

    // Journal, first domain append, then reject the second domain append.
    rejectWrite = writes + 3;
    expect(compound).toThrow('Storage quota exceeded');
    expect(session.projectRevisionId).toBe(initialRevision);
    expect(session.historyCursorSequence).toBe(0);
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount);
    const reopenedAfterApplyFailure = new EditorSession(
      storage,
      initialTimeline,
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopenedAfterApplyFailure.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(
      reopenedAfterApplyFailure.timelineProject.compositions[
        reopenedAfterApplyFailure.timelineProject.rootCompositionId
      ]!.tracks[0]!.clips,
    ).toHaveLength(initialClipCount);

    rejectWrite = Number.POSITIVE_INFINITY;
    compound();
    const appliedRevision = session.projectRevisionId;
    const appliedCursor = session.historyCursorSequence;
    expect(session.visualProject.title).toBe('Compound title');
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount + 1);

    // Undo persists document then timeline. Reject timeline and prove neither
    // the live session nor a newly recovered session observes a half-undo.
    rejectWrite = writes + 3;
    expect(() => session.undo()).toThrow('Storage quota exceeded');
    expect(session.projectRevisionId).toBe(appliedRevision);
    expect(session.historyCursorSequence).toBe(appliedCursor);
    expect(session.visualProject.title).toBe('Compound title');
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount + 1);
    const reopenedAfterUndoFailure = new EditorSession(
      storage,
      initialTimeline,
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopenedAfterUndoFailure.visualProject.title).toBe('Compound title');
    expect(
      reopenedAfterUndoFailure.timelineProject.compositions[
        reopenedAfterUndoFailure.timelineProject.rootCompositionId
      ]!.tracks[0]!.clips,
    ).toHaveLength(initialClipCount + 1);

    rejectWrite = Number.POSITIVE_INFINITY;
    session.undo();
    expect(session.historyCursorSequence).toBe(0);
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);

    // Redo persists timeline then document. Reject document and preserve the
    // fully-undone state in memory and on reopen.
    rejectWrite = writes + 3;
    expect(() => session.redo()).toThrow('Storage quota exceeded');
    expect(session.historyCursorSequence).toBe(0);
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount);
    const reopenedAfterRedoFailure = new EditorSession(
      storage,
      initialTimeline,
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopenedAfterRedoFailure.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(
      reopenedAfterRedoFailure.timelineProject.compositions[
        reopenedAfterRedoFailure.timelineProject.rootCompositionId
      ]!.tracks[0]!.clips,
    ).toHaveLength(initialClipCount);

    rejectWrite = Number.POSITIVE_INFINITY;
    session.redo();
    expect(session.visualProject.title).toBe('Compound title');
    expect(session.historyCursorSequence).toBe(appliedCursor);
  });

  it('repairs a prepared compound journal on reopen when immediate rollback storage is unavailable', () => {
    const values = new Map<string, string>();
    let writes = 0;
    let rejectFromWrite = Number.POSITIVE_INFINITY;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes >= rejectFromWrite)
          throw new DOMException('Storage unavailable', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const initialTimeline = buildReferenceSpikeProject();
    const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    const initialClipCount =
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips.length;

    // Prepared journal and timeline append succeed; the document append and
    // every immediate rollback write fail, leaving recovery for the next open.
    rejectFromWrite = writes + 3;
    expect(() =>
      session.dispatchCompound('Interrupted compound', {
        timeline: {
          label: 'Split product',
          commands: [
            {
              type: 'timeline.splitClip',
              payload: {
                compositionId: session.timelineProject.rootCompositionId,
                trackId: 'track-0',
                clipId: 'product',
                atUs: 15_000_000,
                newClipId: 'product-interrupted-b',
              },
            },
          ],
        },
        document: { ...session.visualProject, title: 'Must roll back on reopen' },
      }),
    ).toThrow('requires reload recovery');
    expect(session.historyCursorSequence).toBe(0);
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);

    rejectFromWrite = Number.POSITIVE_INFINITY;
    const reopened = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    expect(reopened.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(
      reopened.timelineProject.compositions[reopened.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount);
    expect(
      [...values.keys()].some((key) => key.startsWith('joy-media.editor-compound-write.v1:')),
    ).toBe(false);
  });

  it('recovers a raw agent receipt written before a failed compound commit marker', () => {
    const values = new Map<string, string>();
    let writes = 0;
    let rejectFromWrite = Number.POSITIVE_INFINITY;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes >= rejectFromWrite)
          throw new DOMException('Storage unavailable', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const initialTimeline = buildReferenceSpikeProject();
    const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    const initialRevision = session.projectRevisionId;

    // The journal, document snapshot, and raw receipt write all succeed. The
    // durable commit marker then fails along with immediate rollback, so only
    // reopening may decide whether the pair survives.
    rejectFromWrite = writes + 4;
    expect(() =>
      session.commitAgentCompound(
        'Receipt must recover with document',
        { document: { ...session.visualProject, title: 'Must not survive' } },
        {
          executionId: 'journal-raw-receipt',
          operationDigest: 'a'.repeat(64),
          baseRevision: initialRevision,
          changedEntityIds: ['root'],
        },
      ),
    ).toThrow('requires reload recovery');
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(session.agentIdempotency.getExecutionReceipt('journal-raw-receipt')).toBeUndefined();

    rejectFromWrite = Number.POSITIVE_INFINITY;
    // The same live session must not overwrite the prepared journal after its
    // rollback failed. Recovery/reopen owns the only valid next transition.
    expect(() =>
      session.commitAgentCompound(
        'Must wait for recovery',
        { document: { ...session.visualProject, title: 'Second write' } },
        {
          executionId: 'journal-raw-receipt-second',
          operationDigest: 'b'.repeat(64),
          baseRevision: initialRevision,
          changedEntityIds: ['root'],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'PERSISTENCE_RECOVERY_REQUIRED' }));
    expect(
      session.agentIdempotency.getExecutionReceipt('journal-raw-receipt-second'),
    ).toBeUndefined();

    const reopened = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    expect(reopened.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(reopened.projectRevisionId).toBe(initialRevision);
    expect(reopened.agentIdempotency.getExecutionReceipt('journal-raw-receipt')).toBeUndefined();
    expect(
      [...values.keys()].some((key) => key.startsWith('joy-media.editor-compound-write.v1:')),
    ).toBe(false);
  });
});
