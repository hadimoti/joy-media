import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { BrowserProjectStore } from '@joy-media/project-persistence';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import { validateJoyProjectV1, validateSpikeProject } from '@joy-media/project-schema';
import {
  CREATIVE_ARTIFACT_LOG_KEY,
  EditorSession,
  LOOK_INSTANCES_LOG_KEY,
  WORKFLOW_GRAPH_LOG_KEY,
} from './editor-session.js';
import {
  getCatalogProject,
  TIMELINE_LOG_KEY,
  upsertCatalogProject,
  VISUAL_LOG_KEY,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { createBlankProjectDocuments } from './project-factory.js';
import { readProjectBundle, type ProjectDocumentBundle } from './project-lifecycle.js';
import type {
  ProjectFolderLoadReply,
  ProjectFolderMediaBytesReply,
  ProjectFolderMediaStatesReply,
  ProjectFolderSaveReply,
  ProjectFolderSaveRequest,
} from './project-folder-client.js';

/**
 * A folder project in the editor. The folder is the project's home: it holds the saved project and its media. The
 * editor works on a working copy in this browser's storage, under the folder's id, as it does for every project, and
 * saves that copy back into the folder.
 *
 * Opening: the folder's saved project replaces the working copy, unless the working copy has changes the folder has not
 * received yet (the unsaved mark below). Then the working copy is kept, and the next save sends it.
 * Media: each media file the project uses is read from the folder into this browser's media cache when the cache does
 * not have it. A file that neither has is missing, and the owner is told its name.
 * Saving: the working copy and the list of its media go to the folder. The desktop copies each original it keeps into
 * the folder, so the folder holds its own media.
 */

/** The desktop calls a folder project needs. project-folder-client.ts implements them; tests pass fakes. */
export interface FolderProjectPort {
  load(key: string): Promise<ProjectFolderLoadReply>;
  save(key: string, save: ProjectFolderSaveRequest): Promise<ProjectFolderSaveReply>;
  mediaStates(key: string, assetIds: readonly string[]): Promise<ProjectFolderMediaStatesReply>;
  readMedia(key: string, assetId: string, offset: number): Promise<ProjectFolderMediaBytesReply>;
}

/** This browser's media cache (opfs-original-asset-cache.ts). */
export interface FolderMediaCache {
  get(assetId: string): Promise<Blob | undefined>;
  put(
    descriptor: {
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly mimeType: string;
    },
    file: Blob,
  ): Promise<void>;
}

export type FolderProjectOpenResult =
  | {
      readonly kind: 'opened';
      readonly entry: ProjectCatalogEntry;
      /** The folder's saved revision this working copy is based on. The next save names it. */
      readonly revisionId: string;
      /** True when the folder does not hold this working copy yet, so it should be saved now. */
      readonly needsSave: boolean;
      /** The names of the media files that are in neither the folder nor this browser. */
      readonly missingMedia: readonly string[];
    }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' };

export type FolderProjectSaveResult =
  | {
      readonly kind: 'saved';
      readonly revisionId: string;
      /** The names of the media files the folder could not get a copy of. */
      readonly notStored: readonly string[];
    }
  | { readonly kind: 'refused'; readonly code: string };

const UNSAVED_PREFIX = 'joy-media.folder-project-unsaved.v1.';
/** The id of the folder project open in the editor, so a restart does not open it without its folder. */
export const ACTIVE_FOLDER_PROJECT_KEY = 'joy-media.active-folder-project.v1';

/** Marks the working copy of a folder project as changed since its last save into the folder. */
export function markFolderProjectUnsaved(storage: BrowserKeyValueStore, projectId: string): void {
  storage.setItem(`${UNSAVED_PREFIX}${projectId}`, '1');
}

export function clearFolderProjectUnsaved(storage: BrowserKeyValueStore, projectId: string): void {
  storage.removeItem?.(`${UNSAVED_PREFIX}${projectId}`);
}

export function isFolderProjectUnsaved(storage: BrowserKeyValueStore, projectId: string): boolean {
  return storage.getItem(`${UNSAVED_PREFIX}${projectId}`) !== null;
}

/**
 * Loads an open folder into this browser's working copy, and brings its media into the cache. The folder must have been
 * opened (settled as ready) by `openProjectFolder` first.
 */
export async function openFolderProject(options: {
  readonly key: string;
  readonly storage: BrowserKeyValueStore;
  readonly port: FolderProjectPort;
  readonly cache: FolderMediaCache;
  readonly now?: () => string;
}): Promise<FolderProjectOpenResult> {
  const { key, storage, port, cache } = options;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const loaded = await port.load(key);
  if (loaded.kind === 'refused') return { kind: 'refused', code: loaded.code };

  const known = getCatalogProject(storage, loaded.id);
  const entry: ProjectCatalogEntry = {
    id: loaded.id,
    title: loaded.title,
    createdAt: known?.createdAt ?? now,
    updatedAt: now,
    timelineProjectId: loaded.id,
    visualProjectId: loaded.id,
  };
  // A working copy with changes the folder never got is newer than the folder: keep it, and save it next.
  const keepWorkingCopy = known !== undefined && isFolderProjectUnsaved(storage, loaded.id);
  let needsSave = keepWorkingCopy;
  if (!keepWorkingCopy) {
    if (loaded.document === null) {
      // A folder that was never saved starts as a blank project, unless this browser already has its working copy.
      if (known === undefined) {
        const blank = createBlankProjectDocuments(loaded.id, loaded.title, now);
        new EditorSession(storage, blank.timeline, blank.visual);
      }
      needsSave = true;
    } else {
      const bundle = bundleFrom(loaded.document, loaded.documentProjectId, loaded.id);
      if (bundle === undefined) return { kind: 'unreadable' };
      replaceWorkingCopy(storage, entry, bundle);
    }
  }
  upsertCatalogProject(storage, entry);

  const assets = Object.values(readProjectBundle(storage, entry).visual.assets);
  const missingMedia = await bringMediaIntoCache(key, assets, port, cache);
  return {
    kind: 'opened',
    entry,
    revisionId: loaded.revisionId,
    needsSave,
    missingMedia,
  };
}

/** Saves the working copy into the open folder. */
export async function saveFolderProject(options: {
  readonly key: string;
  readonly storage: BrowserKeyValueStore;
  readonly port: FolderProjectPort;
  readonly entry: ProjectCatalogEntry;
  readonly baseRevisionId: string;
  readonly revisionId: string;
}): Promise<FolderProjectSaveResult> {
  const { key, storage, port, entry } = options;
  const current = getCatalogProject(storage, entry.id) ?? entry;
  const bundle = readProjectBundle(storage, current);
  const assets = Object.values(bundle.visual.assets);
  const reply = await port.save(key, {
    projectId: current.id,
    baseRevisionId: options.baseRevisionId,
    revisionId: options.revisionId,
    title: current.title,
    document: bundle,
    media: assets.map((asset) => ({
      assetId: asset.id,
      kind: asset.kind,
      displayName: asset.displayName,
      ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
    })),
  });
  if (reply.kind === 'refused') return { kind: 'refused', code: reply.code };
  const names = new Map(assets.map((asset) => [asset.id, asset.displayName]));
  return {
    kind: 'saved',
    revisionId: reply.revisionId,
    notStored: reply.notStored.map((id) => names.get(id) ?? id),
  };
}

/** The saved bundle, with its ids moved to the folder's id when the saved row names another one. */
function bundleFrom(
  document: unknown,
  savedId: string,
  id: string,
): ProjectDocumentBundle | undefined {
  if (!isRecord(document) || !isRecord(document['timeline']) || !isRecord(document['visual'])) {
    return undefined;
  }
  const moved = savedId === id ? document : renameId(document, savedId, id);
  const bundle = moved as unknown as ProjectDocumentBundle;
  if (bundle.timeline.id !== id || bundle.visual.id !== id) return undefined;
  if (validateSpikeProject(bundle.timeline).length > 0) return undefined;
  if (validateJoyProjectV1(bundle.visual).length > 0) return undefined;
  return bundle;
}

/**
 * Replaces this browser's working copy of the project's documents with the folder's. Only the document logs are
 * replaced: the catalog entry, audio state and other per-project records stay.
 */
function replaceWorkingCopy(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
  bundle: ProjectDocumentBundle,
): void {
  new BrowserProjectStore(storage, TIMELINE_LOG_KEY).deleteProject(entry.timelineProjectId);
  new BrowserProjectStore(storage, VISUAL_LOG_KEY).deleteProject(entry.visualProjectId);
  new BrowserProjectStore(storage, WORKFLOW_GRAPH_LOG_KEY).deleteProject(entry.id);
  new BrowserProjectStore(storage, CREATIVE_ARTIFACT_LOG_KEY).deleteProject(entry.id);
  new BrowserProjectStore(storage, LOOK_INSTANCES_LOG_KEY).deleteProject(entry.timelineProjectId);
  const looks =
    bundle.lookInstances !== undefined && Object.keys(bundle.lookInstances.instances).length > 0
      ? bundle.lookInstances
      : undefined;
  new EditorSession(storage, bundle.timeline, bundle.visual, {
    ...(bundle.graph === undefined ? {} : { graph: bundle.graph }),
    ...(bundle.artifacts === undefined ? {} : { artifacts: bundle.artifacts }),
    ...(looks === undefined ? {} : { lookInstances: looks }),
  });
}

/** Reads each media file this browser lacks from the folder. Returns the names of those neither has. */
async function bringMediaIntoCache(
  key: string,
  assets: readonly AssetRecordV1[],
  port: FolderProjectPort,
  cache: FolderMediaCache,
): Promise<string[]> {
  if (assets.length === 0) return [];
  const lacking: AssetRecordV1[] = [];
  for (const asset of assets) {
    if ((await cache.get(asset.id).catch(() => undefined)) === undefined) lacking.push(asset);
  }
  if (lacking.length === 0) return [];
  const reply = await port.mediaStates(
    key,
    lacking.map((asset) => asset.id),
  );
  const states = reply.kind === 'media' ? reply.states : [];
  const missing: string[] = [];
  for (const asset of lacking) {
    const state = states.find((item) => item.assetId === asset.id);
    const sha256 = asset.sha256 ?? state?.sha256;
    if (state?.present !== true || sha256 === undefined) {
      missing.push(asset.displayName);
      continue;
    }
    const blob = await readWholeMedia(key, asset, port);
    if (blob === undefined) {
      missing.push(asset.displayName);
      continue;
    }
    try {
      await cache.put(
        {
          assetId: asset.id,
          sha256,
          bytes: blob.size,
          mimeType: blob.type || 'application/octet-stream',
        },
        blob,
      );
    } catch {
      missing.push(asset.displayName);
    }
  }
  return missing;
}

async function readWholeMedia(
  key: string,
  asset: AssetRecordV1,
  port: FolderProjectPort,
): Promise<Blob | undefined> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const reply = await port.readMedia(key, asset.id, offset).catch(() => undefined);
    if (reply === undefined || reply.kind !== 'media-bytes') return undefined;
    if (reply.bytes.byteLength === 0 && offset < reply.total) return undefined;
    parts.push(reply.bytes);
    offset += reply.bytes.byteLength;
    if (offset >= reply.total) break;
  }
  const buffers = parts.map((part) => {
    const copy = new ArrayBuffer(part.byteLength);
    new Uint8Array(copy).set(part);
    return copy;
  });
  return new Blob(buffers, { type: asset.descriptor?.mimeType ?? 'application/octet-stream' });
}

function renameId(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((item) => renameId(item, from, to));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      result[name === from ? to : name] = renameId(item, from, to);
    }
    return result;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
