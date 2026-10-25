import { describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  DOCUMENT_AUTOSYNC_DEBOUNCE_MS,
  DOCUMENT_AUTOSYNC_RETRY_INITIAL_MS,
  ProjectDocumentAutosync,
} from './project-document-autosync.js';
import {
  getControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
  type ControlPlaneProjectBinding,
} from './project-control-plane.js';
import type { SyncProjectDocument } from './project-document-sync.js';
import type { ProjectHydrationSession } from './project-document-hydration.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const binding: ControlPlaneProjectBinding = {
  editorProjectId: 'editor-doc-1',
  controlPlaneProjectId: 'project-server-1',
  title: 'Campaign cut',
};

function document(title = 'Campaign cut'): JoyProjectV1 {
  return { ...INITIAL_EDITOR_PROJECT, id: binding.editorProjectId, title };
}

function localRevision(documentRevision: number): ProjectRevisionId {
  return `local-revision:v1:${binding.editorProjectId}:timeline=0:document=${documentRevision}:graph=0:artifacts=0:looks=0` as ProjectRevisionId;
}

function sessionFor(
  project = document(),
): ProjectHydrationSession & { revision: ProjectRevisionId } {
  const result = {
    visualProject: project,
    lookInstances: { id: binding.editorProjectId, schemaVersion: 1, instances: {} },
    revision: 'local-1' as ProjectRevisionId,
    synchronizeVisualProject: vi.fn((next: JoyProjectV1) => next),
    synchronizeLookInstances: vi.fn(),
    synchronizeDocuments: vi.fn(),
  } as unknown as ProjectHydrationSession & { revision: ProjectRevisionId };
  Object.defineProperty(result, 'projectRevisionId', {
    get: () => result.revision,
  });
  return result;
}

function syncTransport(): SyncProjectDocument {
  return vi.fn().mockImplementation(async (projectId, params) => ({
    projectId,
    revisionId: params.revisionId,
  }));
}

class MissingDocumentError extends Error {
  readonly code = 'PROJECT_DOCUMENT_NOT_FOUND';
}

class ConflictError extends Error {
  readonly status = 409;
  readonly code = 'DOCUMENT_REVISION_CONFLICT';
}

