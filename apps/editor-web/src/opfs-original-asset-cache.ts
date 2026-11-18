import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';
import { sha256OfBlob } from './blob-sha256.js';

export interface OriginalAssetDescriptor {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

/** Stores a selected original in the current browser profile without exposing a path. */
export class OpfsOriginalAssetCache {
  constructor(private readonly root: OpfsDirectoryHandle | undefined) {}

  async put(descriptor: OriginalAssetDescriptor, file: Blob): Promise<void> {
    validate(descriptor, file);
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    const hash = await sha256OfBlob(file);
    if (hash !== descriptor.sha256) throw new Error('selected asset changed while registering');
    const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: true });
    const writable = await (
      await directory.getFileHandle(`${descriptor.assetId}.bin`, { create: true })
    ).createWritable();
    try {
      for (let offset = 0; offset < file.size; offset += WRITE_CHUNK_BYTES) {
        await writable.write(file.slice(offset, Math.min(file.size, offset + WRITE_CHUNK_BYTES)));
      }
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      try {
        await this.remove(descriptor.assetId);
      } catch {
        // Preserve the write error; the failed removal can be retried by its caller.
      }
      throw error;
    }
  }

  /**
   * Caches a disk-backed File after the desktop main process has verified its ticket path and
   * SHA-256. The renderer verifies the Blob too because it may not contain the same bytes as the
   * separately streamed main-process file. Hashing is chunked, so the whole file is not copied
   * into a renderer ArrayBuffer.
   */
  async putFromVerifiedDesktopImport(
    descriptor: OriginalAssetDescriptor,
    file: Blob,
  ): Promise<void> {
    validate(descriptor, file);
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    let hash: string;
    try {
      hash = await sha256OfBlob(file);
    } catch {
      console.warn(
        'Skipping the local original cache because the dropped file could not be verified.',
      );
      return;
    }
    if (hash !== descriptor.sha256) {
      console.warn(
        'Skipping the local original cache because the dropped file SHA-256 does not match.',
      );
      return;
    }
    const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: true });
    const writable = await (
      await directory.getFileHandle(`${descriptor.assetId}.bin`, { create: true })
    ).createWritable();
    try {
      await writable.write(file);
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
  }

  /**
   * False when the browser has no OPFS. `get` then returns undefined for every asset, which says
   * nothing about whether a file is missing, so callers that list missing media check this first.
   */
  isAvailable(): boolean {
    return this.root !== undefined;
  }

  /** Removes one cached original. A missing entry is already removed; storage errors surface for retry. */
  async remove(assetId: string): Promise<void> {
    if (this.root === undefined) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return;
    try {
      const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
      await directory.removeEntry(`${assetId}.bin`);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  /** Returns the cached original blob when present in this browser profile. */
  async get(assetId: string): Promise<Blob | undefined> {
    if (this.root === undefined) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return undefined;
    try {
      const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
      const handle = await directory.getFileHandle(`${assetId}.bin`, { create: false });
      return await handle.getFile();
    } catch {
      return undefined;
    }
  }
}

export async function openOpfsOriginalAssetCache(): Promise<OpfsOriginalAssetCache> {
  try {
    const storage = globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined;
    if (storage?.getDirectory === undefined) return new OpfsOriginalAssetCache(undefined);
    return new OpfsOriginalAssetCache(await storage.getDirectory());
  } catch {
    return new OpfsOriginalAssetCache(undefined);
  }
}

function validate(descriptor: OriginalAssetDescriptor, file: Blob): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.assetId))
    throw new Error('asset ID must be opaque');
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || descriptor.bytes !== file.size)
    throw new Error('selected asset integrity metadata is invalid');
  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType))
    throw new Error('selected asset type is unsupported');
}
export async function sha256Hex(blob: Blob): Promise<string> {
  return sha256OfBlob(blob);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { readonly name?: unknown }).name === 'NotFoundError'
  );
}
