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
  const entry = readProjectFolderEntry(folder);
  if (entry === undefined) return { kind: 'none' };
  const root = resolve(folder.root);
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
 * Moves the folder to a new id in one transaction: the entry, the document key, and the top-level
 * `id` of the stored document and look instances. The revision is not changed.
 */
function renewIdentity(
  folder: ProjectFolder,
  entry: ProjectFolderEntry,
  id: string,
  root: string,
): void {
  const previousId = entry.id;
  folder.database.exec('BEGIN IMMEDIATE');
  try {
    writeProjectFolderEntry(folder, {
      ...entry,
      id,
      timelineProjectId: id,
      visualProjectId: id,
      homeRoot: root,
    });
    const row = folder.database
      .prepare(
        'SELECT document_json, look_instances_json FROM project_documents WHERE project_id = ?',
      )
      .get(previousId) as
      { readonly document_json: string; readonly look_instances_json: string | null } | undefined;
    if (row !== undefined) {
      const document = withId(JSON.parse(row.document_json) as unknown, previousId, id);
      const lookInstances =
        row.look_instances_json === null
          ? null
          : JSON.stringify(withId(JSON.parse(row.look_instances_json) as unknown, previousId, id));
      folder.database
        .prepare(
          'UPDATE project_documents SET project_id = ?, document_json = ?, look_instances_json = ? WHERE project_id = ?',
        )
        .run(id, JSON.stringify(document), lookInstances, previousId);
    }
    folder.database.exec('COMMIT');
  } catch (error) {
    folder.database.exec('ROLLBACK');
    throw error;
  }
}

/** Replaces a top-level `id` that names the previous project. Nothing else is touched. */
function withId(value: unknown, previousId: string, id: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record['id'] === previousId ? { ...record, id } : value;
}
