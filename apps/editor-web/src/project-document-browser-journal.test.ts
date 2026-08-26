import { describe, expect, it } from 'vitest';
import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  ProjectDocumentBrowserJournal,
  ProjectDocumentJournalError,
  type ProjectDocumentBrowserJournalStorage,
} from './project-document-browser-journal.js';
import {
  IndexedDbProjectDocumentJournalStorage,
  OpfsProjectDocumentJournalStorage,
  type IndexedDbDatabaseLike,
  type IndexedDbFactoryLike,
  type IndexedDbObjectStoreLike,
  type IndexedDbOpenRequestLike,
  type IndexedDbRequestLike,
  type IndexedDbTransactionLike,
} from './project-document-browser-journal-storage.js';

function memoryStorage(): ProjectDocumentBrowserJournalStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function documentAt(version: number, title = `Project ${String(version)}`): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    projectId: 'project-a',
    title,
    timeline: { version },
  };
}

describe('ProjectDocumentBrowserJournal', () => {
  it('writes a V2 snapshot with append-only operation and checkpoint metadata', async () => {
    const storage = memoryStorage();
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a');

    await expect(
      journal.append(documentAt(1), {
        operationId: 'op-1',
        operationKind: 'title.edit',
        operationMetadata: { source: 'editor' },
        checkpointId: 'cp-1',
      }),
    ).resolves.toMatchObject({ revision: 1, snapshot: { checksum: expect.any(String) } });
    await expect(journal.state()).resolves.toMatchObject({
      snapshots: [{ revision: 1, document: documentAt(1) }],
      operations: [{ operationId: 'op-1', kind: 'title.edit', revision: 1 }],
      checkpoints: [{ checkpointId: 'cp-1', revision: 1, operationCount: 1 }],
    });
  });

  it('retains a local legacy backup across fresh journal instances', async () => {
    const storage = memoryStorage();
    const backup = {
      filename: 'legacy.json',
      mimeType: 'application/json' as const,
      content: '{"project":{}}\n',
    };
    const first = new ProjectDocumentBrowserJournal(storage, 'project-a');
    await first.saveLegacyBackup(backup);
    await expect(
      new ProjectDocumentBrowserJournal(storage, 'project-a').loadLegacyBackup(),
    ).resolves.toEqual(backup);
  });

  it('finds valid backup content when availability metadata is missing or corrupt', async () => {
    const storage = memoryStorage();
    const backup = {
      filename: 'legacy.json',
      mimeType: 'application/json' as const,
      content: '{"project":{"title":"Keep me"}}\n',
    };
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a');
    await journal.saveLegacyBackup(backup);
    storage.values.delete(journal.backupMetadataStorageKey);
    await expect(journal.hasLegacyBackup()).resolves.toBe(true);
    storage.values.set(journal.backupMetadataStorageKey, '{bad metadata');
    await expect(journal.hasLegacyBackup()).resolves.toBe(true);
    await expect(journal.loadLegacyBackup()).resolves.toEqual(backup);
  });

  it('recovers the newest document after a fresh journal instance reopens storage', async () => {
    const storage = memoryStorage();
    await new ProjectDocumentBrowserJournal(storage, 'project-a').append(documentAt(1));
    await new ProjectDocumentBrowserJournal(storage, 'project-a').append(documentAt(2));

    await expect(
      new ProjectDocumentBrowserJournal(storage, 'project-a').recover(),
    ).resolves.toEqual({
      document: documentAt(2),
      revision: 2,
      recoveredWithWarnings: false,
      warnings: [],
    });
  });

  it('falls back to the newest verified snapshot when the latest entry is corrupt', async () => {
    const storage = memoryStorage();
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a');
    await journal.append(documentAt(1));
    await journal.append(documentAt(2));
    const key = journal.storageKey;
    const database = JSON.parse(storage.values.get(key)!) as {
      snapshots: Array<{ document: ProjectDocumentV2 }>;
    };
    database.snapshots[1]!.document = documentAt(2, 'tampered');
    storage.values.set(key, JSON.stringify(database));

    await expect(journal.recover()).resolves.toMatchObject({
      document: documentAt(1),
      revision: 1,
      recoveredWithWarnings: true,
      warnings: ['ignored snapshot revision 2: checksum failed'],
    });
  });

  it('rejects invalid schema documents and media/path-bearing documents before writing', async () => {
    const storage = memoryStorage();
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a');

    await expect(
      journal.append({ ...documentAt(1), schemaVersion: 1 } as unknown as ProjectDocumentV2),
    ).rejects.toMatchObject({ code: 'JOURNAL_INVALID_DOCUMENT' });
    await expect(
      journal.append({ ...documentAt(1), assets: { localPath: 'C:\\media\\clip.mp4' } }),
    ).rejects.toMatchObject({ code: 'JOURNAL_INVALID_DOCUMENT' });
    expect(storage.values.size).toBe(0);
  });

  it('bounds snapshots and append-only metadata retention', async () => {
    const storage = memoryStorage();
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a', {
      maxSnapshots: 2,
      maxOperations: 3,
      maxCheckpoints: 2,
    });
    for (let version = 1; version <= 5; version += 1) await journal.append(documentAt(version));

    const state = await journal.state();
    expect(state.snapshots.map((entry) => entry.revision)).toEqual([4, 5]);
    expect(state.operations.map((entry) => entry.revision)).toEqual([3, 4, 5]);
    expect(state.checkpoints.map((entry) => entry.revision)).toEqual([4, 5]);
    await expect(journal.recover()).resolves.toMatchObject({ revision: 5 });
  });

  it('surfaces storage failures without claiming the document was persisted', async () => {
    const storage: ProjectDocumentBrowserJournalStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const journal = new ProjectDocumentBrowserJournal(storage, 'project-a');

    const error = await journal.append(documentAt(1)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProjectDocumentJournalError);
    expect(error).toMatchObject({ code: 'JOURNAL_STORAGE_WRITE_FAILED' });
  });

  it('reopens an IndexedDB journal through a fresh adapter instance', async () => {
    const indexedDB = new FakeIndexedDb();
    const firstStorage = new IndexedDbProjectDocumentJournalStorage({ indexedDB });
    await new ProjectDocumentBrowserJournal(firstStorage, 'project-a').append(documentAt(1));

    const reopenedStorage = new IndexedDbProjectDocumentJournalStorage({ indexedDB });
    await expect(
      new ProjectDocumentBrowserJournal(reopenedStorage, 'project-a').recover(),
    ).resolves.toMatchObject({
      document: documentAt(1),
      revision: 1,
    });
  });

  it('reports IndexedDB open and read failures explicitly', async () => {
    const openFailure = new IndexedDbProjectDocumentJournalStorage({
      indexedDB: new FakeIndexedDb(new Error('open failed')),
    });
    await expect(openFailure.getItem('key')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_UNAVAILABLE',
    });

    const readFailure = new IndexedDbProjectDocumentJournalStorage({
      indexedDB: new FakeIndexedDb(undefined, new Error('read failed')),
    });
    await expect(readFailure.getItem('key')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_READ_FAILED',
    });
  });

  it('reports IndexedDB write and quota failures without falling back', async () => {
    const writeFailure = new IndexedDbProjectDocumentJournalStorage({
      indexedDB: new FakeIndexedDb(undefined, undefined, new Error('write failed')),
    });
    await expect(writeFailure.setItem('key', 'value')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_WRITE_FAILED',
    });

    const quotaFailure = new IndexedDbProjectDocumentJournalStorage({
      indexedDB: new FakeIndexedDb(undefined, undefined, new Error('quota'), true),
    });
    await expect(quotaFailure.setItem('key', 'value')).rejects.toMatchObject({
      code: 'JOURNAL_QUOTA_EXCEEDED',
    });
  });

  it('preserves explicit OPFS unavailability when directory access is denied', async () => {
    const storage = new OpfsProjectDocumentJournalStorage({
      getDirectory: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(storage.getItem('key')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_UNAVAILABLE',
    });
    await expect(storage.setItem('key', 'value')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_UNAVAILABLE',
    });
  });

  it('keeps OPFS file read/write denials distinct from directory unavailability', async () => {
    const storage = new OpfsProjectDocumentJournalStorage({
      directory: {
        getFileHandle: async (_name, options) => {
          throw new Error(options?.create ? 'write denied' : 'read denied');
        },
      },
    });

    await expect(storage.getItem('key')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_READ_FAILED',
    });
    await expect(storage.setItem('key', 'value')).rejects.toMatchObject({
      code: 'JOURNAL_STORAGE_WRITE_FAILED',
    });
  });
});