describe('ordinary project document autosync', () => {
  it('hydrates an existing remote head before saving and does not echo local initial state', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });
      const session = sessionFor(document('Initial local state'));

      await expect(
        autosync.bootstrap(
          session,
          binding,
          async () => ({
            projectId: binding.controlPlaneProjectId,
            revisionId: 'remote-head-1',
            document: document('Remote head'),
          }),
          'owner-1',
        ),
      ).resolves.toEqual({ kind: 'hydrated', revisionId: 'remote-head-1' });

      autosync.schedule(binding, session.visualProject, session.projectRevisionId, 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      expect(sync).not.toHaveBeenCalled();
      expect(session.synchronizeDocuments).toHaveBeenCalledWith(document('Remote head'), undefined);
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toMatchObject({ documentRevisionId: 'remote-head-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves a missing cloud document and a later reload reads that saved head without another write', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const first = new ProjectDocumentAutosync({
        storage,
        syncProjectDocument: sync,
        isDocumentMissing: (error) => error instanceof MissingDocumentError,
      });
      const local = document('First local save');
      const firstSession = sessionFor(local);
      await expect(
        first.bootstrap(
          firstSession,
          binding,
          async () => {
            throw new MissingDocumentError('not found');
          },
          'owner-1',
        ),
      ).resolves.toEqual({ kind: 'missing' });

      first.schedule(binding, local, 'local-save-1', 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toMatchObject({ documentRevisionId: 'local-save-1' });

      const reloaded = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });
      const reloadSession = sessionFor(local);
      // A real EditorSession recovers the revision id written by the successful
      // autosync. Keep the fake session aligned with that durable revision.
      reloadSession.revision = 'local-save-1';
      await expect(
        reloaded.bootstrap(
          reloadSession,
          { ...binding, documentRevisionId: 'local-save-1' },
          async () => ({
            projectId: binding.controlPlaneProjectId,
            revisionId: 'local-save-1',
            document: local,
          }),
          'owner-1',
        ),
      ).resolves.toEqual({ kind: 'unchanged', revisionId: 'local-save-1' });
      reloaded.schedule(binding, local, reloadSession.projectRevisionId, 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a local edit but refuses an automatic save when the remote head is unknown', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const outcomes: string[] = [];
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({
        storage,
        syncProjectDocument: sync,
        onResult: (outcome) => outcomes.push(outcome.kind),
      });
      const local = document('Local recovery');
      const session = sessionFor(local);

      const result = await autosync.bootstrap(
        session,
        binding,
        async () => {
          session.revision = 'local-recovery-2';
          return {
            projectId: binding.controlPlaneProjectId,
            revisionId: 'remote-head-1',
            document: document('Remote head'),
          };
        },
        'owner-1',
      );

      autosync.schedule(binding, local, session.projectRevisionId, 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(sync).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'conflict', revisionId: 'remote-head-1' });
      expect(outcomes).toEqual(['conflict']);
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rebase a durable local edit over a newer remote head', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const outcomes: string[] = [];
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({
        storage,
        syncProjectDocument: sync,
        onResult: (outcome) => outcomes.push(outcome.kind),
      });
      const local = document('Local edit pending before restart');
      const session = sessionFor(local);
      const lastSyncedRevision = localRevision(1);
      session.revision = localRevision(2);
      const knownBinding = { ...binding, documentRevisionId: lastSyncedRevision };
      upsertControlPlaneProjectBinding(storage, knownBinding, 'owner-1');

      const result = await autosync.bootstrap(
        session,
        knownBinding,
        async () => ({
          projectId: binding.controlPlaneProjectId,
          revisionId: 'remote-head-2',
          document: document('Newer edit from another device'),
        }),
        'owner-1',
      );

      autosync.schedule(knownBinding, local, session.projectRevisionId, 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(sync).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'conflict', revisionId: 'remote-head-2' });
      expect(outcomes).toEqual(['conflict']);
      // Keep the prior synced baseline so a later restart cannot mistake this
      // local copy for the newly observed cloud revision.
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toMatchObject({ documentRevisionId: lastSyncedRevision });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a durable local edit made after the last successful sync', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });
      const local = document('Local edit pending before restart');
      const session = sessionFor(local);
      const currentLocalRevision = localRevision(2);
      const lastSyncedRevision = localRevision(1);
      session.revision = currentLocalRevision;
      const knownBinding = { ...binding, documentRevisionId: lastSyncedRevision };

      await expect(
        autosync.bootstrap(
          session,
          knownBinding,
          async () => ({
            projectId: binding.controlPlaneProjectId,
            revisionId: lastSyncedRevision,
            document: document('Last remote snapshot'),
          }),
          'owner-1',
        ),
      ).resolves.toEqual({ kind: 'local-changed', revisionId: lastSyncedRevision });

      autosync.schedule(knownBinding, local, session.projectRevisionId, 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(sync).toHaveBeenCalledWith(
        binding.controlPlaneProjectId,
        expect.objectContaining({
          baseRevisionId: lastSyncedRevision,
          revisionId: currentLocalRevision,
          document: local,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps local recovery untouched and stops automatic writes on a CAS conflict', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const outcomes: string[] = [];
      const sync: SyncProjectDocument = vi
        .fn()
        .mockRejectedValue(new ConflictError('remote changed'));
      const autosync = new ProjectDocumentAutosync({
        storage,
        syncProjectDocument: sync,
        onResult: (outcome) => outcomes.push(outcome.kind),
      });

      autosync.schedule(
        { ...binding, documentRevisionId: 'remote-old' },
        document(),
        'local-2',
        'owner-1',
      );
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      autosync.schedule(
        { ...binding, documentRevisionId: 'remote-old' },
        document('Later local edit'),
        'local-3',
        'owner-1',
      );
      await vi.advanceTimersByTimeAsync(
        DOCUMENT_AUTOSYNC_RETRY_INITIAL_MS + DOCUMENT_AUTOSYNC_DEBOUNCE_MS,
      );

      expect(sync).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(['conflict']);
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries request failures without losing the latest local revision', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync: SyncProjectDocument = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(async (projectId, params) => ({
          projectId,
          revisionId: params.revisionId,
        }));
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });

      autosync.schedule(binding, document(), 'local-2', 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_RETRY_INITIAL_MS);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toMatchObject({ documentRevisionId: 'local-2' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces and coalesces successive revisions for one owner/project', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });

      autosync.schedule(binding, document('First edit'), 'local-2', 'owner-1');
      autosync.schedule(binding, document('Newest edit'), 'local-3', 'owner-1');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS - 1);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith(
        binding.controlPlaneProjectId,
        expect.objectContaining({
          baseRevisionId: '',
          revisionId: 'local-3',
          document: document('Newest edit'),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pending writes scoped to their owner and project across a project switch', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });
      const nextBinding: ControlPlaneProjectBinding = {
        editorProjectId: 'editor-doc-2',
        controlPlaneProjectId: 'project-server-2',
        title: 'Second cut',
      };
      const nextDocument = { ...document('Second cut'), id: nextBinding.editorProjectId };

      autosync.schedule(binding, document(), 'local-a', 'owner-1');
      autosync.schedule(nextBinding, nextDocument, 'local-b', 'owner-2');
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(sync).toHaveBeenCalledTimes(2);
      expect(sync).toHaveBeenCalledWith(
        binding.controlPlaneProjectId,
        expect.objectContaining({
          revisionId: 'local-a',
          document: document(),
        }),
      );
      expect(sync).toHaveBeenCalledWith(
        nextBinding.controlPlaneProjectId,
        expect.objectContaining({
          revisionId: 'local-b',
          document: nextDocument,
        }),
      );
      expect(
        getControlPlaneProjectBinding(storage, binding.editorProjectId, 'owner-1'),
      ).toMatchObject({ documentRevisionId: 'local-a' });
      expect(
        getControlPlaneProjectBinding(storage, nextBinding.editorProjectId, 'owner-2'),
      ).toMatchObject({ documentRevisionId: 'local-b' });
    } finally {
      vi.useRealTimers();
    }
  });

  // R2 / GAP 1a
  it('forwards the queued lookInstances document to the transport under the same revision', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = syncTransport();
      const autosync = new ProjectDocumentAutosync({ storage, syncProjectDocument: sync });
      const lookInstances = {
        id: binding.editorProjectId,
        schemaVersion: 1 as const,
        instances: {},
      };

      autosync.schedule(binding, document('With looks'), 'local-2', 'owner-1', lookInstances);
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(sync).toHaveBeenCalledWith(
        binding.controlPlaneProjectId,
        expect.objectContaining({ revisionId: 'local-2', lookInstances }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a CAS conflict on a Look-carrying write leaves recovery untouched and stops writes', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const sync = vi.fn().mockRejectedValue(new ConflictError('revision conflict'));
      const outcomes: string[] = [];
      const autosync = new ProjectDocumentAutosync({
        storage,
        syncProjectDocument: sync as unknown as SyncProjectDocument,
        onResult: (r) => outcomes.push(r.kind),
      });
      const lookInstances = {
        id: binding.editorProjectId,
        schemaVersion: 1 as const,
        instances: {},
      };

      autosync.schedule(binding, document(), 'local-2', 'owner-1', lookInstances);
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);
      // A further scheduled write after a conflict is dropped (no second call).
      autosync.schedule(binding, document('Later'), 'local-3', 'owner-1', lookInstances);
      await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSYNC_DEBOUNCE_MS);

      expect(outcomes).toEqual(['conflict']);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
