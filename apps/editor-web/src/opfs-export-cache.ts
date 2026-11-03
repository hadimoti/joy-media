import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';

/** Small project-independent cache for completed browser export bytes. */
export class OpfsExportCache {
  constructor(private readonly root: OpfsDirectoryHandle | undefined) {}

  async put(entryId: string, data: Blob): Promise<void> {
    const directory = await this.directory(true);
    if (directory === undefined) throw new Error('OPFS is unavailable in this browser');
    const writable = await (
      await directory.getFileHandle(fileName(entryId), { create: true })
    ).createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  /**
   * Commits bytes, reopens the durable file, and returns that exact readback.
   * The readback is compared with the source in slices, so neither copy is ever held in memory
   * whole. Callers can use the returned Blob for both the first download and every later
   * re-download, making the persisted bytes the single source of truth.
   */
  async putVerified(entryId: string, data: Blob): Promise<Blob> {
    await this.put(entryId, data);
    const stored = await this.get(entryId);
    const matches = stored !== undefined && (await sameBytes(stored, data));
    if (!matches) {
      await this.remove(entryId);
      throw new Error('OPFS export cache verification failed');
    }
    return stored!;
  }

  /** Keep browser storage bounded while retaining the newest completed exports. */
  async prune(
    maxBytes = 250 * 1024 * 1024,
    keepIds: readonly string[] = [],
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('maxBytes must be a non-negative safe integer');
    const directory = await this.directory(false);
    if (directory?.entries === undefined) return [];
    const keep = new Set(keepIds.map(fileName));
    const files: { name: string; size: number; modified: number; keep: boolean }[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (!name.endsWith('.mp4')) continue;
      const file = await handle.getFile().catch(() => undefined);
      if (file !== undefined)
        files.push({ name, size: file.size, modified: file.lastModified, keep: keep.has(name) });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const removed: string[] = [];
    const removable = files.filter((file) => !file.keep);
    removable.sort((left, right) => left.modified - right.modified);
    for (const file of removable) {
      if (total <= maxBytes) break;
      try {
        await directory.removeEntry(file.name);
      } catch {
        continue;
      }
      total -= file.size;
      removed.push(entryIdFromFileName(file.name));
    }
    return removed;
  }

  async get(entryId: string): Promise<Blob | undefined> {
    const directory = await this.directory(false);
    if (directory === undefined) return undefined;
    try {
      return await (await directory.getFileHandle(fileName(entryId))).getFile();
    } catch {
      return undefined;
    }
  }

  async remove(entryId: string): Promise<void> {
    const directory = await this.directory(false);
    if (directory === undefined) return;
    await directory.removeEntry(fileName(entryId)).catch(() => undefined);
  }

  async removeVerified(entryId: string): Promise<void> {
    await this.remove(entryId);
    if ((await this.get(entryId)) !== undefined)
      throw new Error('OPFS export cache removal verification failed');
  }

  private async directory(create: boolean): Promise<OpfsDirectoryHandle | undefined> {
    if (this.root === undefined) return undefined;
    try {
      return await this.root.getDirectoryHandle('joy-media-exports', { create });
    } catch {
      return undefined;
    }
  }
}

/** How many bytes of each copy are read at a time while the two copies are compared. */
const COMPARE_SLICE_BYTES = 8 * 1024 * 1024;

/** Whether two Blobs hold the same bytes. Both are read in slices, so no whole file is copied. */
async function sameBytes(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false;
  for (let offset = 0; offset < left.size; offset += COMPARE_SLICE_BYTES) {
    const end = Math.min(left.size, offset + COMPARE_SLICE_BYTES);
    const [leftBytes, rightBytes] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);
    const leftView = new Uint8Array(leftBytes);
    const rightView = new Uint8Array(rightBytes);
    for (let index = 0; index < leftView.length; index++) {
      if (leftView[index] !== rightView[index]) return false;
    }
  }
  return true;
}

export async function openOpfsExportCache(): Promise<OpfsExportCache> {
  const getDirectory = (
    globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined
  )?.getDirectory;
  return new OpfsExportCache(
    getDirectory === undefined ? undefined : await getDirectory.call(navigator.storage),
  );
}

function fileName(entryId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entryId))
    throw new TypeError('export id must be opaque');
  return `${entryId}.mp4`;
}

function entryIdFromFileName(name: string): string {
  return name.slice(0, -'.mp4'.length);
}
