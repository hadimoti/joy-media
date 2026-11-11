import type { ProjectCatalogEntry } from './project-catalog.js';
import type {
  ProjectFolderEntryView,
  ProjectFolderListedItem,
  ProjectFolderProblem,
} from './project-folder-client.js';
import { mergeProjectList, type FolderProjectListing } from './project-list-merge.js';

/**
 * The rows of the project list when folder projects are shown too (owner decision, 10 Nov 2026: one merged list).
 * The merge itself is project-list-merge.ts: trashed projects are hidden, and a folder takes the place of a browser
 * entry with the same id. This module adds the list's search and sort, and keeps each row's source for the page.
 */

export type ProjectListSort = 'updated-desc' | 'created-desc' | 'name-asc' | 'name-desc';

export interface FolderProjectRow {
  readonly key: string;
  readonly name: string;
  readonly entry: ProjectFolderEntryView;
}

/**
 * A folder with no project entry. It has no title or dates, so it is shown by its name. The owner opens it to check
 * whether the app remembers it, which leads to the restore question when the registry does.
 */
export interface FolderMissingEntryRow {
  readonly key: string;
  readonly name: string;
}

export type ProjectListRow =
  | { readonly kind: 'browser'; readonly entry: ProjectCatalogEntry }
  | { readonly kind: 'folder'; readonly folder: FolderProjectRow }
  | { readonly kind: 'folder-missing-entry'; readonly folder: FolderMissingEntryRow };

export interface ProjectListRows {
  readonly rows: readonly ProjectListRow[];
  /** Folders the list could not read, so the page can say which ones and why. */
  readonly problems: readonly { readonly name: string; readonly problem: ProjectFolderProblem }[];
}

export function projectListRows(input: {
  readonly browser: readonly ProjectCatalogEntry[];
  readonly folders: readonly ProjectFolderListedItem[];
  readonly query: string;
  readonly sort: ProjectListSort;
}): ProjectListRows {
  const listings: FolderProjectListing[] = input.folders.map((folder) => ({
    root: folder.key,
    ...(folder.entry === undefined ? {} : { entry: folder.entry }),
    ...(folder.problem === undefined ? {} : { problem: folder.problem }),
  }));
  const merged = mergeProjectList(input.browser, listings);

  const browserById = new Map(input.browser.map((entry) => [entry.id, entry] as const));
  const foldersByKey = new Map(input.folders.map((folder) => [folder.key, folder] as const));
  const rows: ProjectListRow[] = [];
  for (const item of merged.items) {
    if (item.source === 'browser') {
      const entry = browserById.get(item.id);
      if (entry !== undefined) rows.push({ kind: 'browser', entry });
      continue;
    }
    const folder = item.folderRoot === undefined ? undefined : foldersByKey.get(item.folderRoot);
    if (folder?.entry !== undefined) {
      rows.push({
        kind: 'folder',
        folder: { key: folder.key, name: folder.name, entry: folder.entry },
      });
    }
  }

  // A folder with no entry has no project to show, but the owner can open it: that is the route to the restore question.
  for (const folder of input.folders) {
    if (folder.entry === undefined && folder.problem === 'no-entry') {
      rows.push({ kind: 'folder-missing-entry', folder: { key: folder.key, name: folder.name } });
    }
  }

  const query = input.query.trim().toLocaleLowerCase();
  const matching = rows.filter(
    (row) => query === '' || titleOf(row).toLocaleLowerCase().includes(query),
  );
  matching.sort(comparatorFor(input.sort));

  const problems = merged.problems.flatMap((problem) => {
    const folder = foldersByKey.get(problem.root);
    const code = folder?.problem;
    // A folder with no entry has a row of its own, so the notice does not repeat it.
    if (folder === undefined || code === undefined || code === 'no-entry') return [];
    return [{ name: folder.name, problem: code }];
  });
  return { rows: matching, problems };
}

function titleOf(row: ProjectListRow): string {
  if (row.kind === 'browser') return row.entry.title;
  return row.kind === 'folder' ? row.folder.entry.title : row.folder.name;
}

// A folder with no entry has no dates, so it sorts last on a date.
function createdOf(row: ProjectListRow): string {
  if (row.kind === 'browser') return row.entry.createdAt;
  return row.kind === 'folder' ? row.folder.entry.createdAt : '';
}

function updatedOf(row: ProjectListRow): string {
  if (row.kind === 'browser') return row.entry.updatedAt;
  return row.kind === 'folder' ? row.folder.entry.updatedAt : '';
}

function comparatorFor(
  sort: ProjectListSort,
): (left: ProjectListRow, right: ProjectListRow) => number {
  switch (sort) {
    case 'name-asc':
      return (left, right) => titleOf(left).localeCompare(titleOf(right));
    case 'name-desc':
      return (left, right) => titleOf(right).localeCompare(titleOf(left));
    case 'created-desc':
      return (left, right) => createdOf(right).localeCompare(createdOf(left));
    case 'updated-desc':
      return (left, right) => updatedOf(right).localeCompare(updatedOf(left));
  }
}
