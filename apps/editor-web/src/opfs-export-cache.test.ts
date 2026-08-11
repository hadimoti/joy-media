import { describe, expect, it } from 'vitest';
import {
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type WritableOpfsFile,
} from './opfs-asset-cache.js';
import { OpfsExportCache } from './opfs-export-cache.js';

describe('OpfsExportCache', () => {
  it('writes, reopens, and removes the exact durable export', async () => {
    const memory = memoryOpfs();
    const cache = new OpfsExportCache(memory.root);
    const source = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });

    const stored = await cache.putVerified('export-1', source);
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await cache.get('export-1')).toBeDefined();

    await cache.removeVerified('export-1');
    expect(await cache.get('export-1')).toBeUndefined();
  });

  it('removes a failed readback instead of retaining an unverifiable result', async () => {
    const memory = memoryOpfs({ truncateWrites: true });
    const cache = new OpfsExportCache(memory.root);

    await expect(cache.putVerified('export-bad', new Blob(['complete']))).rejects.toThrow(
      'verification failed',
    );
    expect(await cache.get('export-bad')).toBeUndefined();
  });

  it('rejects same-size byte corruption', async () => {
    const cache = new OpfsExportCache(memoryOpfs({ corruptWrites: true }).root);

    await expect(cache.putVerified('export-corrupt', new Blob(['abcd']))).rejects.toThrow(
      'verification failed',
    );
    expect(await cache.get('export-corrupt')).toBeUndefined();
  });

  it('preserves the prior verified export when a later write exceeds quota', async () => {
    const cache = new OpfsExportCache(memoryOpfs({ failWriteAfter: 1 }).root);
    const prior = new Blob(['prior-export']);
    await cache.putVerified('export-prior', prior);

    await expect(cache.putVerified('export-next', new Blob(['next-export']))).rejects.toMatchObject(
      {
        name: 'QuotaExceededError',
      },
    );
    expect(await cache.get('export-next')).toBeUndefined();
    expect(await cache.get('export-prior')).toBeDefined();
    expect(await (await cache.get('export-prior'))!.text()).toBe('prior-export');
  });

  it('counts kept bytes in the budget and removes oldest non-kept files first', async () => {
    const memory = memoryOpfs();
    const cache = new OpfsExportCache(memory.root);
    await cache.put('old', new Blob(['1111']));
    await cache.put('middle', new Blob(['2222']));
    await cache.put('new', new Blob(['3333']));

    expect(await cache.prune(8, ['new'])).toEqual(['old']);
    expect(await cache.get('old')).toBeUndefined();
    expect(await cache.get('middle')).toBeDefined();
    expect(await cache.get('new')).toBeDefined();
  });

  it('keeps an explicitly retained file even when it alone exceeds the budget', async () => {
    const memory = memoryOpfs();
    const cache = new OpfsExportCache(memory.root);
    await cache.put('keep', new Blob(['12345']));
    await cache.put('remove', new Blob(['12']));

    expect(await cache.prune(1, ['keep'])).toEqual(['remove']);
    expect(await cache.get('keep')).toBeDefined();
  });

  it('rejects invalid cache ids and byte budgets', async () => {
    const cache = new OpfsExportCache(memoryOpfs().root);
    await expect(cache.put('../escape', new Blob(['x']))).rejects.toThrow('export id');
    await expect(cache.prune(-1)).rejects.toThrow('maxBytes');
  });
});

function memoryOpfs(
  options: {
    readonly truncateWrites?: boolean;
    readonly corruptWrites?: boolean;
    readonly failWriteAfter?: number;
  } = {},
): {
  readonly root: OpfsDirectoryHandle;
} {
  const files = new Map<string, { readonly blob: Blob; readonly modified: number }>();
  let clock = 1;
  let writes = 0;
  const root: OpfsDirectoryHandle = {
    async getDirectoryHandle() {
      return root;
    },
    async getFileHandle(name, handleOptions) {
      if (!files.has(name) && handleOptions?.create !== true) throw notFound();
      return fileHandle(name);
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw notFound();
    },
    async *entries() {
      for (const name of files.keys()) yield [name, fileHandle(name)] as [string, OpfsFileHandle];
    },
  };

  function fileHandle(name: string): OpfsFileHandle {
    return {
      async getFile() {
        const value = files.get(name);
        if (value === undefined) throw notFound();
        const file = new Blob([value.blob]) as File;
        Object.defineProperty(file, 'lastModified', { value: value.modified });
        return file;
      },
      async createWritable() {
        let pending: Blob | undefined;
        const writable: WritableOpfsFile = {
          async write(data) {
            if (options.failWriteAfter !== undefined && writes >= options.failWriteAfter)
              throw new DOMException('storage quota exceeded', 'QuotaExceededError');
            writes += 1;
            if (options.truncateWrites) {
              pending = data.slice(0, Math.max(0, data.size - 1));
              return;
            }
            if (options.corruptWrites) {
              const bytes = new Uint8Array(await data.arrayBuffer());
              if (bytes.length > 0) bytes[0] = bytes[0]! ^ 0xff;
              pending = new Blob([bytes.buffer as ArrayBuffer]);
              return;
            }
            pending = data;
          },
          async close() {
            if (pending !== undefined) files.set(name, { blob: pending, modified: clock++ });
          },
        };
        return writable;
      },
    };
  }

  return { root };
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
