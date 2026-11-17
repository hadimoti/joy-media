import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openOpfsOriginalAssetCache, OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import type { OpfsDirectoryHandle, WritableOpfsFile } from './opfs-asset-cache.js';

function makeCacheRoot() {
  const files = new Map<string, Blob>();
  let currentName = '';
  const writable: WritableOpfsFile = {
    write: vi.fn(async (blob: Blob) => {
      files.set(currentName, blob);
    }),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const fileHandle = {
    createWritable: async () => writable,
    getFile: async () => {
      const blob = files.get(currentName);
      if (blob === undefined) throw new Error('cache entry is missing');
      return new File([blob], currentName);
    },
  };
  const directory: OpfsDirectoryHandle = {
    getDirectoryHandle: async () => directory,
    getFileHandle: async (name: string) => {
      currentName = name;
      return fileHandle;
    },
    removeEntry: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  };

  return { root: directory, files, writable, removeEntry: directory.removeEntry };
}

function descriptor(bytes: Uint8Array, assetId = 'asset-1') {
  return {
    assetId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    mimeType: 'video/mp4',
  };
}

describe('OPFS original asset cache availability and removal', () => {
  it('says it is unavailable when the browser has no OPFS, and available when it has', () => {
    expect(new OpfsOriginalAssetCache(undefined).isAvailable()).toBe(false);
    expect(new OpfsOriginalAssetCache(makeCacheRoot().root).isAvailable()).toBe(true);
  });

  it('removes one cached original and leaves the others', async () => {
    const { root, files } = makeCacheRoot();
    files.set('replacement-1.bin', new Blob(['one']));
    files.set('asset-1.bin', new Blob(['two']));
    await new OpfsOriginalAssetCache(root).remove('replacement-1');
    expect([...files.keys()]).toEqual(['asset-1.bin']);
  });

  it('ignores a removal of an id that is not an opaque asset id, and one without OPFS', async () => {
    const { root, files } = makeCacheRoot();
    files.set('asset-1.bin', new Blob(['two']));
    await new OpfsOriginalAssetCache(root).remove('../asset-1');
    await new OpfsOriginalAssetCache(undefined).remove('asset-1');
    expect([...files.keys()]).toEqual(['asset-1.bin']);
  });

  it('surfaces storage errors during removal so the caller can retry', async () => {
    const { root, removeEntry } = makeCacheRoot();
    const storageError = new Error('disk is unavailable');
    vi.mocked(removeEntry).mockRejectedValueOnce(storageError);

    await expect(new OpfsOriginalAssetCache(root).remove('replacement-1')).rejects.toBe(
      storageError,
    );
  });

  it('starts with an unavailable cache when OPFS rejects access', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi
          .fn()
          .mockRejectedValue(new DOMException('Storage is blocked', 'SecurityError')),
      },
    });
    try {
      const cache = await openOpfsOriginalAssetCache();
      expect(cache.isAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('OPFS original asset cache', () => {
  it('skips a same-size desktop import Blob when its SHA-256 differs', async () => {
    const { root, files, writable } = makeCacheRoot();
    const expected = new Uint8Array([1, 2, 3, 4]);
    const rendererBytes = new Uint8Array([4, 3, 2, 1]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await new OpfsOriginalAssetCache(root).putFromVerifiedDesktopImport(
        descriptor(expected),
        new Blob([rendererBytes], { type: 'video/mp4' }),
      );

      expect(files.size).toBe(0);
      expect(writable.write).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('caches a desktop import Blob when its SHA-256 matches', async () => {
    const { root, files, writable } = makeCacheRoot();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new Blob([bytes], { type: 'video/mp4' });

    await new OpfsOriginalAssetCache(root).putFromVerifiedDesktopImport(descriptor(bytes), file);

    expect(writable.write).toHaveBeenCalledWith(file);
    expect(files.get('asset-1.bin')).toBe(file);
  });

  it('does not read a whole file buffer while hashing and writing an original', async () => {
    const { root, files } = makeCacheRoot();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new Blob([bytes], { type: 'video/mp4' });
    const wholeFileRead = vi
      .spyOn(file, 'arrayBuffer')
      .mockRejectedValue(new Error('whole-file read'));

    try {
      await new OpfsOriginalAssetCache(root).put(descriptor(bytes), file);
      expect(wholeFileRead).not.toHaveBeenCalled();
      expect(await files.get('asset-1.bin')?.text()).toBe('\u0001\u0002\u0003\u0004');
    } finally {
      wholeFileRead.mockRestore();
    }
  });

  it('aborts and removes a partially written original when a write fails', async () => {
    const { root, files, writable, removeEntry } = makeCacheRoot();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new Blob([bytes], { type: 'video/mp4' });
    const writeError = new Error('quota exceeded');
    files.set('asset-1.bin', new Blob(['partial']));
    vi.mocked(writable.write).mockRejectedValueOnce(writeError);

    await expect(new OpfsOriginalAssetCache(root).put(descriptor(bytes), file)).rejects.toBe(
      writeError,
    );

    expect(writable.abort).toHaveBeenCalledOnce();
    expect(writable.close).not.toHaveBeenCalled();
    expect(removeEntry).toHaveBeenCalledWith('asset-1.bin');
    expect(files.has('asset-1.bin')).toBe(false);
  });

  it('preserves the original write error if removing its partial entry fails', async () => {
    const { root, writable, removeEntry } = makeCacheRoot();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const writeError = new Error('quota exceeded');
    const cleanupError = new Error('cleanup failed');
    vi.mocked(writable.write).mockRejectedValueOnce(writeError);
    vi.mocked(removeEntry).mockRejectedValueOnce(cleanupError);

    await expect(
      new OpfsOriginalAssetCache(root).put(
        descriptor(bytes),
        new Blob([bytes], { type: 'video/mp4' }),
      ),
    ).rejects.toBe(writeError);
  });
});
