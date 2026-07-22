import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';

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
