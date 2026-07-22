export interface PlayableDerivativeDescriptor {
  /** Opaque control-plane derivative ID, never a filename or path. */
  readonly derivativeId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface WritableOpfsFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableOpfsFile>;
}

export interface OpfsDirectoryHandle {
  getDirectoryHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export interface ObjectUrlApi {
  createObjectURL(value: Blob): string;
  revokeObjectURL(url: string): void;
}

export type DerivativeCacheResult =
  | { readonly state: 'available-local'; readonly url: string; readonly revoke: () => void }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'unsupported' };

export interface LocalDerivativeCache {
  put(descriptor: PlayableDerivativeDescriptor, data: Blob): Promise<void>;
  resolve(descriptor: PlayableDerivativeDescriptor): Promise<DerivativeCacheResult>;
  remove(derivativeId: string): Promise<void>;
}

export interface OpfsDerivativeCacheOptions {
  readonly root?: OpfsDirectoryHandle;
  readonly digest?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly objectUrls?: ObjectUrlApi;
}

/**
 * Browser-profile-local cache for verified playable derivative bytes.  It only
 * creates a blob URL after checking the byte length and SHA-256 supplied by the
 * owner-scoped catalog; callers never supply paths or remote URLs.
 */
export class OpfsDerivativeCache implements LocalDerivativeCache {
  private readonly root: OpfsDirectoryHandle | undefined;
  private readonly digest: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  private readonly objectUrls: ObjectUrlApi;

  constructor(options: OpfsDerivativeCacheOptions = {}) {
    this.root = options.root;
    this.digest = options.digest ?? defaultDigest;
    this.objectUrls = options.objectUrls ?? URL;
  }

  async put(descriptor: PlayableDerivativeDescriptor, data: Blob): Promise<void> {
    validateDescriptor(descriptor);
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    await verifyBlob(descriptor, data, this.digest);
    const directory = await cacheDirectory(this.root);
    const writable = await (
      await directory.getFileHandle(cacheFileName(descriptor.derivativeId), { create: true })
    ).createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async resolve(descriptor: PlayableDerivativeDescriptor): Promise<DerivativeCacheResult> {
    validateDescriptor(descriptor);
    if (this.root === undefined) return { state: 'unsupported' };
    const directory = await cacheDirectory(this.root);
    const name = cacheFileName(descriptor.derivativeId);
    let file: File;
    try {
      file = await (await directory.getFileHandle(name)).getFile();
    } catch (error) {
      if (isNotFound(error)) return { state: 'missing' };
      throw error;
    }
    // OPFS preserves the bytes but not the Blob MIME type: getFile() for our
    // intentionally-neutral `.bin` cache entry has an empty type in Chromium.
    // Rehydrate the catalog MIME only after the cached bytes pass their
    // length/hash checks, so a valid local derivative remains playable.
    const localBlob = new Blob([file], { type: descriptor.mimeType });
    try {
      await verifyBlob(descriptor, localBlob, this.digest);
    } catch {
      await directory.removeEntry(name).catch(() => undefined);
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
  }

  async remove(derivativeId: string): Promise<void> {
    if (!isOpaqueId(derivativeId)) throw new TypeError('derivative id must be opaque');
    if (this.root === undefined) return;
    await (
      await cacheDirectory(this.root)
    )
      .removeEntry(cacheFileName(derivativeId))
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }
}

/** Opens the current browser profile's OPFS cache without exposing its handle. */
export async function openOpfsDerivativeCache(
  options: Omit<OpfsDerivativeCacheOptions, 'root'> = {},
): Promise<OpfsDerivativeCache> {
  const getDirectory = (
    globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined
  )?.getDirectory;
  return new OpfsDerivativeCache({
    ...options,
    ...(getDirectory === undefined ? {} : { root: await getDirectory.call(navigator.storage) }),
  });
}

async function cacheDirectory(root: OpfsDirectoryHandle): Promise<OpfsDirectoryHandle> {
  return root.getDirectoryHandle('joy-media-derivatives', { create: true });
}

function cacheFileName(derivativeId: string): string {
  return `${derivativeId}.bin`;
}

function validateDescriptor(descriptor: PlayableDerivativeDescriptor): void {
  if (!isOpaqueId(descriptor.derivativeId)) throw new TypeError('derivative id must be opaque');
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256))
    throw new TypeError('derivative sha256 is invalid');
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0)
    throw new TypeError('derivative byte length is invalid');
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(descriptor.mimeType))
    throw new TypeError('derivative mime type is invalid');
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

async function verifyBlob(
  descriptor: PlayableDerivativeDescriptor,
  data: Blob,
  digest: (data: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<void> {
  if (data.type !== descriptor.mimeType) throw new Error('derivative mime type mismatch');
  if (data.size !== descriptor.byteLength) throw new Error('derivative byte length mismatch');
  const hash = toHex(new Uint8Array(await digest(await data.arrayBuffer())));
  if (hash !== descriptor.sha256) throw new Error('derivative integrity mismatch');
}

async function defaultDigest(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined)
    throw new Error('Web Crypto SHA-256 is unavailable');
  return crypto.subtle.digest('SHA-256', data);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
