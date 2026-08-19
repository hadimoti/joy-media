import { describe, expect, it, vi } from 'vitest';
import {
  type ControlPlaneProjectBinding,
  getControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
} from './project-control-plane.js';
import {
  syncProjectDocumentBinding,
  type DocumentSyncResult,
  type SyncProjectDocument,
} from './project-document-sync.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const binding: ControlPlaneProjectBinding = {
  editorProjectId: 'local-edit-1',
  controlPlaneProjectId: 'project-server-1',
  title: 'Campaign cut',
};

const document = {
  id: 'local-edit-1',
  title: 'Campaign cut',
  revision: 1,
  timeline: { tracks: [], markers: [] },
};

const revisionId = 'cas-rev-abc123';

// Success response matching the binding and revision
const successResponse = {
  projectId: 'project-server-1',
  revisionId: 'cas-rev-abc123',
};

// Conflict error (409 DOCUMENT_REVISION_CONFLICT)
class ConflictError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'ConflictError';
  }
  readonly status = 409;
  readonly code = 'DOCUMENT_REVISION_CONFLICT';
}

// Generic network error
class NetworkError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

describe('project-document-sync', () => {
  it('performs first sync and persists documentRevisionId', async () => {
    const storage = memoryStorage();
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    const result = await syncProjectDocumentBinding(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(result).toEqual({
      kind: 'success',
      projectId: 'project-server-1',
      revisionId: 'cas-rev-abc123',
    });

    expect(syncProjectDocument).toHaveBeenCalledWith('project-server-1', {
      baseRevisionId: '',
      revisionId: 'cas-rev-abc123',
      document,
    });

    const persisted = getControlPlaneProjectBinding(storage, 'local-edit-1', 'local');
    expect(persisted?.documentRevisionId).toBe('cas-rev-abc123');
  });

  it('performs subsequent CAS sync with previous documentRevisionId as base', async () => {
    const storage = memoryStorage();
    const bindingWithRevision: ControlPlaneProjectBinding = {
      ...binding,
      documentRevisionId: 'cas-rev-previous',
    };
    upsertControlPlaneProjectBinding(storage, bindingWithRevision, 'user-1');

    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    const result = await syncProjectDocumentBinding(
      bindingWithRevision,
      document,
      revisionId,
      storage,
      syncProjectDocument,
      { ownerKey: 'user-1' },
    );

    expect(result).toEqual({
      kind: 'success',
      projectId: 'project-server-1',
      revisionId: 'cas-rev-abc123',
    });

    expect(syncProjectDocument).toHaveBeenCalledWith('project-server-1', {
      baseRevisionId: 'cas-rev-previous',
      revisionId: 'cas-rev-abc123',
      document,
    });

    const persisted = getControlPlaneProjectBinding(storage, 'local-edit-1', 'user-1');
    expect(persisted?.documentRevisionId).toBe('cas-rev-abc123');
  });

  it('returns conflict result and leaves binding unchanged on 409 DOCUMENT_REVISION_CONFLICT', async () => {
    const storage = memoryStorage();
    const bindingWithRevision: ControlPlaneProjectBinding = {
      ...binding,
      documentRevisionId: 'cas-rev-old',
    };
    upsertControlPlaneProjectBinding(storage, bindingWithRevision, 'local');

    const conflict = new ConflictError('base revision mismatch');
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockRejectedValue(conflict);

    const result = await syncProjectDocumentBinding(
      bindingWithRevision,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(result).toEqual({
      kind: 'conflict',
      message: 'base revision mismatch',
    });

    // Binding should be unchanged
    const persisted = getControlPlaneProjectBinding(storage, 'local-edit-1', 'local');
    expect(persisted?.documentRevisionId).toBe('cas-rev-old');
  });

  it('fails without network call when document.id does not match binding.editorProjectId', async () => {
    const storage = memoryStorage();
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    const mismatchedDocument = {
      ...document,
      id: 'different-id',
    };

    const result = await syncProjectDocumentBinding(
      binding,
      mismatchedDocument,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(syncProjectDocument).not.toHaveBeenCalled();
    expect(result.kind).toBe('request-failure');
    expect((result as { kind: 'request-failure'; error: Error }).error).toBeInstanceOf(Error);
    expect(
      (result as { kind: 'request-failure'; error: Error }).error.message,
    ).toContain('does not match');
  });

  it('fails without persistence when sync response projectId does not match', async () => {
    const storage = memoryStorage();
    const mismatchedResponse = {
      projectId: 'project-server-999',
      revisionId: 'cas-rev-abc123',
    };
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(mismatchedResponse);

    const result = await syncProjectDocumentBinding(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(result.kind).toBe('request-failure');

    // No binding should be persisted
    const persisted = getControlPlaneProjectBinding(storage, 'local-edit-1', 'local');
    expect(persisted).toBeUndefined();
  });

  it('fails without persistence when sync response revisionId does not match', async () => {
    const storage = memoryStorage();
    const mismatchedResponse = {
      projectId: 'project-server-1',
      revisionId: 'cas-rev-different',
    };
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(mismatchedResponse);

    const result = await syncProjectDocumentBinding(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(result.kind).toBe('request-failure');

    // No binding should be persisted
    const persisted = getControlPlaneProjectBinding(storage, 'local-edit-1', 'local');
    expect(persisted).toBeUndefined();
  });

  it('persists binding with owner-scoped key', async () => {
    const storage = memoryStorage();
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    await syncProjectDocumentBinding(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
      { ownerKey: 'gmail-user' },
    );

    // Should be persisted under gmail-user
    const persistedGmail = getControlPlaneProjectBinding(storage, 'local-edit-1', 'gmail-user');
    expect(persistedGmail?.documentRevisionId).toBe('cas-rev-abc123');

    // Should NOT be under local
    const persistedLocal = getControlPlaneProjectBinding(storage, 'local-edit-1', 'local');
    expect(persistedLocal).toBeUndefined();
  });

  it('propagates non-conflict errors unchanged', async () => {
    const storage = memoryStorage();
    const networkError = new NetworkError('connection refused');
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockRejectedValue(networkError);

    const result = await syncProjectDocumentBinding(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    expect(result.kind).toBe('request-failure');
    expect((result as { kind: 'request-failure'; error: unknown }).error).toBe(networkError);
  });

  it('does not mutate the input binding', async () => {
    const storage = memoryStorage();
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    const originalBinding: ControlPlaneProjectBinding = {
      ...binding,
    };

    await syncProjectDocumentBinding(
      originalBinding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
    );

    // Original binding should be unchanged
    expect(originalBinding.documentRevisionId).toBeUndefined();
  });

  it('does not mutate the input document', async () => {
    const storage = memoryStorage();
    const syncProjectDocument: SyncProjectDocument = vi.fn().mockResolvedValue(successResponse);

    const originalDocument = {
      ...document,
    };

    await syncProjectDocumentBinding(
      binding,
      originalDocument,
      revisionId,
      storage,
      syncProjectDocument,
    );

    // Original document should be unchanged
    expect(originalDocument).toEqual(document);
  });
});
