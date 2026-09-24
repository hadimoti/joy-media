import {
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserAssetRegistration,
  type BrowserMediaDescriptor,
} from './control-plane-client.js';
import {
  openOpfsOriginalAssetCache,
  type OpfsOriginalAssetCache,
} from './opfs-original-asset-cache.js';
import { inspectImageAnimation, validateImageAnimationBudget } from './animated-image-metadata.js';
import { revokeDetachedObjectUrl } from './media-object-url.js';

export interface MediaImportProgress {
  readonly ratio: number;
  readonly message: string;
}

export interface MediaImportOptions {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly file: File;
  /** Optional human-readable catalog name when the upload file is synthetic. */
  readonly displayName?: string;
  readonly assetId?: string;
  readonly client?: Pick<
    BrowserControlPlaneClient,
    'ensureProject' | 'registerAsset' | 'assets' | 'uploadAssetOriginal'
  >;
  readonly originalAssetCache?:
    Pick<OpfsOriginalAssetCache, 'put'> | Promise<Pick<OpfsOriginalAssetCache, 'put'>>;
  readonly onProgress?: (progress: MediaImportProgress) => void;
  readonly describeMedia?: (
    file: File,
    kind: BrowserAsset['kind'],
    mimeType: string,
  ) => Promise<BrowserMediaDescriptor>;
  readonly createAssetId?: () => string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  avif: 'image/avif',
  bmp: 'image/bmp',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  png: 'image/png',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

const generatedAssetIdsByFile = new WeakMap<File, Map<string, string>>();

/**
 * Registers an original only after local integrity verification, then uploads
 * the exact bytes to private object storage. A retry resumes an interrupted
 * upload when the existing registration still matches the selected file.
 */
export async function importMediaFile(options: MediaImportOptions): Promise<BrowserAsset> {
  const client = options.client ?? new BrowserControlPlaneClient();
  const cache = await (options.originalAssetCache ?? openOpfsOriginalAssetCache());
  const { file } = options;
  if (file.size < 1) throw new Error('selected media file is empty');
  if (file.name.length < 1 || file.name.length > 255 || /[\\/]/.test(file.name)) {
    throw new Error('selected media file name is invalid');
  }

  const declaredMimeType = normalizedMimeType(file);
  const displayName = options.displayName ?? file.name;
  if (displayName.length < 1 || displayName.length > 255 || /[\\/]/.test(displayName)) {
    throw new Error('asset display name is invalid');
  }
  report(options, 0.02, `Reading ${file.name}...`);
  const buffer = await readFileWithProgress(file, (ratio) => {
    report(options, 0.02 + 0.38 * ratio, `Reading ${file.name}...`);
  });
  report(options, 0.42, `Hashing ${file.name}...`);
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
  const mimeType = sniffMediaMimeType(new Uint8Array(buffer), declaredMimeType);
  const kind = assetKind(mimeType);
  const explicitAssetId = options.assetId?.trim() || undefined;
  let idsByProject = generatedAssetIdsByFile.get(file);
  let generatedAssetId =
    explicitAssetId === undefined ? idsByProject?.get(options.projectId) : undefined;
  if (explicitAssetId === undefined && generatedAssetId === undefined) {
    generatedAssetId = (options.createAssetId ?? createImportedAssetId)();
    idsByProject ??= new Map<string, string>();
    idsByProject.set(options.projectId, generatedAssetId);
    generatedAssetIdsByFile.set(file, idsByProject);
  }
  const id = explicitAssetId || generatedAssetId!;
  validateAssetId(id);

  const descriptor = await (options.describeMedia ?? describeMedia)(file, kind, mimeType);
  const registration: BrowserAssetRegistration = {
    id,
    kind,
    displayName,
    sha256,
    bytes: file.size,
    descriptor: { ...descriptor, mimeType },
    locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
  };

  report(options, 0.55, `Saving ${file.name} locally...`);
  await cache.put(
    {
      assetId: registration.id,
      sha256: registration.sha256,
      bytes: registration.bytes,
      mimeType: registration.descriptor.mimeType,
    },
    file,
  );

  report(options, 0.82, `Registering ${file.name}...`);
  await client.ensureProject(options.projectId, options.projectTitle);
  const registered = await registerOrResume(client, options.projectId, registration);

  report(options, 0.9, `Uploading ${file.name} to private cloud storage...`);
  const uploaded = await client.uploadAssetOriginal(
    options.projectId,
    registered,
    file,
    (ratio) => {
      report(options, 0.9 + 0.1 * ratio, `Uploading ${file.name} to private cloud storage...`);
    },
  );
  report(options, 1, `${file.name} backed up to private cloud storage.`);
  if (explicitAssetId === undefined) {
    idsByProject?.delete(options.projectId);
    if (idsByProject?.size === 0) generatedAssetIdsByFile.delete(file);
  }
  return uploaded;
}

export function createImportedAssetId(): string {
  const randomUuid = globalThis.crypto.randomUUID?.();
  if (randomUuid !== undefined) return `media-${randomUuid}`;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `media-${hex(bytes)}`;
}

export function normalizedMimeType(file: Pick<File, 'name' | 'type'>): string {
  const declared = file.type.trim().toLowerCase();
  if (/^(video|audio|image)\/[a-z0-9.+-]+$/.test(declared)) return declared;
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const inferred = extension === undefined ? undefined : MIME_BY_EXTENSION[extension];
  if (inferred !== undefined) return inferred;
  throw new Error('selected file must be a supported video, audio, or image');
}

export function sniffMediaMimeType(bytes: Uint8Array, declaredMimeType: string): string {
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === '\x89PNG') return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return declaredMimeType;
}

