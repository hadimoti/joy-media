import type { ObjectUrlApi, OpfsDirectoryHandle } from './opfs-asset-cache.js';

export interface OriginalAssetDescriptor {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface OpfsOriginalAssetCacheOptions {
  readonly root?: OpfsDirectoryHandle;
  readonly digest?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly objectUrls?: ObjectUrlApi;
}

export type OriginalAssetCacheResult =
  | { readonly state: 'available-local'; readonly url: string; readonly revoke: () => void }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'unsupported' };

/** Stores a selected original in the current browser profile without exposing a path. */
export class OpfsOriginalAssetCache {
  private readonly root: OpfsDirectoryHandle | undefined;
  private readonly digest: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  private readonly objectUrls: ObjectUrlApi;

  constructor(options: OpfsOriginalAssetCacheOptions = {}) {
    this.root = options.root;
    this.digest = options.digest ?? defaultDigest;
    this.objectUrls = options.objectUrls ?? URL;
  }

  async put(descriptor: OriginalAssetDescriptor, file: Blob): Promise<void> {
    validateDescriptor(descriptor);
    validateContent(descriptor, file);
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    const hash = hex(new Uint8Array(await this.digest(await file.arrayBuffer())));
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

  async resolve(descriptor: OriginalAssetDescriptor): Promise<OriginalAssetCacheResult> {
    validateDescriptor(descriptor);
    if (this.root === undefined) return { state: 'unsupported' };
    try {
      const directory = await this.root.getDirectoryHandle('joy-media-assets', { create: false });
      const handle = await directory.getFileHandle(`${descriptor.assetId}.bin`, { create: false });
      const file = await handle.getFile();
      const localBlob = new Blob([file], { type: descriptor.mimeType });
      try {
        await verify(descriptor, localBlob, this.digest);
      } catch {
        await directory.removeEntry(`${descriptor.assetId}.bin`).catch(() => undefined);
        return { state: 'invalid' };
      }
      const url = this.objectUrls.createObjectURL(localBlob);
      let revoked = false;
      return {
        state: 'available-local',
        url,
        revoke: () => {
          if (!revoked) this.objectUrls.revokeObjectURL(url);
          revoked = true;
        },
      };
    } catch {
      return { state: 'missing' };
    }
  }
}

export async function openOpfsOriginalAssetCache(): Promise<OpfsOriginalAssetCache> {
  const getDirectory = (
    globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined
  )?.getDirectory;
  return new OpfsOriginalAssetCache({
    ...(getDirectory === undefined ? {} : { root: await getDirectory.call(navigator.storage) }),
  });
}

function validateDescriptor(descriptor: OriginalAssetDescriptor): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.assetId))
    throw new Error('asset ID must be opaque');
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes))
    throw new Error('selected asset integrity metadata is invalid');
  if (descriptor.bytes < 0) throw new Error('selected asset integrity metadata is invalid');
  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/i.test(descriptor.mimeType))
    throw new Error('selected asset type is unsupported');
}

function validateContent(descriptor: OriginalAssetDescriptor, file: Blob): void {
  if (descriptor.bytes !== file.size)
    throw new Error('selected asset integrity metadata is invalid');
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verify(
  descriptor: OriginalAssetDescriptor,
  file: Blob,
  digest: (data: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<void> {
  if (file.type !== descriptor.mimeType) throw new Error('selected asset type changed');
  if (file.size !== descriptor.bytes) throw new Error('selected asset size changed');
  const hash = hex(new Uint8Array(await digest(await file.arrayBuffer())));
  if (hash !== descriptor.sha256) throw new Error('selected asset changed while registering');
}

async function defaultDigest(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined)
    throw new Error('Web Crypto SHA-256 is unavailable');
  return crypto.subtle.digest('SHA-256', data);
}
