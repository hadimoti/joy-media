import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';
import { sha256OfBlob } from './blob-sha256.js';

export interface OriginalAssetDescriptor {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

/** Stores a selected original in the current browser profile without exposing a path. */
export class OpfsOriginalAssetCache {
  constructor(private readonly root: OpfsDirectoryHandle | undefined) {}

  async put(descriptor: OriginalAssetDescriptor, file: Blob): Promise<void> {
    validate(descriptor, file);
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    const hash = hex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    );
    if (hash !== descriptor.sha256) throw new Error('selected asset changed while registering');
    const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: true });
    const writable = await (
      await directory.getFileHandle(`${descriptor.assetId}.bin`, { create: true })
    ).createWritable();
    try {
      await writable.write(file);
    } finally {
      await writable.close();
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
  const getDirectory = (
    globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined
  )?.getDirectory;
  return new OpfsOriginalAssetCache(
    getDirectory === undefined ? undefined : await getDirectory.call(navigator.storage),
  );
}

function validate(descriptor: OriginalAssetDescriptor, file: Blob): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.assetId))
    throw new Error('asset ID must be opaque');
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || descriptor.bytes !== file.size)
    throw new Error('selected asset integrity metadata is invalid');
  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType))
    throw new Error('selected asset type is unsupported');
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return hex(new Uint8Array(digest));
}
