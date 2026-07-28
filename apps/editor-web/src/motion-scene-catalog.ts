/**
 * Motion Studio's own library: an index of MotionSceneDocuments plus the
 * document store behind it. Mirrors project-catalog.ts (index + separate
 * document log), simplified to one document type instead of a
 * timeline/visual-object pair — a motion scene is already self-contained.
 */

import type { BrowserKeyValueStore, PersistenceAdapter } from '@joy-media/project-persistence';
import { BrowserProjectStore, LocalProjectPersistence, PersistenceError } from '@joy-media/project-persistence';
import type { MotionSceneDocument } from '@joy-media/motion-core';
import { createBlankScene, validateMotionSceneDocument } from '@joy-media/motion-core';
import { applySceneCommand, type SceneCommand } from './motion-studio/state/sceneCommands.js';

export const MOTION_SCENE_CATALOG_KEY = 'joy-media.motion-scene-catalog.v1';
export const MOTION_SCENE_LOG_KEY = 'joy-media.motion-scene-project-log.v1';
export const MOTION_SCENE_PUBLISHED_KEY = 'joy-media.motion-scene-published.v1';

export interface MotionSceneCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Set once Publish has run at least once; the artifact itself lives under MOTION_SCENE_PUBLISHED_KEY. */
  readonly publishedAt?: string;
}

interface CatalogDatabase {
  readonly version: 1;
  readonly scenes: Readonly<Record<string, MotionSceneCatalogEntry>>;
}

interface PublishedDatabase {
  readonly version: 1;
  readonly scenes: Readonly<Record<string, MotionSceneDocument>>;
}

/* ─── Catalog (metadata index) ─── */