async function registerOrResume(
  client: Pick<BrowserControlPlaneClient, 'registerAsset' | 'assets'>,
  projectId: string,
  registration: BrowserAssetRegistration,
): Promise<BrowserAsset> {
  try {
    return await client.registerAsset(projectId, registration);
  } catch (error) {
    if (!message(error).includes('ASSET_EXISTS')) throw error;
    const existing = (await client.assets(projectId)).find((asset) => asset.id === registration.id);
    if (
      existing === undefined ||
      existing.sha256 !== registration.sha256 ||
      existing.bytes !== registration.bytes ||
      existing.kind !== registration.kind ||
      existing.descriptor.mimeType !== registration.descriptor.mimeType
    ) {
      throw new Error(`asset ID "${registration.id}" already belongs to different media`);
    }
    return existing;
  }
}

export async function describeMedia(
  file: File,
  kind: BrowserAsset['kind'],
  mimeType: string,
): Promise<BrowserMediaDescriptor> {
  if (kind === 'image') return describeImage(file, mimeType);
  return describeTimedMedia(file, kind);
}

async function describeImage(file: File, mimeType: string): Promise<BrowserMediaDescriptor> {
  if (typeof createImageBitmap !== 'function') return { mimeType };
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const animation = inspectImageAnimation(await file.arrayBuffer());
      if (animation !== undefined) {
        validateImageAnimationBudget(animation, bitmap.width, bitmap.height);
      }
      return {
        mimeType,
        width: bitmap.width,
        height: bitmap.height,
        ...(animation === undefined ? {} : { animation, durationUs: animation.cycleDurationUs }),
      };
    } finally {
      bitmap.close();
    }
  } catch {
    throw new Error(`unable to decode ${file.name} as ${mimeType}`);
  }
}

async function describeTimedMedia(
  file: File,
  kind: 'audio' | 'video',
): Promise<BrowserMediaDescriptor> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { mimeType: normalizedMimeType(file) };
  }
  const element = document.createElement(kind);
  const url = URL.createObjectURL(file);
  element.preload = 'metadata';
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('metadata read timed out')), 10_000);
      element.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      element.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('metadata is unavailable'));
      };
    });
    element.src = url;
    await loaded;
    const durationUs = Math.round(element.duration * 1_000_000);
    const duration =
      Number.isSafeInteger(durationUs) && durationUs > 0 ? { durationUs } : undefined;
    if (duration === undefined) throw new Error('metadata duration is unavailable');
    if (kind === 'video') {
      const video = element as HTMLVideoElement;
      return {
        mimeType: normalizedMimeType(file),
        ...duration,
        ...(video.videoWidth > 0 ? { width: video.videoWidth } : {}),
        ...(video.videoHeight > 0 ? { height: video.videoHeight } : {}),
      };
    }
    return { mimeType: normalizedMimeType(file), ...duration };
  } catch (error) {
    throw new Error(
      `unable to read ${file.name} metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    element.onloadedmetadata = null;
    element.onerror = null;
    // Detach and unload the media consumer before revoking. Revoking while
    // the element still has this URL in `src` can race its pending fetch and
    // surface `net::ERR_FILE_NOT_FOUND (blob:...)` during reimport.
    element.removeAttribute('src');
    element.load();
    revokeDetachedObjectUrl(url);
  }
}

function assetKind(mimeType: string): BrowserAsset['kind'] {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function validateAssetId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(
      'asset ID may only contain Latin letters, digits, dots, underscores, or hyphens',
    );
  }
}

function report(options: MediaImportOptions, ratio: number, progressMessage: string): void {
  options.onProgress?.({ ratio: Math.min(1, Math.max(0, ratio)), message: progressMessage });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

async function readFileWithProgress(
  file: File,
  onProgress: (ratio: number) => void,
): Promise<ArrayBuffer> {
  if (typeof file.stream !== 'function' || file.size <= 0) {
    onProgress(1);
    return file.arrayBuffer();
  }
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(1, received / file.size));
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(1);
  return merged.buffer;
}
