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

  /** Keep browser storage bounded while retaining the newest completed exports. */
  async prune(maxBytes = 250 * 1024 * 1024, keepIds: readonly string[] = []): Promise<void> {
    const directory = await this.directory(false);
    if (directory?.entries === undefined) return;
    const keep = new Set(keepIds.map(fileName));
    const files: { name: string; size: number; modified: number }[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (!name.endsWith('.mp4') || keep.has(name)) continue;
      const file = await handle.getFile().catch(() => undefined);
      if (file !== undefined) files.push({ name, size: file.size, modified: file.lastModified });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((left, right) => left.modified - right.modified);
    for (const file of files) {
      if (total <= maxBytes) break;
      await directory.removeEntry(file.name).catch(() => undefined);
      total -= file.size;
    }
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

  private async directory(create: boolean): Promise<OpfsDirectoryHandle | undefined> {
    if (this.root === undefined) return undefined;
    try {
      return await this.root.getDirectoryHandle('joy-media-exports', { create });
    } catch {
      return undefined;
    }
  }
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
