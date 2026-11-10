import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
  type ProjectFolderEntry,
  type ProjectFolderListing,
} from './project-folder.js';

/**
 * New id on open (owner decision, 10 Nov 2026). A project folder created in place keeps its
 * project id. A copy of it arrives with the same id, so when the copy is opened it gets a new id,
 * and one id never names two projects. When no other folder holds the id as its home, for example
 * after the original was moved, the opened folder claims the id and keeps it.
 *
 * The decision and its write run in one write transaction on the folder's own database. A second
 * open of the same folder waits for the first, then reads what the first one wrote.
 */

export type ProjectFolderClaim =
  | { readonly kind: 'none' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'renewed'; readonly previousId: string; readonly id: string };

/**
 * Settles the id of a folder that has just been opened. `siblings` is a listing of the folder's
 * parent directory, so the other folders with the same id can be seen.
 */
export function claimProjectFolderId(
  folder: ProjectFolder,
  siblings: readonly ProjectFolderListing[],
  createId: () => string = newProjectId,
): ProjectFolderClaim {
  const root = resolve(folder.root);
  folder.database.exec('BEGIN IMMEDIATE');
  try {
    const claim = settleClaim(folder, root, siblings, createId);
    folder.database.exec('COMMIT');
    return claim;
  } catch (error) {
    folder.database.exec('ROLLBACK');
    throw error;
  }
}

function settleClaim(
  folder: ProjectFolder,
  root: string,
  siblings: readonly ProjectFolderListing[],
  createId: () => string,
): ProjectFolderClaim {
  // Read inside the transaction. A read taken before it could be stale when the write happens.
  const entry = readProjectFolderEntry(folder);
  if (entry === undefined) return { kind: 'none' };
  if (isHomeAt(entry, root)) return { kind: 'kept' };

  const holdersOfId = siblings.filter(
    (item) => item.entry !== undefined && item.entry.id === entry.id && resolve(item.root) !== root,
  );
  const originalExists = holdersOfId.some(
    (item) => item.entry !== undefined && isHomeAt(item.entry, resolve(item.root)),
  );
  if (originalExists) {
    const id = createId();
    renewIdentity(folder, entry, id, root);
    return { kind: 'renewed', previousId: entry.id, id };
  }
  writeProjectFolderEntry(folder, { ...entry, homeRoot: root });
  return { kind: 'claimed' };
}

function newProjectId(): string {
  return `project-${randomUUID()}`;
}

function isHomeAt(entry: ProjectFolderEntry, root: string): boolean {
  return entry.homeRoot !== undefined && resolve(entry.homeRoot) === root;
}

/**
 * Moves the folder to a new id: the entry, the document key, and the top-level `id` of the stored
 * document and look instances. The revision is not changed. The caller holds the transaction.
 */
function renewIdentity(
  folder: ProjectFolder,
  entry: ProjectFolderEntry,
  id: string,
  root: string,
): void {
  const previousId = entry.id;
  writeProjectFolderEntry(folder, {
    ...entry,
    id,
    timelineProjectId: entry.timelineProjectId === previousId ? id : entry.timelineProjectId,
    visualProjectId: entry.visualProjectId === previousId ? id : entry.visualProjectId,
    homeRoot: root,
  });
  const row = folder.database
    .prepare(
      'SELECT document_json, look_instances_json FROM project_documents WHERE project_id = ?',
    )
    .get(previousId) as
    { readonly document_json: string; readonly look_instances_json: string | null } | undefined;
  if (row === undefined) return;
  const document = renameIds(JSON.parse(row.document_json) as unknown, previousId, id);
  const lookInstances =
    row.look_instances_json === null
      ? null
      : JSON.stringify(renameIds(JSON.parse(row.look_instances_json) as unknown, previousId, id));
  folder.database
    .prepare(
      'UPDATE project_documents SET project_id = ?, document_json = ?, look_instances_json = ? WHERE project_id = ?',
    )
    .run(id, JSON.stringify(document), lookInstances, previousId);
}

/**
 * Replaces the old id wherever it stands alone: as a whole value, or as a whole object key, at any
 * depth. Text that only contains it is left alone.
 */
function renameIds(value: unknown, previousId: string, id: string): unknown {
  if (value === previousId) return id;
  if (Array.isArray(value)) return value.map((item) => renameIds(item, previousId, id));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key === previousId ? id : key,
        renameIds(item, previousId, id),
      ]),
    );
  }
  return value;
}
