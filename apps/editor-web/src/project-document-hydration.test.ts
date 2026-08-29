import { describe, expect, it, vi } from 'vitest';
import type { ProjectRevisionId } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  hydrateProjectDocument,
  type ProjectHydrationSession,
} from './project-document-hydration.js';

const binding = {
  editorProjectId: 'editor-doc-1',
  controlPlaneProjectId: 'project-server-1',
} as const;

function document(title = 'Recovered document') {
  return { ...INITIAL_EDITOR_PROJECT, id: binding.editorProjectId, title };
}

function sessionFor(project = document()): ProjectHydrationSession & { revision: string } {
  const result = {
    visualProject: project,
    revision: 'local-1',
    synchronizeVisualProject: vi.fn((next) => next),
  } as unknown as ProjectHydrationSession & { revision: string };
  Object.defineProperty(result, 'projectRevisionId', {
    get: () => result.revision as ProjectRevisionId,
  });
  return result;
}

describe('project document hydration', () => {
  it('hydrates a valid server document without adding an Undo operation', async () => {
    const session = sessionFor();
    const result = await hydrateProjectDocument(session, binding, async () => ({
      projectId: binding.controlPlaneProjectId,
      revisionId: 'server-2',
      document: document('From another device'),
    }));

    expect(result).toEqual({ kind: 'hydrated', revisionId: 'server-2' });
    expect(session.synchronizeVisualProject).toHaveBeenCalledWith(document('From another device'));
  });

  it('does not rewrite the local project when it changes during a slow read', async () => {
    const session = sessionFor();
    const result = await hydrateProjectDocument(session, binding, async () => {
      session.revision = 'local-2';
      return {
        projectId: binding.controlPlaneProjectId,
        revisionId: 'server-2',
        document: document('Do not erase local edit'),
      };
    });

    expect(result).toEqual({ kind: 'local-changed', revisionId: 'server-2' });
    expect(session.synchronizeVisualProject).not.toHaveBeenCalled();
  });

  it('does not write an identical document', async () => {
    const session = sessionFor();
    const result = await hydrateProjectDocument(session, binding, async () => ({
      projectId: binding.controlPlaneProjectId,
      revisionId: 'server-1',
      document: document(),
    }));

    expect(result).toEqual({ kind: 'unchanged', revisionId: 'server-1' });
    expect(session.synchronizeVisualProject).not.toHaveBeenCalled();
  });

  it('rejects mismatched or invalid remote documents before local persistence', async () => {
    const session = sessionFor();
    await expect(
      hydrateProjectDocument(session, binding, async () => ({
        projectId: 'wrong-project',
        revisionId: 'server-1',
        document: document(),
      })),
    ).rejects.toThrow('expected projectId=project-server-1');
    await expect(
      hydrateProjectDocument(session, binding, async () => ({
        projectId: binding.controlPlaneProjectId,
        revisionId: 'server-1',
        document: { ...document(), id: 'wrong-editor-id' },
      })),
    ).rejects.toThrow('expected editorProjectId=editor-doc-1');
    expect(session.synchronizeVisualProject).not.toHaveBeenCalled();
  });
});
