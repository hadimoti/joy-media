import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import {
  acquireProjectWriter,
  PROJECT_WRITER_FENCE_STORAGE_KEY,
  PROJECT_WRITER_LOCK_NAME,
  ProjectWriterFenceMismatchError,
  ProjectWriterReleasedError,
  ProjectWriterReservedStorageKeyError,
} from './project-writer.js';
import type {
  OriginWriterLock,
  OriginWriterLockManager,
  ProjectWriterStorage,
} from './project-writer.js';

class MemoryStorage implements ProjectWriterStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** A deterministic lock manager whose held callback does not finish until release. */
class FakeOriginWriterLockManager implements OriginWriterLockManager {
  readonly requests: {
    readonly name: string;
    readonly options: { readonly mode: 'exclusive'; readonly ifAvailable: true };
  }[] = [];
  #held = false;

  get held(): boolean {
    return this.#held;
  }

  async request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: OriginWriterLock | null) => T | Promise<T>,
  ): Promise<T> {
    this.requests.push({ name, options });
    if (this.#held) return callback(null);

    this.#held = true;
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.#held = false;
    }
  }
}

describe('acquireProjectWriter', () => {
  it('owns one retained exclusive origin lock and exposes a fenced write capability', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();

    const acquired = await acquireProjectWriter({ storage, lockManager: locks });

    expect(acquired.kind).toBe('owned');
    if (acquired.kind !== 'owned') return;
    expect(acquired.fence).toBe(1);
    expect(acquired.writer.fence).toBe(1);
    expect(locks.held).toBe(true);
    expect(locks.requests).toEqual([
      {
        name: PROJECT_WRITER_LOCK_NAME,
        options: { mode: 'exclusive', ifAvailable: true },
      },
    ]);

    const guarded = acquired.writer.guardStorage(storage);
    guarded.setItem('project-log', 'committed');
    expect(() => guarded.setItem(PROJECT_WRITER_FENCE_STORAGE_KEY, '0')).toThrow(
      ProjectWriterReservedStorageKeyError,
    );
    expect(storage.getItem('project-log')).toBe('committed');
    expect(storage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY)).toBe('1');

    await acquired.writer.release();
    expect(locks.held).toBe(false);
  });

  it('reports a concurrent writer as busy and a missing Web Locks API as unsupported', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const first = await acquireProjectWriter({ storage, lockManager: locks });
    expect(first.kind).toBe('owned');

    const second = await acquireProjectWriter({ storage, lockManager: locks });
    expect(second).toEqual({ kind: 'busy' });
    expect(storage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY)).toBe('1');
    expect(await acquireProjectWriter({ storage, lockManager: null })).toEqual({
      kind: 'unsupported',
    });

    if (first.kind === 'owned') await first.writer.release();
  });

  it('rejects a simultaneous second acquisition before the first caller awaits its result', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();

    const firstPromise = acquireProjectWriter({ storage, lockManager: locks });
    const secondPromise = acquireProjectWriter({ storage, lockManager: locks });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.kind).toBe('owned');
    expect(second).toEqual({ kind: 'busy' });
    if (first.kind === 'owned') await first.writer.release();
  });

  it('releases idempotently and allocates a strictly increasing durable fence on reacquisition', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const first = await acquireProjectWriter({ storage, lockManager: locks });
    expect(first.kind).toBe('owned');
    if (first.kind !== 'owned') return;

    const firstRelease = first.writer.release();
    expect(first.writer.release()).toBe(firstRelease);
    await firstRelease;

    const second = await acquireProjectWriter({ storage, lockManager: locks });
    expect(second.kind).toBe('owned');
    if (second.kind !== 'owned') return;
    expect(second.fence).toBe(2);
    expect(storage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY)).toBe('2');
    await second.writer.release();
  });

  it('fences a released EditorSession from persistence and agent commits after another writer takes ownership', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const initialTimeline = buildReferenceSpikeProject();
    const first = await acquireProjectWriter({ storage, lockManager: locks });
    expect(first.kind).toBe('owned');
    if (first.kind !== 'owned') return;

    const firstSession = new EditorSession(
      first.writer.guardStorage(storage),
      initialTimeline,
      INITIAL_EDITOR_PROJECT,
      {},
      first.writer,
    );
    firstSession.dispatchVisualObjects({
      label: 'First writer edit',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 20 },
        },
      ],
    });

    await first.writer.release();
    const second = await acquireProjectWriter({ storage, lockManager: locks });
    expect(second.kind).toBe('owned');
    if (second.kind !== 'owned') return;

    try {
      const secondSession = new EditorSession(
        second.writer.guardStorage(storage),
        initialTimeline,
        INITIAL_EDITOR_PROJECT,
        {},
        second.writer,
      );
      expect(secondSession.visualProject.visualObjects['intro-title']?.transform.x).toBe(20);
      const durableStateBeforeStaleCalls = [...storage.values.entries()];

      expect(() =>
        firstSession.dispatchVisualObjects({
          label: 'Stale persistence must fail',
          commands: [
            {
              type: 'object.setTransformProperty',
              payload: { objectId: 'intro-title', key: 'x', value: 40 },
            },
          ],
        }),
      ).toThrow(ProjectWriterReleasedError);
      expect(() =>
        firstSession.commitAgentCompound(
          'Stale agent commit must fail',
          { document: { ...firstSession.visualProject, title: 'stale title' } },
          {
            executionId: 'released-writer-agent-commit',
            operationDigest: 'a'.repeat(64),
            baseRevision: firstSession.projectRevisionId,
            changedEntityIds: ['root'],
          },
        ),
      ).toThrow(ProjectWriterReleasedError);
      expect([...storage.values.entries()]).toEqual(durableStateBeforeStaleCalls);

      const receipt = secondSession.commitAgentCompound(
        'Second writer agent commit',
        { document: { ...secondSession.visualProject, title: 'owned by second writer' } },
        {
          executionId: 'second-writer-agent-commit',
          operationDigest: 'b'.repeat(64),
          baseRevision: secondSession.projectRevisionId,
          changedEntityIds: ['root'],
        },
      );
      expect(receipt.writerFence).toBe(second.fence);

      const reopened = new EditorSession(
        second.writer.guardStorage(storage),
        initialTimeline,
        INITIAL_EDITOR_PROJECT,
        {},
        second.writer,
      );
      expect(reopened.visualProject.title).toBe('owned by second writer');
      expect(reopened.visualProject.visualObjects['intro-title']?.transform.x).toBe(20);
      expect(
        reopened.agentIdempotency.getExecutionReceipt('released-writer-agent-commit'),
      ).toBeUndefined();
      expect(
        reopened.agentIdempotency.getExecutionReceipt('second-writer-agent-commit'),
      ).toMatchObject({ writerFence: second.fence });
    } finally {
      await second.writer.release();
    }
  });

  it('blocks stale guarded writes as soon as the writer is released', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const acquired = await acquireProjectWriter({ storage, lockManager: locks });
    expect(acquired.kind).toBe('owned');
    if (acquired.kind !== 'owned') return;
    const guarded = acquired.writer.guardStorage(storage);
    guarded.setItem('before-release', 'safe');

    await acquired.writer.release();

    expect(() => acquired.writer.assertActive()).toThrow(ProjectWriterReleasedError);
    expect(() => guarded.setItem('after-release', 'must-not-write')).toThrow(
      ProjectWriterReleasedError,
    );
    expect(() => guarded.removeItem?.('before-release')).toThrow(ProjectWriterReleasedError);
    expect(storage.getItem('before-release')).toBe('safe');
    expect(storage.getItem('after-release')).toBeNull();
  });

  it('invalidates a writer when the durable fence no longer proves its authority', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const acquired = await acquireProjectWriter({ storage, lockManager: locks });
    expect(acquired.kind).toBe('owned');
    if (acquired.kind !== 'owned') return;
    const guarded = acquired.writer.guardStorage(storage);

    // This simulates a newer owner having established a later durable fence.
    // The old handle must refuse a write even before its eventual Web Lock
    // callback observes termination.
    storage.setItem(PROJECT_WRITER_FENCE_STORAGE_KEY, '2');

    expect(() => guarded.setItem('must-not-write', 'stale')).toThrow(
      ProjectWriterFenceMismatchError,
    );
    expect(() => acquired.writer.assertActive()).toThrow(ProjectWriterReleasedError);
    expect(storage.getItem('must-not-write')).toBeNull();
    await acquired.writer.release();
  });

  it('also protects removeItem and supports adapters that cannot remove keys', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeOriginWriterLockManager();
    const acquired = await acquireProjectWriter({ storage, lockManager: locks });
    expect(acquired.kind).toBe('owned');
    if (acquired.kind !== 'owned') return;
    const guarded = acquired.writer.guardStorage(storage);

    expect(() => guarded.removeItem?.(PROJECT_WRITER_FENCE_STORAGE_KEY)).toThrow(
      ProjectWriterReservedStorageKeyError,
    );
    const noRemoveAdapter: ProjectWriterStorage = {
      getItem: storage.getItem.bind(storage),
      setItem: storage.setItem.bind(storage),
    };
    const noRemoveGuard = acquired.writer.guardStorage(noRemoveAdapter);
    expect(noRemoveGuard.removeItem).toBeUndefined();
    noRemoveGuard.setItem('adapter-write', 'ok');

    await acquired.writer.release();
    expect(() => noRemoveGuard.setItem('adapter-write', 'stale')).toThrow(
      ProjectWriterReleasedError,
    );
  });

  it('fails closed for fence storage read, write, and post-write readback failures', async () => {
    const locks = new FakeOriginWriterLockManager();
    const readFailure: ProjectWriterStorage = {
      getItem: () => {
        throw new Error('read denied');
      },
      setItem: () => undefined,
    };
    await expect(
      acquireProjectWriter({ storage: readFailure, lockManager: locks }),
    ).resolves.toEqual({ kind: 'storage-unavailable', reason: 'storage-read-failed' });

    const writeFailure: ProjectWriterStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('write denied');
      },
    };
    await expect(
      acquireProjectWriter({ storage: writeFailure, lockManager: locks }),
    ).resolves.toEqual({ kind: 'storage-unavailable', reason: 'storage-write-failed' });

    const readbackMismatch: ProjectWriterStorage = {
      getItem: () => null,
      setItem: () => undefined,
    };
    await expect(
      acquireProjectWriter({ storage: readbackMismatch, lockManager: locks }),
    ).resolves.toEqual({ kind: 'storage-unavailable', reason: 'storage-write-failed' });
  });

  it('invalidates a granted capability if an adapter reports lock termination', async () => {
    let terminate!: () => void;
    const terminated = new Promise<void>((resolve) => {
      terminate = resolve;
    });
    const locks: OriginWriterLockManager = {
      async request<T>(
        _name: string,
        _options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
        callback: (lock: OriginWriterLock | null) => T | Promise<T>,
      ): Promise<T> {
        void callback({ name: PROJECT_WRITER_LOCK_NAME, mode: 'exclusive' });
        await terminated;
        return undefined as T;
      },
    };
    const acquired = await acquireProjectWriter({
      storage: new MemoryStorage(),
      lockManager: locks,
    });
    expect(acquired.kind).toBe('owned');
    if (acquired.kind !== 'owned') return;

    terminate();
    await Promise.resolve();
    await Promise.resolve();

    expect(() => acquired.writer.assertActive()).toThrow(ProjectWriterReleasedError);
    await acquired.writer.release();
  });

  it('returns unsupported when the lock manager rejects before granting ownership', async () => {
    const locks: OriginWriterLockManager = {
      request: async () => {
        throw new Error('locks unavailable');
      },
    };

    await expect(
      acquireProjectWriter({ storage: new MemoryStorage(), lockManager: locks }),
    ).resolves.toEqual({ kind: 'unsupported' });
  });

  it('rejects malformed and overflow fences instead of resetting durable authority', async () => {
    const locks = new FakeOriginWriterLockManager();
    const malformed = new MemoryStorage();
    malformed.setItem(PROJECT_WRITER_FENCE_STORAGE_KEY, '01');
    await expect(acquireProjectWriter({ storage: malformed, lockManager: locks })).resolves.toEqual(
      {
        kind: 'storage-unavailable',
        reason: 'invalid-fence',
      },
    );
    expect(malformed.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY)).toBe('01');

    const overflow = new MemoryStorage();
    overflow.setItem(PROJECT_WRITER_FENCE_STORAGE_KEY, String(Number.MAX_SAFE_INTEGER));
    await expect(acquireProjectWriter({ storage: overflow, lockManager: locks })).resolves.toEqual({
      kind: 'storage-unavailable',
      reason: 'fence-overflow',
    });
    expect(overflow.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY)).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
  });
});
