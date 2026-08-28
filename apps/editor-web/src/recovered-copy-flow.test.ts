import { describe, expect, it } from 'vitest';
import { getCatalogProject, loadActiveProjectId } from './project-catalog.js';
import { getOrCreateControlPlaneProjectBinding } from './project-control-plane.js';
import { createBlankProjectDocuments } from './project-factory.js';
import { createAndActivateRecoveredCopyProject } from './recovered-copy-flow.js';
import { EditorSession } from './editor-session.js';
import { ProjectDocumentBrowserJournal } from './project-document-browser-journal.js';
import { createProjectDocumentSpine } from './project-document-spine.js';
import type { JsonValue } from '@joy-media/project-schema';
import { bootstrapProjectDocument } from './project-document-bootstrap.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function asyncMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('recovered-copy flow', () => {
  it('creates and activates a new local project while retaining the server binding', async () => {
    const storage = memoryStorage();
    const originalBinding = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'source-local', title: 'Campaign' },
      { ownerKey: 'owner-1', createId: () => 'source-server' },
    );
    const recoveredSeeds = createBlankProjectDocuments(
      'server-recovered-1',
      'Campaign (Recovered copy)',
      '2026-08-26T00:00:00.000Z',
    );
    const result = createAndActivateRecoveredCopyProject(
      storage,
      {
        name: 'Campaign (Recovered copy)',
        projectId: 'server-recovered-1',
        document: {
          schemaVersion: 2,
          projectId: 'server-recovered-1',
          title: 'Campaign (Recovered copy)',
          project: recoveredSeeds.visual as unknown as JsonValue,
          timeline: recoveredSeeds.timeline as unknown as JsonValue,
        },
      },
      'owner-1',
      { createEditorProjectId: () => 'local-recovered-1', now: () => '2026-08-26T00:00:00.000Z' },
    );

    expect(result.entry).toMatchObject({
      id: 'local-recovered-1',
      title: 'Campaign (Recovered copy)',
    });
    expect(result.binding).toEqual({
      editorProjectId: 'local-recovered-1',
      controlPlaneProjectId: 'server-recovered-1',
      title: 'Campaign (Recovered copy)',
    });
    expect(getCatalogProject(storage, 'local-recovered-1')).toEqual(result.entry);
    expect(loadActiveProjectId(storage)).toBe('local-recovered-1');
    expect(
      getOrCreateControlPlaneProjectBinding(
        storage,
        { id: 'source-local', title: 'Campaign' },
        { ownerKey: 'owner-1', createId: () => 'must-not-be-used' },
      ),
    ).toEqual(originalBinding);

    // Simulate remote bootstrap failing after activation. Reopening the
    // local shell still sees the returned copy, so the first V2 journal write
    // cannot overwrite it with the blank seed.
    await expect(
      bootstrapProjectDocument({
        projectId: result.binding.controlPlaneProjectId,
        title: result.entry.title,
        remote: {
          ensureProject: async () => {
            throw new Error('remote bootstrap unavailable');
          },
          projectDocument: async () => {
            throw new Error('should not be called');
          },
          appendProjectRevision: async () => {
            throw new Error('should not be called');
          },
        },
        projectDocument: () => ({
          schemaVersion: 2,
          projectId: result.binding.controlPlaneProjectId,
        }),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    const localSeeds = createBlankProjectDocuments(
      'local-recovered-1',
      'Campaign (Recovered copy)',
      '2026-08-26T00:00:00.000Z',
    );
    const reopened = new EditorSession(storage, localSeeds.timeline, localSeeds.visual);
    expect(reopened.visualProject.title).toBe('Campaign (Recovered copy)');
    const journal = new ProjectDocumentBrowserJournal(asyncMemoryStorage(), 'local-recovered-1');
    const spine = createProjectDocumentSpine({
      session: reopened,
      journal,
      coordinator: { queueLocalDocument: () => undefined },
    });
    await spine.saveCurrent();
    await expect(journal.recover()).resolves.toMatchObject({
      document: { title: 'Campaign (Recovered copy)' },
    });
  });
});
