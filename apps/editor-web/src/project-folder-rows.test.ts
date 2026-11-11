import { describe, expect, it } from 'vitest';
import type { ProjectCatalogEntry } from './project-catalog.js';
import type { ProjectFolderListedItem } from './project-folder-client.js';
import { projectListRows, type ProjectListRow } from './project-folder-rows.js';

/** The title a row shows in these tests: a browser entry's, or a folder entry's, or a folder's name when it has no entry. */
function entryTitle(row: ProjectListRow): string {
  if (row.kind === 'browser') return row.entry.title;
  return row.kind === 'folder' ? row.folder.entry.title : row.folder.name;
}

function browser(
  id: string,
  title: string,
  updatedAt: string,
  extra: Partial<ProjectCatalogEntry> = {},
): ProjectCatalogEntry {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    timelineProjectId: id,
    visualProjectId: id,
    ...extra,
  };
}

function folder(
  key: string,
  name: string,
  title: string,
  updatedAt: string,
  extra: Partial<ProjectFolderListedItem> = {},
): ProjectFolderListedItem {
  return {
    key,
    name,
    entry: {
      id: `project-${key}`,
      title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt,
      timelineProjectId: `project-${key}`,
      visualProjectId: `project-${key}`,
    },
    ...extra,
  };
}

describe('the merged project list rows', () => {
  it('lists browser projects and folder projects together, newest change first', () => {
    const result = projectListRows({
      browser: [browser('b1', 'Browser one', '2026-11-01T00:00:00.000Z')],
      folders: [folder('f1', 'Folder.joyproj', 'Folder one', '2026-11-05T00:00:00.000Z')],
      query: '',
      sort: 'updated-desc',
    });
    expect(
      result.rows.map((row) => (row.kind === 'browser' ? row.entry.title : row.folder.name)),
    ).toEqual(['Folder.joyproj', 'Browser one']);
    expect(result.problems).toEqual([]);
  });

  it('lets a folder take the place of a browser entry with the same id', () => {
    const result = projectListRows({
      browser: [browser('project-f1', 'Old browser copy', '2026-11-01T00:00:00.000Z')],
      folders: [folder('f1', 'Folder.joyproj', 'Folder one', '2026-11-05T00:00:00.000Z')],
      query: '',
      sort: 'updated-desc',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe('folder');
  });

  it('hides a trashed browser entry and a trashed folder', () => {
    const result = projectListRows({
      browser: [
        browser('b1', 'Gone', '2026-11-01T00:00:00.000Z', {
          trashedAt: '2026-11-02T00:00:00.000Z',
        }),
      ],
      folders: [
        {
          key: 'f1',
          name: 'Trashed.joyproj',
          entry: {
            id: 'project-f1',
            title: 'Trashed',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
            timelineProjectId: 'project-f1',
            visualProjectId: 'project-f1',
            trashedAt: '2026-11-02T00:00:00.000Z',
          },
        },
      ],
      query: '',
      sort: 'updated-desc',
    });
    expect(result.rows).toEqual([]);
  });

  it('searches folder and browser titles alike, without case', () => {
    const result = projectListRows({
      browser: [browser('b1', 'Browser one', '2026-11-01T00:00:00.000Z')],
      folders: [folder('f1', 'Folder.joyproj', 'Summer Cut', '2026-11-05T00:00:00.000Z')],
      query: '  summer ',
      sort: 'updated-desc',
    });
    expect(result.rows.map((row) => entryTitle(row))).toEqual(['Summer Cut']);
  });

  it('sorts by name, both ways', () => {
    const input = {
      browser: [browser('b1', 'Beta', '2026-11-01T00:00:00.000Z')],
      folders: [folder('f1', 'Alpha.joyproj', 'Alpha', '2026-11-05T00:00:00.000Z')],
      query: '',
    };
    const asc = projectListRows({ ...input, sort: 'name-asc' }).rows;
    const desc = projectListRows({ ...input, sort: 'name-desc' }).rows;
    expect(asc.map((row) => entryTitle(row))).toEqual(['Alpha', 'Beta']);
    expect(desc.map((row) => entryTitle(row))).toEqual(['Beta', 'Alpha']);
  });

  it('reports the folders it could not read, by name and reason, and lists no row for them', () => {
    const result = projectListRows({
      browser: [],
      folders: [
        { key: 'f1', name: 'Bare.joyproj', problem: 'not-a-folder' },
        folder('f2', 'Good.joyproj', 'Good', '2026-11-05T00:00:00.000Z'),
      ],
      query: '',
      sort: 'updated-desc',
    });
    expect(result.problems).toEqual([{ name: 'Bare.joyproj', problem: 'not-a-folder' }]);
    expect(result.rows).toHaveLength(1);
  });
});

describe('a folder with no project entry', () => {
  it('is a row of its own, shown by its name, and is not repeated in the problems', () => {
    const result = projectListRows({
      browser: [],
      folders: [{ key: 'k-missing', name: 'Lost.joyproj', problem: 'no-entry' }],
      query: '',
      sort: 'name-asc',
    });

    expect(result.rows).toEqual([
      { kind: 'folder-missing-entry', folder: { key: 'k-missing', name: 'Lost.joyproj' } },
    ]);
    expect(result.problems).toEqual([]);
  });

  it('is found by its name in the search', () => {
    const result = projectListRows({
      browser: [],
      folders: [{ key: 'k-missing', name: 'Lost.joyproj', problem: 'no-entry' }],
      query: 'lost',
      sort: 'updated-desc',
    });

    expect(result.rows).toHaveLength(1);
  });

  it('keeps the other problems in the notice', () => {
    const result = projectListRows({
      browser: [],
      folders: [
        { key: 'k-missing', name: 'Lost.joyproj', problem: 'no-entry' },
        { key: 'k-bare', name: 'Bare.joyproj', problem: 'not-a-folder' },
      ],
      query: '',
      sort: 'name-asc',
    });

    expect(result.problems).toEqual([{ name: 'Bare.joyproj', problem: 'not-a-folder' }]);
  });
});
