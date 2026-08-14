/**
 * Lightweight project library catalog (CapCut-style gate).
 * Creative documents stay in timeline/visual persistence stores; this index
 * only tracks which projects exist, their titles, and the paired document ids.
 */

import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { BrowserProjectStore } from '@joy-media/project-persistence';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { TIMELINE_ELEMENTS_SHOWCASE } from './timeline-elements-showcase.js';

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
  readonly trashedAt?: string;
}

interface CatalogDatabase {
  readonly version: 1 | 2 | 3 | 4;
  readonly projects: Readonly<Record<string, ProjectCatalogEntry>>;
}

interface ActiveProjectDatabase {
  readonly version: 1;
  readonly projectId: string | null;
}

export function listCatalogProjects(storage: BrowserKeyValueStore): readonly ProjectCatalogEntry[] {
  ensureSeedCatalog(storage);
  return sortCatalog(
    Object.values(readCatalog(storage).projects).filter((entry) => entry.trashedAt === undefined),
  );
}

export function listTrashedCatalogProjects(
  storage: BrowserKeyValueStore,
): readonly ProjectCatalogEntry[] {
  ensureSeedCatalog(storage);
  return sortCatalog(
    Object.values(readCatalog(storage).projects).filter((entry) => entry.trashedAt !== undefined),
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
    version: 4,
    projects: { ...database.projects, [entry.id]: entry },
  });
  return entry;
}

export function trashCatalogProject(storage: BrowserKeyValueStore, projectId: string): void {
  const database = readCatalog(storage);
  const entry = database.projects[projectId];
  if (entry === undefined || entry.trashedAt !== undefined) return;
  writeCatalog(storage, {
    version: 4,
    projects: {
      ...database.projects,
      [projectId]: {
        ...entry,
        trashedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  if (loadActiveProjectId(storage) === projectId) clearActiveProjectId(storage);
}

export function restoreCatalogProject(storage: BrowserKeyValueStore, projectId: string): void {
  const database = readCatalog(storage);
  const entry = database.projects[projectId];
  if (entry === undefined || entry.trashedAt === undefined) return;
  const { trashedAt, ...rest } = entry;
  void trashedAt;
  writeCatalog(storage, {
    version: 4,
    projects: {
      ...database.projects,
      [projectId]: { ...rest, updatedAt: new Date().toISOString() },
    },
  });
}

export function purgeCatalogProject(storage: BrowserKeyValueStore, projectId: string): void {
  const database = readCatalog(storage);
  if (database.projects[projectId] === undefined) return;
  const rest: Record<string, ProjectCatalogEntry> = {};
  for (const [id, entry] of Object.entries(database.projects)) {
    if (id !== projectId) rest[id] = entry;
  }
  writeCatalog(storage, { version: 4, projects: rest });
  if (loadActiveProjectId(storage) === projectId) clearActiveProjectId(storage);
}

/** Backward-compatible alias for callers that already remove a catalog entry. */
export function removeCatalogProject(storage: BrowserKeyValueStore, projectId: string): void {
  purgeCatalogProject(storage, projectId);
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

/** First visit only: register the sample editor and timeline-element showcase. */
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
  const showcase = showcaseCatalogEntry(now);

  const migrated = migrateFromStores(storage, now);
  const projects: Record<string, ProjectCatalogEntry> = {
    [sample.id]: sample,
    [showcase.id]: showcase,
  };
  for (const entry of migrated) {
    if (projects[entry.id] === undefined) projects[entry.id] = entry;
  }
  writeCatalog(storage, { version: 4, projects });
}

function showcaseCatalogEntry(now: string): ProjectCatalogEntry {
  return {
    id: TIMELINE_ELEMENTS_SHOWCASE.id,
    title: TIMELINE_ELEMENTS_SHOWCASE.title,
    createdAt: now,
    updatedAt: now,
    timelineProjectId: TIMELINE_ELEMENTS_SHOWCASE.id,
    visualProjectId: TIMELINE_ELEMENTS_SHOWCASE.id,
  };
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
  if (serialized === null) return { version: 4, projects: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isCatalog(parsed)) return { version: 4, projects: {} };
    const projects: Record<string, ProjectCatalogEntry> = Object.fromEntries(
      Object.entries(parsed.projects).map(([id, entry]) => [
        id,
        entry.trashedAt === undefined ? entry : { ...entry, trashedAt: entry.trashedAt },
      ]),
    );
    let replacedStaleShowcase = false;
    for (const id of Object.keys(projects)) {
      if (id.startsWith('timeline-elements-showcase-v') && id !== TIMELINE_ELEMENTS_SHOWCASE.id) {
        delete projects[id];
        replacedStaleShowcase = true;
      }
    }
    if (parsed.version < 4 || replacedStaleShowcase) {
      const now = new Date().toISOString();
      if (projects[TIMELINE_ELEMENTS_SHOWCASE.id] === undefined)
        projects[TIMELINE_ELEMENTS_SHOWCASE.id] = showcaseCatalogEntry(now);
    }
    const database: CatalogDatabase = {
      version: 4,
      projects,
    };
    if (parsed.version !== 4 || replacedStaleShowcase) writeCatalog(storage, database);
    return database;
  } catch {
    return { version: 4, projects: {} };
  }
}

function writeCatalog(storage: BrowserKeyValueStore, database: CatalogDatabase): void {
  storage.setItem(PROJECT_CATALOG_KEY, JSON.stringify(database));
}

function isCatalog(value: unknown): value is CatalogDatabase {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) ||
    !isRecord(value.projects)
  )
    return false;
  return Object.entries(value.projects).every(([id, entry]) => {
    if (!isRecord(entry) || entry.id !== id) return false;
    return (
      typeof entry.title === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.updatedAt === 'string' &&
      typeof entry.timelineProjectId === 'string' &&
      typeof entry.visualProjectId === 'string' &&
      (entry.trashedAt === undefined || typeof entry.trashedAt === 'string')
    );
  });
}

function sortCatalog(entries: readonly ProjectCatalogEntry[]): readonly ProjectCatalogEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
