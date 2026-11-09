import type { ProjectCatalogEntry } from './project-catalog.js';

/**
 * The merged project list (owner decision, 10 Nov 2026): projects kept in the browser and the
 * project folders in the default folder appear in one list. This module is pure, so the list and
 * its tests share it. As in the browser list, trashed projects are hidden and the newest change
 * comes first.
 */

/** A project folder's catalog entry, as the desktop listing reports it. */
export interface FolderProjectEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timelineProjectId: string;
  readonly visualProjectId: string;
  readonly trashedAt?: string;
}

/** One folder from the desktop listing: its entry, or the problem that stopped it. */
export interface FolderProjectListing {
  readonly root: string;
  readonly entry?: FolderProjectEntry;
  readonly problem?: string;
}

export type ProjectListSource = 'browser' | 'folder';

export interface MergedProjectItem {
  /** Unique within the list: a browser project by its id, a folder by its folder path. */
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly source: ProjectListSource;
  /** The folder path, for a folder project. */
  readonly folderRoot?: string;
}

export interface MergedProjectList {
  readonly items: readonly MergedProjectItem[];
  /** Folders the list could not read, so the page can say why they are missing. */
  readonly problems: readonly { readonly root: string; readonly problem: string }[];
}

export function mergeProjectList(
  browserEntries: readonly ProjectCatalogEntry[],
  folderListings: readonly FolderProjectListing[],
): MergedProjectList {
  const problems = folderListings.flatMap((listing) =>
    listing.problem === undefined ? [] : [{ root: listing.root, problem: listing.problem }],
  );

  const folderItems = folderListings.flatMap((listing): MergedProjectItem[] => {
    const entry = listing.entry;
    if (entry === undefined || entry.trashedAt !== undefined) return [];
    return [
      {
        key: `folder:${listing.root}`,
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt,
        source: 'folder',
        folderRoot: listing.root,
      },
    ];
  });

  // A folder that holds the same project id as a browser entry takes that entry's place.
  const folderIds = new Set(folderItems.map((item) => item.id));
  const browserItems = browserEntries.flatMap((entry): MergedProjectItem[] => {
    if (entry.trashedAt !== undefined || folderIds.has(entry.id)) return [];
    return [
      {
        key: `browser:${entry.id}`,
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt,
        source: 'browser',
      },
    ];
  });

  const items = [...folderItems, ...browserItems].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.title.localeCompare(b.title) ||
      a.key.localeCompare(b.key),
  );
  return { items, problems };
}
