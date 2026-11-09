import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { MAX_LOCAL_ORIGINAL_BYTES } from '../main/local-originals.js';
import { ensureLocalAssetSchema, SqliteLocalAssetStore } from './local-assets.js';
import { ensureProjectDocumentSchema, SqliteProjectDocumentStore } from './project-documents.js';

/**
 * A project folder (`NAME.joyproj`): the project's document, its asset index and its original
 * media in one directory, so copying the folder copies the project. This is design B from the
 * v1.2 model review: `project.sqlite`, `assets/<sha256>.bin` and a rebuildable `cache/`.
 *
 * The folder also holds the project's catalog entry, so the merged project list can show it. The
 * folder is not wired into the editor or the IPC channels yet.
 */

export const PROJECT_FOLDER_SUFFIX = '.joyproj';
export const PROJECT_DATABASE_FILE = 'project.sqlite';
export const PROJECT_ASSETS_DIRECTORY = 'assets';
export const PROJECT_CACHE_DIRECTORY = 'cache';

/** The only shape a stored original path may take: relative, inside `assets/`, named by checksum. */
const STORED_PATH_PATTERN = /^assets\/[a-f0-9]{64}\.bin$/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const DEFAULT_TITLE_LENGTH = 80;

export interface ProjectFolder {
  /** The `NAME.joyproj` directory. */
  readonly root: string;
  /** The folder's own database: the document and the asset index. */
  readonly database: DatabaseSync;
  readonly assets: SqliteLocalAssetStore;
  readonly documents: SqliteProjectDocumentStore;
  close(): void;
}

export interface ProjectAssetSource {
  readonly path: string;
  readonly kind: string;
  readonly displayName: string;
}

export interface ProjectAssetImport {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Relative to the folder root, for example `assets/<sha256>.bin`. */
  readonly storedPath: string;
  /** The name kept for this checksum in this project: the first one imported. */
  readonly displayName: string;
}

/** The project's catalog entry, shaped like the browser project list's entry. One per folder. */
export interface ProjectFolderEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timelineProjectId: string;
  readonly visualProjectId: string;
  readonly trashedAt?: string;
}

/** One `NAME.joyproj` folder as the listing found it: its entry, or why it has none. */
export interface ProjectFolderListing {
  readonly root: string;
  readonly entry?: ProjectFolderEntry;
  readonly problem?: string;
}