export function listCatalogScenes(storage: BrowserKeyValueStore): readonly MotionSceneCatalogEntry[] {
  return Object.values(readCatalog(storage).scenes).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getCatalogScene(
  storage: BrowserKeyValueStore,
  sceneId: string,
): MotionSceneCatalogEntry | undefined {
  return readCatalog(storage).scenes[sceneId];
}

export function removeCatalogScene(storage: BrowserKeyValueStore, sceneId: string): void {
  const database = readCatalog(storage);
  if (database.scenes[sceneId] === undefined) return;
  const rest: Record<string, MotionSceneCatalogEntry> = {};
  for (const [id, entry] of Object.entries(database.scenes)) {
    if (id !== sceneId) rest[id] = entry;
  }
  writeCatalog(storage, { version: 1, scenes: rest });
}

function upsertCatalogScene(storage: BrowserKeyValueStore, entry: MotionSceneCatalogEntry): void {
  const database = readCatalog(storage);
  writeCatalog(storage, { version: 1, scenes: { ...database.scenes, [entry.id]: entry } });
}

/* ─── Document persistence (snapshot/transaction log) ─── */

const adapter: PersistenceAdapter<MotionSceneDocument, SceneCommand> = {
  projectId: (document) => document.id,
  schemaVersion: (document) => document.schemaVersion,
  validate: (document) =>
    validateMotionSceneDocument(document).map((error) => ({
      code: error.path || 'document',
      message: error.message,
    })),
  apply: (document, command) => applySceneCommand(document, command).document,
};

function getPersistence(
  storage: BrowserKeyValueStore,
): LocalProjectPersistence<MotionSceneDocument, SceneCommand> {
  const store = new BrowserProjectStore<MotionSceneDocument, SceneCommand>(
    storage,
    MOTION_SCENE_LOG_KEY,
  );
  return new LocalProjectPersistence(store, adapter);
}

export function createMotionScene(
  storage: BrowserKeyValueStore,
  title = 'Untitled Motion',
  width?: number,
  height?: number,
): MotionSceneDocument {
  const document =
    width !== undefined && height !== undefined
      ? createBlankScene(title, width, height)
      : createBlankScene(title);
  getPersistence(storage).initialize(document);
  const now = new Date().toISOString();
  upsertCatalogScene(storage, {
    id: document.id,
    title: document.name,
    createdAt: now,
    updatedAt: now,
    width: document.width,
    height: document.height,
    durationMs: document.durationMs,
  });
  return document;
}

export function loadMotionSceneDocument(
  storage: BrowserKeyValueStore,
  sceneId: string,
): MotionSceneDocument | undefined {
  try {
    return getPersistence(storage).recover(sceneId).project;
  } catch (error) {
    if (error instanceof PersistenceError) return undefined;
    throw error;
  }
}

/** Whole-document autosave/manual-save — a Studio edit session has no per-keystroke command trail to replay. */
export function saveMotionSceneDocument(
  storage: BrowserKeyValueStore,
  document: MotionSceneDocument,
): void {
  getPersistence(storage).saveSnapshot(document, true);
  const existing = getCatalogScene(storage, document.id);
  const now = new Date().toISOString();
  upsertCatalogScene(storage, {
    id: document.id,
    title: document.name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    width: document.width,
    height: document.height,
    durationMs: document.durationMs,
    ...(existing?.publishedAt !== undefined ? { publishedAt: existing.publishedAt } : {}),
  });
}

export function duplicateMotionScene(
  storage: BrowserKeyValueStore,
  sourceId: string,
  newTitle: string,
): MotionSceneDocument | undefined {
  const source = loadMotionSceneDocument(storage, sourceId);
  if (source === undefined) return undefined;
  const duplicate: MotionSceneDocument = { ...source, id: crypto.randomUUID(), name: newTitle };
  getPersistence(storage).initialize(duplicate);
  const now = new Date().toISOString();
  upsertCatalogScene(storage, {
    id: duplicate.id,
    title: duplicate.name,
    createdAt: now,
    updatedAt: now,
    width: duplicate.width,
    height: duplicate.height,
    durationMs: duplicate.durationMs,
  });
  return duplicate;
}

export function renameMotionScene(storage: BrowserKeyValueStore, sceneId: string, title: string): void {
  const document = loadMotionSceneDocument(storage, sceneId);
  if (document === undefined) return;
  saveMotionSceneDocument(storage, { ...document, name: title });
}

/* ─── Publish: a finalized copy distinct from the live draft ─── */

export function publishMotionScene(storage: BrowserKeyValueStore, document: MotionSceneDocument): void {
  saveMotionSceneDocument(storage, document);
  const published = readPublished(storage);
  writePublished(storage, {
    version: 1,
    scenes: { ...published.scenes, [document.id]: document },
  });
  const existing = getCatalogScene(storage, document.id);
  if (existing !== undefined) {
    upsertCatalogScene(storage, { ...existing, publishedAt: new Date().toISOString() });
  }
}

export function getPublishedMotionScene(
  storage: BrowserKeyValueStore,
  sceneId: string,
): MotionSceneDocument | undefined {
  return readPublished(storage).scenes[sceneId];
}

/* ─── Storage plumbing ─── */

function readCatalog(storage: BrowserKeyValueStore): CatalogDatabase {
  const serialized = storage.getItem(MOTION_SCENE_CATALOG_KEY);
  if (serialized === null) return { version: 1, scenes: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isCatalog(parsed) ? parsed : { version: 1, scenes: {} };
  } catch {
    return { version: 1, scenes: {} };
  }
}

function writeCatalog(storage: BrowserKeyValueStore, database: CatalogDatabase): void {
  storage.setItem(MOTION_SCENE_CATALOG_KEY, JSON.stringify(database));
}

function readPublished(storage: BrowserKeyValueStore): PublishedDatabase {
  const serialized = storage.getItem(MOTION_SCENE_PUBLISHED_KEY);
  if (serialized === null) return { version: 1, scenes: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scenes)) {
      return { version: 1, scenes: {} };
    }
    return parsed as unknown as PublishedDatabase;
  } catch {
    return { version: 1, scenes: {} };
  }
}

function writePublished(storage: BrowserKeyValueStore, database: PublishedDatabase): void {
  storage.setItem(MOTION_SCENE_PUBLISHED_KEY, JSON.stringify(database));
}

function isCatalog(value: unknown): value is CatalogDatabase {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.scenes)) return false;
  return Object.entries(value.scenes).every(([id, entry]) => {
    if (!isRecord(entry) || entry.id !== id) return false;
    return (
      typeof entry.title === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.updatedAt === 'string' &&
      typeof entry.width === 'number' &&
      typeof entry.height === 'number' &&
      typeof entry.durationMs === 'number'
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
