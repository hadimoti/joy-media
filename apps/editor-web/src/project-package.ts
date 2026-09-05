import type { ArtifactStore } from '@joy-media/commands';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type {
  AssetRecordV1,
  JoyProjectV1,
  SpikeProject,
  WorkflowGraphV2,
} from '@joy-media/project-schema';
import { EditorSession } from './editor-session.js';
import {
  getCatalogProject,
  upsertCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import {
  purgeLocalProject,
  readProjectBundle,
  type ProjectDocumentBundle,
} from './project-lifecycle.js';

/** Versioned, self-describing editable project interchange format. */
export const PROJECT_PACKAGE_FORMAT = 'joy-media-project' as const;
export const PROJECT_PACKAGE_SCHEMA_VERSION = 1 as const;

export interface PortableMediaEntry {
  readonly asset: AssetRecordV1;
  readonly status: 'embedded' | 'missing';
  readonly dataBase64?: string;
  readonly missingReason?: 'unavailable' | 'size-limit' | 'integrity-mismatch';
}

export interface PortableProjectPackageV1 {
  readonly format: typeof PROJECT_PACKAGE_FORMAT;
  readonly schemaVersion: typeof PROJECT_PACKAGE_SCHEMA_VERSION;
  readonly app: 'JOY Studio';
  readonly exportedAt: string;
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly documents: ProjectDocumentBundle;
  readonly media: readonly PortableMediaEntry[];
}

export interface CreateProjectPackageOptions {
  readonly assetBlobLoader?: (assetId: string) => Promise<Blob | undefined>;
  /** Protects the browser from accidentally serializing an enormous project. */
  readonly maxEmbeddedBytes?: number;
  readonly now?: () => string;
}

export interface ImportedProjectAsset {
  readonly assetId: string;
  readonly blob: Blob;
  readonly record: AssetRecordV1;
}

export interface ImportProjectPackageOptions {
  readonly collision?: 'rename' | 'replace' | 'reject';
  readonly title?: string;
  readonly now?: () => string;
  readonly createId?: () => string;
  /** Persists verified originals into the application's private asset cache. */
  readonly assetWriter?: (asset: ImportedProjectAsset) => Promise<void>;
}

export interface ImportProjectPackageResult {
  readonly entry: ProjectCatalogEntry;
  readonly missingAssetIds: readonly string[];
  readonly assetIdMap: Readonly<Record<string, string>>;
  readonly replacedProjectId?: string;
}

const DEFAULT_MAX_EMBEDDED_BYTES = 128 * 1024 * 1024;

export async function createProjectPackage(
  entry: ProjectCatalogEntry,
  storage: BrowserKeyValueStore,
  options: CreateProjectPackageOptions = {},
): Promise<PortableProjectPackageV1> {
  const documents = readProjectBundle(storage, entry);
  const maxEmbeddedBytes = options.maxEmbeddedBytes ?? DEFAULT_MAX_EMBEDDED_BYTES;
  let embeddedBytes = 0;
  const media: PortableMediaEntry[] = [];
  for (const asset of Object.values(documents.visual.assets)) {
    let status: PortableMediaEntry['status'] = 'missing';
    let dataBase64: string | undefined;
    let missingReason: PortableMediaEntry['missingReason'] = 'unavailable';
    const blob = await options.assetBlobLoader?.(asset.id);
    if (blob !== undefined && blob.size > 0) {
      if (embeddedBytes + blob.size > maxEmbeddedBytes) {
        missingReason = 'size-limit';
      } else if (asset.sha256 !== undefined && (await sha256Hex(blob)) !== asset.sha256) {
        missingReason = 'integrity-mismatch';
      } else {
        dataBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
        embeddedBytes += blob.size;
        status = 'embedded';
        missingReason = undefined;
      }
    }
    const exportedAsset =
      status === 'embedded' && blob !== undefined
        ? {
            ...asset,
            bytes: asset.bytes ?? blob.size,
            sha256: asset.sha256 ?? (await sha256Hex(blob)),
            descriptor: asset.descriptor ?? { mimeType: blob.type || 'application/octet-stream' },
          }
        : asset;
    media.push({
      asset: exportedAsset,
      status,
      ...(dataBase64 === undefined ? {} : { dataBase64 }),
      ...(missingReason === undefined ? {} : { missingReason }),
    });
  }
  return {
    format: PROJECT_PACKAGE_FORMAT,
    schemaVersion: PROJECT_PACKAGE_SCHEMA_VERSION,
    app: 'JOY Studio',
    exportedAt: (options.now ?? (() => new Date().toISOString()))(),
    source: {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    documents,
    media,
  };
}

export function serializeProjectPackage(pkg: PortableProjectPackageV1): string {
  return JSON.stringify(pkg);
}

export function parseProjectPackage(value: unknown): PortableProjectPackageV1 {
  if (!isRecord(value)) throw new Error('This file is not a JOY project package.');
  if (value.format !== PROJECT_PACKAGE_FORMAT || value.schemaVersion !== 1)
    throw new Error('Unsupported JOY project package version.');
  if (value.app !== 'JOY Studio' || !isRecord(value.source) || !isRecord(value.documents))
    throw new Error('JOY project package metadata is invalid.');
  if (!isRecord(value.source) || typeof value.source.id !== 'string')
    throw new Error('JOY project package has no source project identity.');
  if (!isRecord(value.documents.timeline) || !isRecord(value.documents.visual))
    throw new Error('JOY project package is missing editable documents.');
  if (!Array.isArray(value.media)) throw new Error('JOY project package has no media manifest.');
  for (const media of value.media) {
    if (!isRecord(media) || !isRecord(media.asset) || typeof media.asset.id !== 'string')
      throw new Error('JOY project package contains an invalid media manifest entry.');
    if (media.status !== 'embedded' && media.status !== 'missing')
      throw new Error('JOY project package contains an invalid media status.');
    if (media.status === 'embedded' && typeof media.dataBase64 !== 'string')
      throw new Error('JOY project package contains an embedded asset without bytes.');
  }
  return value as unknown as PortableProjectPackageV1;
}

export async function importProjectPackage(
  storage: BrowserKeyValueStore,
  pkg: PortableProjectPackageV1,
  options: ImportProjectPackageOptions = {},
): Promise<ImportProjectPackageResult> {
  const now = (options.now ?? (() => new Date().toISOString()))();
  // Validate the replacement title before any destructive collision handling.
  // A malformed package must never remove the existing project it is meant to
  // replace.
  const title = requireTitle(options.title ?? pkg.source.title);
  const oldId = pkg.source.id;
  const requestedId = oldId.trim() || createProjectId('project');
  const existing = getCatalogProject(storage, requestedId);
  let replacedProjectId: string | undefined;
  let id = requestedId;
  if (existing !== undefined) {
    const collision = options.collision ?? 'rename';
    if (collision === 'reject') throw new Error(`A project named “${requestedId}” already exists.`);
    if (collision === 'replace') {
      // Keep replacement explicit; callers choose this only from the import UI.
      replacedProjectId = existing.id;
      id = requestedId;
    } else id = options.createId?.() ?? createProjectId('import');
  } else if (options.collision === 'replace') {
    // Replace has no effect when the source id is not present.
    id = requestedId;
  }

  const assetIdMap: Record<string, string> = {};
  for (const media of pkg.media) assetIdMap[media.asset.id] = createProjectId('asset');
  const missingAssetIds: string[] = [];
  const verifiedAssets: ImportedProjectAsset[] = [];
  for (const media of pkg.media) {
    const mappedId = assetIdMap[media.asset.id]!;
    if (
      media.status !== 'embedded' ||
      media.dataBase64 === undefined ||
      options.assetWriter === undefined
    ) {
      missingAssetIds.push(mappedId);
      continue;
    }
    const bytes = base64ToBytes(media.dataBase64);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const blob = new Blob([copy], {
      type: media.asset.descriptor?.mimeType ?? 'application/octet-stream',
    });
    if (media.asset.bytes !== undefined && media.asset.bytes !== blob.size)
      throw new Error(`Embedded asset “${media.asset.displayName}” has an invalid byte length.`);
    if (media.asset.sha256 !== undefined && (await sha256Hex(blob)) !== media.asset.sha256)
      throw new Error(`Embedded asset “${media.asset.displayName}” failed integrity validation.`);
    verifiedAssets.push({
      assetId: mappedId,
      blob,
      record: { ...media.asset, id: mappedId },
    });
  }
  const replacements = {
    [oldId]: id,
    ...(pkg.documents.timeline.id === oldId ? {} : { [pkg.documents.timeline.id]: id }),
    ...(pkg.documents.visual.id === oldId ? {} : { [pkg.documents.visual.id]: id }),
    ...assetIdMap,
  };
  const timeline = {
    ...remapJson(pkg.documents.timeline, replacements),
    id,
  } as SpikeProject;
  const visual = {
    ...remapJson(pkg.documents.visual, replacements),
    id,
    title,
    createdAt: now,
    updatedAt: now,
  } as JoyProjectV1;
  const graph =
    pkg.documents.graph === undefined
      ? undefined
      : (remapJson(pkg.documents.graph, replacements) as WorkflowGraphV2);
  const artifacts =
    pkg.documents.artifacts === undefined
      ? undefined
      : (remapJson(pkg.documents.artifacts, replacements) as ArtifactStore);
  const entry: ProjectCatalogEntry = {
    id,
    title: visual.title,
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  // Persist verified originals before committing the imported documents. If a
  // private-cache write fails, the catalog and project logs remain untouched
  // rather than exposing a half-imported project to the user.
  for (const asset of verifiedAssets) await options.assetWriter!(asset);
  if (replacedProjectId !== undefined && existing !== undefined)
    purgeLocalProject(storage, existing);
  new EditorSession(
    storage,
    timeline,
    visual,
    graph === undefined && artifacts === undefined
      ? {}
      : {
          ...(graph === undefined ? {} : { graph }),
          ...(artifacts === undefined ? {} : { artifacts }),
        },
  );
  upsertCatalogProject(storage, entry);
  return {
    entry,
    missingAssetIds,
    assetIdMap,
    ...(replacedProjectId === undefined ? {} : { replacedProjectId }),
  };
}

function requireTitle(title: string): string {
  const clean = title.trim();
  if (clean.length === 0) throw new Error('Project name cannot be empty.');
  return clean;
}

function createProjectId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function remapJson<T>(value: T, replacements: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') return (replacements[value] ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => remapJson(item, replacements)) as T;
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[replacements[key] ?? key] = remapJson(item, replacements);
    }
    return result as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('JOY project package contains invalid embedded media bytes.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
