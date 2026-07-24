import { describe, expect, it } from 'vitest';
import {
  clearActiveProjectId,
  getCatalogProject,
  listCatalogProjects,
  loadActiveProjectId,
  removeCatalogProject,
  saveActiveProjectId,
  upsertCatalogProject,
} from './project-catalog.js';
import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('project catalog library gate', () => {
  it('seeds the sample project on first list', () => {
    const storage = memoryStorage();
    const projects = listCatalogProjects(storage);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(INITIAL_EDITOR_PROJECT.id);
    expect(projects[0]?.timelineProjectId).toBe(REFERENCE_PROJECT.id);
  });

  it('creates, activates, and reopens a blank project through EditorSession', () => {
    const storage = memoryStorage();
    listCatalogProjects(storage);
    const id = 'proj-new-1';
    const now = '2026-07-24T00:00:00.000Z';
    const seeds = createBlankProjectDocuments(id, 'My cut', now);
    new EditorSession(storage, seeds.timeline, seeds.visual);
    upsertCatalogProject(storage, {
      id,
      title: 'My cut',
      createdAt: now,
      updatedAt: now,
      timelineProjectId: id,
      visualProjectId: id,
    });
    saveActiveProjectId(storage, id);
    expect(loadActiveProjectId(storage)).toBe(id);

    const entry = getCatalogProject(storage, id);
    expect(entry?.title).toBe('My cut');
    const reopenSeeds = seedsForCatalogEntry(entry!);
    const session = new EditorSession(storage, reopenSeeds.timeline, reopenSeeds.visual);
    expect(session.visualProject.title).toBe('My cut');
    expect(session.timelineProject.id).toBe(id);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips).toEqual([]);
  });

  it('clears active project when removed from the catalog', () => {
    const storage = memoryStorage();
    const projects = listCatalogProjects(storage);
    const sampleId = projects[0]!.id;
    saveActiveProjectId(storage, sampleId);
    removeCatalogProject(storage, sampleId);
    expect(loadActiveProjectId(storage)).toBeNull();
    expect(getCatalogProject(storage, sampleId)).toBeUndefined();
  });

  it('clears a stuck active id', () => {
    const storage = memoryStorage();
    saveActiveProjectId(storage, 'missing');
    clearActiveProjectId(storage);
    expect(loadActiveProjectId(storage)).toBeNull();
  });
});