const ENTRY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS project_folder_entry (
   id INTEGER PRIMARY KEY CHECK (id = 1),
   entry_json TEXT NOT NULL
 )`;

const ENTRY_TEXT_FIELDS = [
  'id',
  'title',
  'createdAt',
  'updatedAt',
  'timelineProjectId',
  'visualProjectId',
] as const;

const defaultNow = (): string => new Date().toISOString();

/**
 * A safe folder name from a project title: no path separators or Windows-forbidden characters,
 * no trailing dot or space, never a reserved device name. An empty title becomes `Project`.
 */
export function projectFolderName(title: string): string {
  const safe = Array.from(title, (char) =>
    char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char,
  ).join('');
  const trimmed = safe
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, DEFAULT_TITLE_LENGTH)
    .trim();
  const base = trimmed === '' ? 'Project' : trimmed;
  const guarded = RESERVED_WINDOWS_NAME.test(base) ? `_${base}` : base;
  return `${guarded}${PROJECT_FOLDER_SUFFIX}`;
}

/**
 * Creates `NAME.joyproj` under `parentDirectory`, with `project.sqlite`, `assets/` and `cache/`.
 * An existing folder with the same name is refused, never overwritten.
 */
export async function createProjectFolder(
  parentDirectory: string,
  title: string,
  now: () => string = defaultNow,
): Promise<ProjectFolder> {
  await mkdir(parentDirectory, { recursive: true });
  const root = join(parentDirectory, projectFolderName(title));
  try {
    // Without `recursive`, mkdir fails when the folder already exists.
    await mkdir(root);
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      throw new Error('A project folder with that name already exists');
    }
    throw error;
  }
  await mkdir(join(root, PROJECT_ASSETS_DIRECTORY));
  await mkdir(join(root, PROJECT_CACHE_DIRECTORY));
  return attachProjectFolder(root, now);
}

/**
 * Opens an existing project folder. A missing `cache/` is recreated, since it is rebuildable and
 * the project does not depend on it. A missing `project.sqlite` or `assets/` is refused.
 */
export async function openProjectFolder(
  root: string,
  now: () => string = defaultNow,
): Promise<ProjectFolder> {
  const databasePath = join(root, PROJECT_DATABASE_FILE);
  if (!existsSync(databasePath)) {
    throw new Error('Not a project folder: project.sqlite is missing');
  }
  if (!(await isDirectory(join(root, PROJECT_ASSETS_DIRECTORY)))) {
    throw new Error('Not a project folder: assets/ is missing');
  }
  return attachProjectFolder(root, now);
}

async function attachProjectFolder(root: string, now: () => string): Promise<ProjectFolder> {
  await mkdir(join(root, PROJECT_CACHE_DIRECTORY), { recursive: true });

  const database = new DatabaseSync(join(root, PROJECT_DATABASE_FILE));
  try {
    ensureLocalAssetSchema(database);
    ensureProjectDocumentSchema(database);
    database.exec(ENTRY_TABLE_SQL);
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    root,
    database,
    assets: new SqliteLocalAssetStore(database, now),
    documents: new SqliteProjectDocumentStore(database, now),
    close: () => database.close(),
  };
}

/**
 * Copies one original into the folder. The bytes are hashed while they are copied, written under a
 * temporary name, and renamed to `assets/<sha256>.bin`. A checksum already stored is kept, so a
 * project holds one file per checksum, and its index keeps the first display name for it.
 */
export async function importProjectAsset(
  folder: ProjectFolder,
  source: ProjectAssetSource,
): Promise<ProjectAssetImport> {
  const size = (await stat(source.path)).size;
  if (size > MAX_LOCAL_ORIGINAL_BYTES) {
    throw new Error('The original is larger than the 5 GiB local limit');
  }

  const assetsDirectory = join(folder.root, PROJECT_ASSETS_DIRECTORY);
  const partial = join(assetsDirectory, `.import-${randomUUID()}.partial`);
  let copied: { sha256: string; bytes: number };
  try {
    copied = await copyAndHash(source.path, partial);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }

  const fileName = `${copied.sha256}.bin`;
  const target = join(assetsDirectory, fileName);
  if (await pathExists(target)) {
    // The same bytes are already stored. Keep that file and drop the copy. Replacing a stored
    // file that may be open elsewhere fails on Windows, so it is never renamed over.
    await unlink(partial);
    const storedBytes = (await stat(target)).size;
    if (storedBytes !== copied.bytes) {
      throw new Error(`The stored original ${fileName} does not match its checksum`);
    }
  } else {
    await rename(partial, target);
  }

  const assetId = `asset-${copied.sha256}`;
  const storedPath = `${PROJECT_ASSETS_DIRECTORY}/${fileName}`;
  folder.database.exec('BEGIN IMMEDIATE');
  try {
    const registered = folder.assets.register({
      id: assetId,
      kind: source.kind,
      displayName: source.displayName,
      sha256: copied.sha256,
      bytes: copied.bytes,
    });
    if (registered.kind === 'conflict') {
      throw new Error(`Asset ${assetId} is already registered with other content`);
    }
    folder.assets.markStored(assetId, storedPath);
    folder.database.exec('COMMIT');
  } catch (error) {
    folder.database.exec('ROLLBACK');
    throw error;
  }

  return {
    assetId,
    sha256: copied.sha256,
    bytes: copied.bytes,
    storedPath,
    displayName: folder.assets.get(assetId)?.displayName ?? source.displayName,
  };
}

/**
 * The absolute path of a stored original, or `undefined` when the index has none, the stored path
 * is not in the expected shape, or the file is gone.
 */
export function projectAssetPath(folder: ProjectFolder, assetId: string): string | undefined {
  const storedPath = folder.assets.storedPath(assetId);
  if (storedPath === undefined || !STORED_PATH_PATTERN.test(storedPath)) return undefined;
  const absolute = join(folder.root, ...storedPath.split('/'));
  return existsSync(absolute) ? absolute : undefined;
}

/** Stores the project's catalog entry in the folder, replacing the one already there. */
export function writeProjectFolderEntry(folder: ProjectFolder, entry: ProjectFolderEntry): void {
  folder.database
    .prepare(
      `INSERT INTO project_folder_entry (id, entry_json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET entry_json = excluded.entry_json`,
    )
    .run(JSON.stringify(entry));
}

/** The folder's catalog entry, or `undefined` when none was written yet. */
export function readProjectFolderEntry(folder: ProjectFolder): ProjectFolderEntry | undefined {
  return readEntryFrom(folder.database);
}

/**
 * Lists the `NAME.joyproj` folders in `directory`, each with its catalog entry. It only reads: it
 * does not create a cache, change the schema or write. A broken folder is reported as a problem,
 * not thrown, so one bad folder does not hide the others.
 */
export async function listProjectFolders(directory: string): Promise<ProjectFolderListing[]> {
  let names: string[];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    names = entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(PROJECT_FOLDER_SUFFIX),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return [];
    throw error;
  }
  return names.map((name) => readListing(join(directory, name)));
}

function readListing(root: string): ProjectFolderListing {
  const databasePath = join(root, PROJECT_DATABASE_FILE);
  if (!existsSync(databasePath)) return { root, problem: 'project.sqlite is missing' };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    const entry = readEntryFrom(database);
    return entry === undefined ? { root, problem: 'no catalog entry' } : { root, entry };
  } catch (error) {
    return { root, problem: error instanceof Error ? error.message : 'unreadable project folder' };
  } finally {
    database?.close();
  }
}

function readEntryFrom(database: DatabaseSync): ProjectFolderEntry | undefined {
  const row = database.prepare('SELECT entry_json FROM project_folder_entry WHERE id = 1').get() as
    { entry_json: string } | undefined;
  if (row === undefined) return undefined;
  const parsed: unknown = JSON.parse(row.entry_json);
  if (!isProjectFolderEntry(parsed)) {
    throw new Error('The project folder entry is malformed');
  }
  return parsed;
}

function isProjectFolderEntry(value: unknown): value is ProjectFolderEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    ENTRY_TEXT_FIELDS.every((field) => typeof candidate[field] === 'string') &&
    (candidate['trashedAt'] === undefined || typeof candidate['trashedAt'] === 'string')
  );
}

async function copyAndHash(from: string, to: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    createReadStream(from),
    async function* hashChunks(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.length;
        if (bytes > MAX_LOCAL_ORIGINAL_BYTES) {
          throw new Error('The original is larger than the 5 GiB local limit');
        }
        yield chunk;
      }
    },
    createWriteStream(to, { flags: 'wx' }),
  );
  return { sha256: hash.digest('hex'), bytes };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
