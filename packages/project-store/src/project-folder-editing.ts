import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  importProjectAsset,
  projectAssetPath,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
} from './project-folder.js';

/**
 * Editing an open project folder: the saved project, and the media kept inside it. The folder must
 * come from `openProjectFolderForEditing` (project-folder-identity.ts), so its id is settled before
 * anything here reads or writes it. Nothing here opens a folder by path.
 *
 * The folder keeps one saved project: one row in `project_documents`, named by the folder's id. A
 * copy that got a new id still holds the row of its old id until its first save, so the read takes
 * the newest row, whatever id it names, and the save removes rows of any other id.
 */

/** The largest piece of a stored original one read returns. */
export const PROJECT_MEDIA_CHUNK_BYTES = 16 * 1024 * 1024;

/** The saved project in a folder, as it was last written. */
export interface ProjectFolderDocument {
  /** The id the saved row names. It differs from the folder's id only for a copy not saved since it got a new id. */
  readonly projectId: string;
  readonly revisionId: string;
  readonly document: unknown;
}

/** One media file the editor names in a save. `sourcePath` is set by the desktop main process only. */
export interface ProjectFolderMediaSave {
  readonly assetId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly sha256?: string;
  /** Where the desktop keeps the original now. Never sent by the renderer. */
  readonly sourcePath?: string;
}

export interface ProjectFolderSave {
  readonly projectId: string;
  /** The revision this save was built on: the empty string when the folder has no saved row for this id. */
  readonly baseRevisionId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly document: unknown;
  readonly media: readonly ProjectFolderMediaSave[];
}

export type ProjectFolderSaveResult =
  | {
      readonly kind: 'saved';
      readonly revisionId: string;
      /** Media that is not inside the folder after this save, by asset id. */
      readonly notStored: readonly string[];
    }
  | { readonly kind: 'conflict'; readonly revisionId: string }
  | { readonly kind: 'wrong-project' };

/** What the folder holds for one asset id. */
export interface ProjectFolderMediaState {
  readonly assetId: string;
  readonly present: boolean;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly displayName?: string;
}

export interface ProjectFolderMediaChunk {
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly total: number;
}

/** The newest saved row in the folder, or `undefined` when the project was never saved there. */
export function readProjectFolderDocument(
  folder: ProjectFolder,
): ProjectFolderDocument | undefined {
  const row = folder.database
    .prepare(
      'SELECT project_id FROM project_documents ORDER BY updated_at DESC, rowid DESC LIMIT 1',
    )
    .get() as { project_id: string } | undefined;
  if (row === undefined) return undefined;
  const stored = folder.documents.get(row.project_id);
  if (stored === undefined) return undefined;
  return { projectId: stored.projectId, revisionId: stored.revisionId, document: stored.document };
}

/**
 * Saves the project into the folder: its media first, then the document, then the entry's title and
 * time. A save for another id than the folder's is refused, so a stale editor
 * cannot write over a folder that changed id. Media already inside the folder is kept as it is. Media
 * with no original the desktop can read is named in `notStored`, and the save still lands.
 */
export async function saveProjectFolder(
  folder: ProjectFolder,
  save: ProjectFolderSave,
  now: () => string = () => new Date().toISOString(),
): Promise<ProjectFolderSaveResult> {
  const entry = readProjectFolderEntry(folder);
  if (entry === undefined || entry.id !== save.projectId) return { kind: 'wrong-project' };

  const notStored: string[] = [];
  for (const media of uniqueMedia(save.media)) {
    if (projectAssetPath(folder, media.assetId) !== undefined) continue;
    if (media.sourcePath === undefined) {
      notStored.push(media.assetId);
      continue;
    }
    try {
      const imported = await importProjectAsset(folder, {
        path: media.sourcePath,
        kind: media.kind,
        displayName: media.displayName,
        assetId: media.assetId,
        ...(media.sha256 === undefined ? {} : { expectedSha256: media.sha256 }),
      });
      if (imported.assetId !== media.assetId) notStored.push(media.assetId);
    } catch {
      notStored.push(media.assetId);
    }
  }

  // The document store runs its own transaction, so the document lands first. The entry and the cleanup follow in a
  // second one: if that fails, the saved document is still the newest row, and the next save tidies up.
  const result = folder.documents.put({
    projectId: save.projectId,
    baseRevisionId: save.baseRevisionId,
    revisionId: save.revisionId,
    document: save.document,
  });
  if (result.kind === 'conflict') return { kind: 'conflict', revisionId: result.revisionId };
  if (result.kind === 'missing') return { kind: 'conflict', revisionId: '' };
  folder.database.exec('BEGIN IMMEDIATE');
  try {
    // A copy's row under its old id is replaced by this one, so the folder keeps one saved project.
    folder.database
      .prepare('DELETE FROM project_documents WHERE project_id <> ?')
      .run(save.projectId);
    const title = save.title.trim();
    writeProjectFolderEntry(folder, {
      ...entry,
      ...(title === '' ? {} : { title }),
      updatedAt: now(),
    });
    folder.database.exec('COMMIT');
  } catch (error) {
    try {
      folder.database.exec('ROLLBACK');
    } catch {
      // The transaction is already gone. The first error is the one to report.
    }
    throw error;
  }
  return { kind: 'saved', revisionId: result.revisionId, notStored };
}

/** Whether each asset is inside the folder, with what its index says about it. */
export function projectFolderMediaStates(
  folder: ProjectFolder,
  assetIds: readonly string[],
): ProjectFolderMediaState[] {
  return [...new Set(assetIds)].map((assetId) => {
    const asset = folder.assets.get(assetId);
    const present = projectAssetPath(folder, assetId) !== undefined;
    if (asset === undefined) return { assetId, present };
    return {
      assetId,
      present,
      bytes: asset.bytes,
      sha256: asset.sha256,
      displayName: asset.displayName,
    };
  });
}

/** One piece of a stored original, from `offset`. `undefined` when the folder does not hold it. */
export async function readProjectFolderMedia(
  folder: ProjectFolder,
  assetId: string,
  offset: number,
  length: number = PROJECT_MEDIA_CHUNK_BYTES,
): Promise<ProjectFolderMediaChunk | undefined> {
  const path = projectAssetPath(folder, assetId);
  if (path === undefined) return undefined;
  const total = (await stat(path)).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) return undefined;
  const size = Math.max(0, Math.min(length, PROJECT_MEDIA_CHUNK_BYTES, total - offset));
  if (size === 0) return { bytes: new Uint8Array(0), offset, total };
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start: offset, end: offset + size - 1 })) {
    chunks.push(chunk as Buffer);
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), offset, total };
}

function uniqueMedia(media: readonly ProjectFolderMediaSave[]): ProjectFolderMediaSave[] {
  const seen = new Map<string, ProjectFolderMediaSave>();
  for (const item of media) if (!seen.has(item.assetId)) seen.set(item.assetId, item);
  return [...seen.values()];
}
