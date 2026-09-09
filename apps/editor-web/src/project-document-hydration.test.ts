import { describe, expect, it, vi } from 'vitest';
import type { LookInstancesDocument, ProjectRevisionId } from '@joy-media/project-schema';
import { emptyLookInstancesDocument } from '@joy-media/project-schema';
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

function looks(instanceIds: readonly string[] = []): LookInstancesDocument {
  return {
    ...emptyLookInstancesDocument(binding.editorProjectId),
    instances: Object.fromEntries(
      instanceIds.map((id) => [
        id,
        {
          id,
          definitionId: 'editorial-clean',
          definitionVersion: 1,
          compositionId: 'root',
          entityBindings: {},
          controlValues: {},
          overriddenBindingIds: [],
          createdEntityIds: [],
        },
      ]),
    ),
  };
}

function sessionFor(
  project = document(),
  lookInstances: LookInstancesDocument = emptyLookInstancesDocument(binding.editorProjectId),
): ProjectHydrationSession & { revision: string } {
  const result = {
    visualProject: project,
    lookInstances,
    revision: 'local-1',
    synchronizeVisualProject: vi.fn((next) => next),
    synchronizeLookInstances: vi.fn(),
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

  // R2 / GAP 1a
  it('applies a remote Look Instances document on hydrate (R4)', async () => {
    const session = sessionFor();
    const remoteLooks = looks(['look-1']);
    const result = await hydrateProjectDocument(session, binding, async () => ({
      projectId: binding.controlPlaneProjectId,
      revisionId: 'server-2',
      document: document('From another device'),
      lookInstances: remoteLooks,
    }));
    expect(result).toEqual({ kind: 'hydrated', revisionId: 'server-2' });
    expect(session.synchronizeLookInstances).toHaveBeenCalledWith(remoteLooks);
  });

  it('does not apply a remote Look document when a local edit landed during the read (R4)', async () => {
    const session = sessionFor();
    const result = await hydrateProjectDocument(session, binding, async () => {
      session.revision = 'local-2';
      return {
        projectId: binding.controlPlaneProjectId,
        revisionId: 'server-2',
        document: document(),
        lookInstances: looks(['look-1']),
      };
    });
    expect(result).toEqual({ kind: 'local-changed', revisionId: 'server-2' });
    expect(session.synchronizeLookInstances).not.toHaveBeenCalled();
  });

  it('keeps the local Look document when the server row carries none (R4)', async () => {
    const session = sessionFor(document(), looks(['look-local']));
    const result = await hydrateProjectDocument(session, binding, async () => ({
      projectId: binding.controlPlaneProjectId,
      revisionId: 'server-2',
      document: document('Visual only from another device'),
      // No lookInstances key — an older server row.
    }));
    expect(result).toEqual({ kind: 'hydrated', revisionId: 'server-2' });
    expect(session.synchronizeVisualProject).toHaveBeenCalled();
    expect(session.synchronizeLookInstances).not.toHaveBeenCalled();
  });

  it('syncs a changed remote Look document even when the visual doc is identical', async () => {
    const session = sessionFor();
    const result = await hydrateProjectDocument(session, binding, async () => ({
      projectId: binding.controlPlaneProjectId,
      revisionId: 'server-2',
      document: document(),
      lookInstances: looks(['look-remote']),
    }));
    expect(result).toEqual({ kind: 'hydrated', revisionId: 'server-2' });
    expect(session.synchronizeVisualProject).not.toHaveBeenCalled();
    expect(session.synchronizeLookInstances).toHaveBeenCalledWith(looks(['look-remote']));
  });

  it('rejects an invalid remote Look Instances document before local persistence', async () => {
    const session = sessionFor();
    await expect(
      hydrateProjectDocument(session, binding, async () => ({
        projectId: binding.controlPlaneProjectId,
        revisionId: 'server-2',
        document: document('x'),
        lookInstances: {
          id: 'x',
          schemaVersion: 7,
          instances: {},
        } as unknown as LookInstancesDocument,
      })),
    ).rejects.toThrow(/Look Instances/);
    expect(session.synchronizeLookInstances).not.toHaveBeenCalled();
  });
});