class FakeIndexedDb implements IndexedDbFactoryLike {
  readonly #values = new Map<string, string>();
  readonly #openError: Error | undefined;
  readonly #readError: Error | undefined;
  readonly #writeError: Error | undefined;
  readonly #quota: boolean;
  #hasStore = false;

  constructor(openError?: Error, readError?: Error, writeError?: Error, quota = false) {
    this.#openError = openError;
    this.#readError = readError;
    this.#writeError = writeError;
    this.#quota = quota;
  }

  open(_name: string, _version: number): IndexedDbOpenRequestLike {
    const database = this.database();
    const request: IndexedDbOpenRequestLike = {
      result: database,
      error: this.#openError,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      if (this.#openError !== undefined) request.onerror?.();
      else {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }
    });
    return request;
  }

  private database(): IndexedDbDatabaseLike {
    return {
      objectStoreNames: { contains: () => this.#hasStore },
      createObjectStore: () => {
        this.#hasStore = true;
      },
      transaction: () => this.transaction(),
    };
  }

  private transaction(): IndexedDbTransactionLike {
    const transaction: IndexedDbTransactionLike = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => this.objectStore(transaction),
    };
    return transaction;
  }

  private objectStore(transaction: IndexedDbTransactionLike): IndexedDbObjectStoreLike {
    return {
      get: (key) => {
        const request = this.request();
        queueMicrotask(() => {
          if (this.#readError !== undefined) {
            request.error = this.#readError;
            request.onerror?.();
          } else {
            request.result = this.#values.get(key);
            request.onsuccess?.();
          }
        });
        return request;
      },
      put: (value, key) => {
        const request = this.request();
        queueMicrotask(() => {
          if (this.#writeError !== undefined || this.#quota) {
            request.error = this.#quota
              ? Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
              : this.#writeError;
            request.onerror?.();
            transaction.onerror?.(request.error);
          } else {
            this.#values.set(key, value);
            request.onsuccess?.();
            setTimeout(() => transaction.oncomplete?.(), 0);
          }
        });
        return request;
      },
    };
  }

  private request(): IndexedDbRequestLike<unknown> & { result: unknown; error?: unknown } {
    return { result: undefined, error: undefined, onsuccess: null, onerror: null };
  }
}
