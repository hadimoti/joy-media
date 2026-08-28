import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { validateProjectDocumentV2 } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import {
  projectDocumentFromSession,
  ProjectDocumentSpine,
  type ProjectDocumentSpineJournal,
} from './project-document-spine.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function session(): EditorSession {
  return new EditorSession(memoryStorage(), buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

describe('ProjectDocumentSpine', () => {
  it('projects the live lenses into valid bounded V2 without media paths or bytes', () => {
    const editor = session();
    const unsafe = {
      ...editor.visualProject,
      pluginData: {
        ...editor.visualProject.pluginData,
        imported: { sourcePath: 'C:/private/video.mp4', rawBytes: 'AAAA', keep: 'yes' },
      },
    };
    const document = projectDocumentFromSession({
      timelineProject: editor.timelineProject,
      visualProject: unsafe,
      graphEnabled: false,
      workflowGraph: editor.workflowGraph,
      artifacts: editor.artifacts,
    });

    expect(document.projectId).toBe(INITIAL_EDITOR_PROJECT.id);
    expect(document.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(validateProjectDocumentV2(document)).toEqual([]);
    expect(JSON.stringify(document)).not.toContain('C:/private/video.mp4');
    expect(JSON.stringify(document)).not.toContain('rawBytes');
    expect(
      (document.project as { pluginData: Record<string, unknown> }).pluginData.imported,
    ).toEqual({ keep: 'yes' });
  });

  it('includes an optional audio sidecar JSON value', () => {
    const editor = session();
    const document = projectDocumentFromSession(editor, {
      buses: [{ id: 'master', gain: 0.8 }],
      source: 'sidecar',
    });
    expect(document.audio).toEqual({ buses: [{ id: 'master', gain: 0.8 }], source: 'sidecar' });
  });

  it('saves locally before queueing remotely', async () => {
    const order: string[] = [];
    const journal: ProjectDocumentSpineJournal = {
      saveSnapshot: async () => {
        order.push('local-start');
        await Promise.resolve();
        order.push('local-end');
      },
    };
    const queueLocalDocument = vi.fn(() => {
      order.push('remote');
    });
    const spine = new ProjectDocumentSpine({
      session: session(),
      journal,
      coordinator: { queueLocalDocument },
    });

    const result = await spine.saveCurrent({ label: 'Move title', operationCount: 2 });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['local-start', 'local-end', 'remote']);
    expect(queueLocalDocument).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ label: 'Move title', operationCount: 2 }),
    );
  });

  it('reports a recoverable local failure and does not queue remotely', async () => {
    const failure = new Error('quota');
    const queueLocalDocument = vi.fn();
    const spine = new ProjectDocumentSpine({
      session: session(),
      journal: { saveSnapshot: vi.fn(async () => Promise.reject(failure)) },
      coordinator: { queueLocalDocument },
    });

    const result = await spine.saveCurrent();
    expect(result).toMatchObject({
      ok: false,
      failure: { stage: 'local-journal', recoverable: true },
    });
    expect(spine.lastFailure?.error).toBe(failure);
    expect(queueLocalDocument).not.toHaveBeenCalled();
  });

  it('attaches and detaches cleanly from direct session mutations', async () => {
    const editor = session();
    const saveSnapshot = vi.fn(async () => undefined);
    const queueLocalDocument = vi.fn();
    const spine = new ProjectDocumentSpine({
      session: editor,
      journal: { saveSnapshot },
      coordinator: { queueLocalDocument },
    });
    const detach = spine.attach();
    editor.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 30 },
        },
      ],
    });
    await spine.flush();
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    detach();
    expect(spine.attached).toBe(false);
    spine.attach();
    editor.dispatchVisualObjects({
      label: 'Move title again',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 40 },
        },
      ],
    });
    await spine.flush();
    expect(saveSnapshot).toHaveBeenCalledTimes(2);
    expect(queueLocalDocument).toHaveBeenCalledTimes(2);
  });
});
