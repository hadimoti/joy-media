import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import type { OpfsDirectoryHandle, WritableOpfsFile } from './opfs-asset-cache.js';

function makeCacheRoot() {
  const files = new Map<string, Blob>();
  let currentName = '';
  const writable: WritableOpfsFile = {
    write: vi.fn(async (blob: Blob) => {
      files.set(currentName, blob);
    }),
    close: vi.fn(async () => undefined),
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
    removeEntry: async (name: string) => {
      files.delete(name);
    },
  };

  return { root: directory, files, writable };
}

function descriptor(bytes: Uint8Array, assetId = 'asset-1') {
  return {
    assetId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    mimeType: 'video/mp4',
  };
}

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
});
