import { describe, expect, it } from 'vitest';
import type { ProjectCatalogEntry } from './project-catalog.js';
import { mergeProjectList, type FolderProjectListing } from './project-list-merge.js';

function browser(
  id: string,
  title: string,
  updatedAt: string,
  trashedAt?: string,
): ProjectCatalogEntry {
  return {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    timelineProjectId: `${id}-timeline`,
    visualProjectId: `${id}-visual`,
    ...(trashedAt === undefined ? {} : { trashedAt }),
  };
}

function folder(
  root: string,
  id: string,
  title: string,
  updatedAt: string,
  trashedAt?: string,
): FolderProjectListing {
  return {
    root,
    entry: {
      id,
      title,
      createdAt: updatedAt,
      updatedAt,
      timelineProjectId: `${id}-timeline`,
      visualProjectId: `${id}-visual`,
      ...(trashedAt === undefined ? {} : { trashedAt }),
    },
  };
}

describe('mergeProjectList', () => {
  it('puts browser and folder projects in one list, newest change first', () => {
    const result = mergeProjectList(
      [
        browser('b1', 'Browser old', '2026-11-01T00:00:00.000Z'),
        browser('b2', 'Browser new', '2026-11-09T00:00:00.000Z'),
      ],
      [folder('C:\\Projects\\Trip.joyproj', 'f1', 'Trip', '2026-11-05T00:00:00.000Z')],
    );

    expect(result.items.map((item) => [item.title, item.source])).toEqual([
      ['Browser new', 'browser'],
      ['Trip', 'folder'],
      ['Browser old', 'browser'],
    ]);
    expect(result.problems).toEqual([]);
  });

  it('marks a folder project with its folder path', () => {
    const result = mergeProjectList(
      [],
      [folder('C:\\Projects\\Trip.joyproj', 'f1', 'Trip', '2026-11-05T00:00:00.000Z')],
    );

    expect(result.items).toEqual([
      {
        key: 'folder:C:\\Projects\\Trip.joyproj',
        id: 'f1',
        title: 'Trip',
        updatedAt: '2026-11-05T00:00:00.000Z',
        source: 'folder',
        folderRoot: 'C:\\Projects\\Trip.joyproj',
      },
    ]);
  });

  it('hides trashed projects from both sources', () => {
    const result = mergeProjectList(
      [browser('b1', 'Gone', '2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z')],
      [
        folder(
          'C:\\Projects\\Old.joyproj',
          'f1',
          'Old',
          '2026-11-02T00:00:00.000Z',
          '2026-11-03T00:00:00.000Z',
        ),
      ],
    );

    expect(result.items).toEqual([]);
  });

  it('lets a folder take the place of a browser project with the same id', () => {
    const result = mergeProjectList(
      [browser('same', 'Browser copy', '2026-11-01T00:00:00.000Z')],
      [folder('C:\\Projects\\Same.joyproj', 'same', 'Folder copy', '2026-11-04T00:00:00.000Z')],
    );

    expect(result.items.map((item) => [item.title, item.source])).toEqual([
      ['Folder copy', 'folder'],
    ]);
  });

  it('lists two folder copies that share an id, each under its own folder path', () => {
    const result = mergeProjectList(
      [],
      [
        folder('C:\\Projects\\Trip.joyproj', 'shared', 'Trip', '2026-11-05T00:00:00.000Z'),
        folder('C:\\Projects\\Trip copy.joyproj', 'shared', 'Trip', '2026-11-05T00:00:00.000Z'),
      ],
    );

    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.key)).size).toBe(2);
    expect(result.items.every((item) => item.source === 'folder')).toBe(true);
  });

  it('reports unreadable folders and keeps the rest of the list', () => {
    const result = mergeProjectList(
      [browser('b1', 'Browser', '2026-11-01T00:00:00.000Z')],
      [
        { root: 'C:\\Projects\\Broken.joyproj', problem: 'The project folder entry is malformed' },
        folder('C:\\Projects\\Trip.joyproj', 'f1', 'Trip', '2026-11-05T00:00:00.000Z'),
      ],
    );

    expect(result.problems).toEqual([
      { root: 'C:\\Projects\\Broken.joyproj', problem: 'The project folder entry is malformed' },
    ]);
    expect(result.items.map((item) => item.title)).toEqual(['Trip', 'Browser']);
  });

  it('returns an empty list when there is nothing to show', () => {
    expect(mergeProjectList([], [])).toEqual({ items: [], problems: [] });
  });
});
