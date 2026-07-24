/**
 * Lightweight project library catalog (CapCut-style gate).
 * Creative documents stay in timeline/visual persistence stores; this index
 * only tracks which projects exist, their titles, and the paired document ids.
 */

import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { BrowserProjectStore } from '@joy-media/project-persistence';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

export const PROJECT_CATALOG_KEY = 'joy-media.project-catalog.v1';
export const ACTIVE_PROJECT_KEY = 'joy-media.active-project.v1';
export const TIMELINE_LOG_KEY = 'joy-media.timeline-project-log.v1';
export const VISUAL_LOG_KEY = 'joy-media.visual-object-project-log.v1';

export interface ProjectCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timelineProjectId: string;
  readonly visualProjectId: string;
}

interface CatalogDatabase {
  readonly version: 1;
  readonly projects: Readonly<Record<string, ProjectCatalogEntry>>;
}

interface ActiveProjectDatabase {
  readonly version: 1;
  readonly projectId: string | null;
}

export function listCatalogProjects(storage: BrowserKeyValueStore): readonly ProjectCatalogEntry[] {
  ensureSeedCatalog(storage);
  return Object.values(readCatalog(storage).projects).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getCatalogProject(
  storage: BrowserKeyValueStore,
  projectId: string,
): ProjectCatalogEntry | undefined {
  return readCatalog(storage).projects[projectId];
}

export function upsertCatalogProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): ProjectCatalogEntry {
  const database = readCatalog(storage);
  writeCatalog(storage, {
    version: 1,
    projects: { ...database.projects, [entry.id]: entry },
  });
  return entry;
}

export function removeCatalogProject(storage: BrowserKeyValueStore, projectId: string): void {
  const database = readCatalog(storage);
  if (database.projects[projectId] === undefined) return;
  const rest: Record<string, ProjectCatalogEntry> = {};
  for (const [id, entry] of Object.entries(database.projects)) {
    if (id !== projectId) rest[id] = entry;
  }
  writeCatalog(storage, { version: 1, projects: rest });
  if (loadActiveProjectId(storage) === projectId) clearActiveProjectId(storage);
}

export function loadActiveProjectId(storage: BrowserKeyValueStore): string | null {
  const serialized = storage.getItem(ACTIVE_PROJECT_KEY);
  if (serialized === null) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    return typeof parsed.projectId === 'string' && parsed.projectId.trim().length > 0
      ? parsed.projectId
      : null;
  } catch {
    return null;
  }
}

export function saveActiveProjectId(storage: BrowserKeyValueStore, projectId: string): void {
  const payload: ActiveProjectDatabase = { version: 1, projectId };
  storage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify(payload));
}

export function clearActiveProjectId(storage: BrowserKeyValueStore): void {
  const payload: ActiveProjectDatabase = { version: 1, projectId: null };
  storage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify(payload));
}

/** First visit only: register the sample editor project. Empty catalogs stay empty. */
export function ensureSeedCatalog(storage: BrowserKeyValueStore): void {
  if (storage.getItem(PROJECT_CATALOG_KEY) !== null) return;

  const now = new Date().toISOString();
  const sample: ProjectCatalogEntry = {
    id: INITIAL_EDITOR_PROJECT.id,
    title: INITIAL_EDITOR_PROJECT.title,
    createdAt: now,
    updatedAt: now,
    timelineProjectId: REFERENCE_PROJECT.id,
    visualProjectId: INITIAL_EDITOR_PROJECT.id,
  };

  const migrated = migrateFromStores(storage, now);
  const projects: Record<string, ProjectCatalogEntry> = { [sample.id]: sample };
  for (const entry of migrated) {
    if (projects[entry.id] === undefined) projects[entry.id] = entry;
  }
  writeCatalog(storage, { version: 1, projects });
}

function migrateFromStores(
  storage: BrowserKeyValueStore,
  now: string,
): readonly ProjectCatalogEntry[] {
  const visualIds = new BrowserProjectStore(storage, VISUAL_LOG_KEY).listProjectIds();
  const timelineIds = new BrowserProjectStore(storage, TIMELINE_LOG_KEY).listProjectIds();
  const entries: ProjectCatalogEntry[] = [];
  for (const visualId of visualIds) {
    if (visualId === INITIAL_EDITOR_PROJECT.id) continue;
    entries.push({
      id: visualId,
      title: visualId,
      createdAt: now,
      updatedAt: now,
      timelineProjectId: timelineIds.includes(visualId) ? visualId : visualId,
      visualProjectId: visualId,
    });
  }
  for (const timelineId of timelineIds) {
    if (timelineId === REFERENCE_PROJECT.id) continue;
    if (entries.some((entry) => entry.timelineProjectId === timelineId)) continue;
    if (visualIds.includes(timelineId)) continue;
    entries.push({
      id: timelineId,
      title: timelineId,
      createdAt: now,
      updatedAt: now,
      timelineProjectId: timelineId,
      visualProjectId: timelineId,
    });
  }
  return entries;
}

function readCatalog(storage: BrowserKeyValueStore): CatalogDatabase {
  const serialized = storage.getItem(PROJECT_CATALOG_KEY);
  if (serialized === null) return { version: 1, projects: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isCatalog(parsed)) return { version: 1, projects: {} };
    return parsed;
  } catch {
    return { version: 1, projects: {} };
  }
}

function writeCatalog(storage: BrowserKeyValueStore, database: CatalogDatabase): void {
  storage.setItem(PROJECT_CATALOG_KEY, JSON.stringify(database));
}

function isCatalog(value: unknown): value is CatalogDatabase {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.projects)) return false;
  return Object.entries(value.projects).every(([id, entry]) => {
    if (!isRecord(entry) || entry.id !== id) return false;
    return (
      typeof entry.title === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.updatedAt === 'string' &&
      typeof entry.timelineProjectId === 'string' &&
      typeof entry.visualProjectId === 'string'
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
