import { describe, expect, it } from 'vitest';
import { EditorSession } from './editor-session.js';
import { createBlankProjectDocuments } from './project-factory.js';
import {
  getCatalogProject,
  listCatalogProjects,
  listTrashedCatalogProjects,
  upsertCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import {
  duplicateLocalProject,
  purgeLocalProject,
  renameLocalProject,
  restoreLocalProject,
  trashLocalProject,
} from './project-lifecycle.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function createEntry(
  storage: ReturnType<typeof memoryStorage>,
  id = 'source-project',
): ProjectCatalogEntry {
  const now = '2026-08-09T00:00:00.000Z';
  const seeds = createBlankProjectDocuments(id, 'Source project', now);
  new EditorSession(storage, seeds.timeline, seeds.visual);
  const entry: ProjectCatalogEntry = {
    id,
    title: 'Source project',
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  upsertCatalogProject(storage, entry);
  return entry;
}

describe('project lifecycle', () => {
  it('renames the catalog and persisted visual document without adding editor history', () => {
    const storage = memoryStorage();
    const entry = createEntry(storage);
    const renamed = renameLocalProject(storage, entry, 'Renamed project');
    expect(renamed.title).toBe('Renamed project');
    expect(getCatalogProject(storage, entry.id)?.title).toBe('Renamed project');
    const reopened = new EditorSession(
      storage,
      createBlankProjectDocuments(entry.id, entry.title).timeline,
      createBlankProjectDocuments(entry.id, entry.title).visual,
    );
    expect(reopened.visualProject.title).toBe('Renamed project');
    expect(reopened.historyEntries).toHaveLength(1);
    expect(reopened.historyEntries[0]?.label).toBe('Document');
  });

  it('duplicates current creative state with a fresh identity and no history', () => {
    const storage = memoryStorage();
    const entry = createEntry(storage);
    const source = new EditorSession(
      storage,
      createBlankProjectDocuments(entry.id, entry.title).timeline,
      createBlankProjectDocuments(entry.id, entry.title).visual,
    );
    source.renameProjectTitle('Source with edits');
    const duplicate = duplicateLocalProject(storage, entry, 'Source copy', {
      createId: () => 'duplicate-project',
      now: () => '2026-08-09T01:00:00.000Z',
    });
    expect(duplicate.id).toBe('duplicate-project');
    expect(listCatalogProjects(storage).map((item) => item.id)).toContain('duplicate-project');
    const reopened = new EditorSession(
      storage,
      createBlankProjectDocuments(duplicate.id, duplicate.title).timeline,
      createBlankProjectDocuments(duplicate.id, duplicate.title).visual,
    );
    expect(reopened.visualProject.title).toBe('Source copy');
    expect(reopened.timelineProject.id).toBe('duplicate-project');
    expect(reopened.historyEntries).toHaveLength(1);
    expect(reopened.historyEntries[0]?.label).toBe('Document');
  });

  it('moves a project to Trash, restores it, and purges only the target data', () => {
    const storage = memoryStorage();
    const first = createEntry(storage, 'first-project');
    const second = createEntry(storage, 'second-project');
    trashLocalProject(storage, first);
    expect(listCatalogProjects(storage).map((item) => item.id)).toEqual(['second-project']);
    expect(listTrashedCatalogProjects(storage).map((item) => item.id)).toEqual(['first-project']);
    restoreLocalProject(storage, first);
    expect(listCatalogProjects(storage).map((item) => item.id)).toContain('first-project');
    trashLocalProject(storage, first);
    purgeLocalProject(storage, first);
    expect(getCatalogProject(storage, first.id)).toBeUndefined();
    expect(getCatalogProject(storage, second.id)?.title).toBe('Source project');
    expect(
      new EditorSession(
        storage,
        createBlankProjectDocuments(second.id, second.title).timeline,
        createBlankProjectDocuments(second.id, second.title).visual,
      ).timelineProject.id,
    ).toBe(second.id);
  });
});
