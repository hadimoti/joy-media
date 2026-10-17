/* global process */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProjectStore } from '@joy-media/project-persistence/desktop';
import {
  migrateToLatest,
  migrateV0ToV1,
  validateJoyProjectV3,
  type JoyProjectV1,
  type JoyProjectV2,
  type JoyProjectV3,
  type SpikeProject,
} from '@joy-media/project-schema';
import { FlagValidationError } from './flags.js';
import { getDefaultSqlitePath } from './config.js';
import { logError } from './logger.js';

export { getDefaultSqlitePath };

export interface ProjectLoadResult {
  readonly project: CliProjectDocument;
  readonly revision: number;
  readonly source: 'sqlite' | 'file';
  readonly path: string;
}

/** Runtime project shape shared by the CLI's v1 editing operations and v1-v3 documents. */
export type CliProjectDocument = Omit<JoyProjectV1, 'schemaVersion'> & {
  readonly schemaVersion: 1 | 2 | 3;
};

export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly clipCount: number;
  readonly trackCount: number;
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Failures and machine-readable output
// ---------------------------------------------------------------------------

/**
 * A failure the user (or an AI agent) can act on. `exitCode` follows the CLI
 * contract: 1 = the command was well-formed but could not be carried out
 * (project not found, clip not found, conflict ...), 2 = the command line
 * itself is wrong (missing/unknown/contradictory arguments).
 *
 * `name` is deliberately left as "Error" so callers that still do
 * `String(err)` print the same text they always did.
 */
export class CommandFailure extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2;

  constructor(code: string, message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function usageFailure(message: string): CommandFailure {
  return new CommandFailure('USAGE', message, 2);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Print ONE compact JSON document on stdout (the `--json` contract). */
export function emitJson(doc: unknown): void {
  process.stdout.write(`${JSON.stringify(doc)}\n`);
}

/**
 * Report a failed command and return its exit code. Human diagnostics always go
 * to stderr; with `--json` stdout additionally carries a single
 * `{"type":"error","code":...,"message":...}` document so an agent can branch on
 * `code` instead of scraping prose.
 */
export function reportFailure(err: unknown, json: boolean, context: string): number {
  let code: string;
  let exitCode: 1 | 2;
  let message: string;
  if (err instanceof CommandFailure) {
    ({ code, exitCode, message } = err);
  } else if (err instanceof FlagValidationError) {
    code = 'USAGE';
    exitCode = 2;
    message = err.message;
  } else {
    code = 'UNEXPECTED';
    exitCode = 1;
    message = `Unexpected error (during "${context}"): ${errorMessage(err)}`;
  }
  logError(message);
  if (json) emitJson({ type: 'error', code, message });
  return exitCode;
}

// ---------------------------------------------------------------------------
// Small filesystem / concurrency primitives
// ---------------------------------------------------------------------------

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file so a crash or a full disk can never leave it half-written:
 * write a sibling temp file, then rename over the target.
 */
export function writeFileAtomic(path: string, data: string): void {
  removeOrphanedAtomicWriteTemps(path);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Remove only this target's atomic-write temps when their recorded writer is gone. */
function removeOrphanedAtomicWriteTemps(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    const identity = entry.slice(prefix.length, -'.tmp'.length).split('.');
    if (
      identity.length !== 2 ||
      !/^[1-9][0-9]*$/.test(identity[0]!) ||
      !/^[0-9a-f]{6}$/.test(identity[1]!)
    )
      continue;
    const pid = Number(identity[0]);
    if (!Number.isSafeInteger(pid) || isProcessAlive(pid)) continue;
    try {
      unlinkSync(join(directory, entry));
    } catch {
      // A read-only or concurrently replaced temp is not the new write's failure.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 30_000;
const heldLocks = new Set<string>();

/**
 * Serialise read-modify-write cycles from concurrent CLI processes (an agent
 * firing several `timeline` calls at once). The lock is a directory next to the
 * target (`mkdir` is atomic); a lock older than {@link LOCK_STALE_MS} belongs to
 * a process that was killed and is taken over. Re-entrant within one process.
 */
export function withExclusiveLock<T>(targetPath: string, run: () => T): T {
  const lockDir = `${targetPath}.lock`;
  if (heldLocks.has(lockDir)) return run();

  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Cannot lock here (missing/read-only folder): let the real operation
        // fail with its own, more precise error.
        return run();
      }
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // the holder released it between our calls: try again
      }
      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new CommandFailure(
          'LOCK_TIMEOUT',
          `Timed out waiting for another joy-media process to finish writing ${targetPath}. ` +
            `If no other joy-media command is running, delete the folder ${lockDir} and retry.`,
        );
      }
      sleepSync(15 + Math.floor(Math.random() * 35));
    }
  }

  heldLocks.add(lockDir);
  try {
    return run();
  } finally {
    heldLocks.delete(lockDir);
    try {
      rmdirSync(lockDir);
    } catch {
      /* already gone */
    }
  }
}

function isBusyError(err: unknown): boolean {
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(errorMessage(err));
}

function databaseFailure(err: unknown, dbPath: string): CommandFailure {
  if (err instanceof CommandFailure) return err;
  const message = errorMessage(err);
  if (
    (err as NodeJS.ErrnoException).code === 'SQLITE_FULL' ||
    /database or disk is full/i.test(message)
  ) {
    return new CommandFailure(
      'DATABASE_FULL',
      `The project database at ${dbPath} is full. Free disk space or choose another --sqlite-path, then retry.`,
    );
  }
  if (isBusyError(err)) {
    return new CommandFailure(
      'DATABASE_BUSY',
      `The project database at ${dbPath} is busy (another program is writing to it). Try again in a moment.`,
    );
  }
  if (/not a database|malformed|encrypted/i.test(message)) {
    return new CommandFailure(
      'DATABASE_CORRUPT',
      `The project database at ${dbPath} is corrupted or is not a SQLite file (${message}). ` +
        'It was not modified. Move it aside, or use --sqlite-path / JOY_MEDIA_SQLITE_PATH to point at another file.',
    );
  }
  if (/readonly database|read-only/i.test(message)) {
    return new CommandFailure(
      'DATABASE_READ_ONLY',
      `The project database at ${dbPath} is read-only, so nothing was written. Check the permissions of the file and its folder, or use --sqlite-path to choose another database.`,
    );
  }
  if (/unable to open database file/i.test(message)) {
    const folder = dirname(dbPath);
    return new CommandFailure(
      'DATABASE_UNAVAILABLE',
      existsSync(folder)
        ? `Cannot open the project database at ${dbPath}: the file or its folder is not readable and writable.`
        : `Cannot open the project database at ${dbPath}: the folder ${folder} does not exist and could not be created. Create it, make its parent writable, or choose another --sqlite-path.`,
    );
  }
  return new CommandFailure('DATABASE_ERROR', `Project database error at ${dbPath}: ${message}`);
}

/** Run a database operation: retry while another writer holds the lock, then explain any failure. */
function withDatabase<T>(dbPath: string, run: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (err) {
      if (isBusyError(err) && attempt < 60) {
        sleepSync(20 + Math.min(attempt * 10, 100));
        continue;
      }
      throw databaseFailure(err, dbPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function createDefaultProject(
  title: string,
  options?:
    | {
        id?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
        fps?: number | undefined;
      }
    | undefined,
): JoyProjectV1 {
  // The random suffix matters: two processes started in the same millisecond
  // (an agent creating projects in parallel) must not collide on one id and
  // silently overwrite each other.
  const id = options?.id ?? `proj-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const width = options?.width ?? 1080;
  const height = options?.height ?? 1920;
  const fps = options?.fps ?? 30;

  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    rootCompositionId: 'root',
    settings: {
      defaultLocale: 'en',
    },
    compositions: {
      root: {
        id: 'root',
        name: 'Main Composition',
        width,
        height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: fps, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            family: 'visual',
            name: 'Video 1',
            order: 0,
            enabled: true,
            locked: false,
            clips: [],
          },
          {
            id: 'track-v2',
            kind: 'video',
            family: 'visual',
            name: 'Video 2',
            order: 1,
            enabled: true,
            locked: false,
            clips: [],
          },
          {
            id: 'track-a1',
            kind: 'video',
            family: 'audio',
            name: 'Audio 1',
            order: 2,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}

export interface ProjectLocation {
  readonly source: 'sqlite' | 'file';
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a `<projectId|file.json>` argument lives, without reading it. */
export function locateProject(identifier: string, sqlitePath?: string): ProjectLocation {
  let isFile = identifier.toLowerCase().endsWith('.json');
  if (!isFile) {
    try {
      isFile = statSync(identifier).isFile();
    } catch {
      isFile = false;
    }
  }
  return isFile
    ? { source: 'file', path: identifier }
    : { source: 'sqlite', path: sqlitePath ?? getDefaultSqlitePath() };
}

/**
 * Pull the project out of any file shape the CLI reads: a bare project, an
 * `export` (`source`) or a saved file (`project`). Throws a clear failure for
 * anything that is not a project, instead of crashing later on `undefined`.
 */
export function extractProject(parsed: unknown, label: string): CliProjectDocument {
  const notAProject = (): CommandFailure =>
    new CommandFailure(
      'PROJECT_FILE_INVALID',
      `${label} is not a JOY Media project file (expected a project with id, rootCompositionId and compositions).`,
    );
  if (!isRecord(parsed)) throw notAProject();
  const candidate =
    isRecord(parsed.source) && parsed.source.rootCompositionId !== undefined
      ? parsed.source
      : isRecord(parsed.project) && parsed.project.rootCompositionId !== undefined
        ? parsed.project
        : parsed;
  const root =
    isRecord(candidate.compositions) && typeof candidate.rootCompositionId === 'string'
      ? candidate.compositions[candidate.rootCompositionId]
      : undefined;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id === '' ||
    !isRecord(root) ||
    !Array.isArray(root.tracks) ||
    !root.tracks.every((track) => isRecord(track) && Array.isArray(track.clips))
  ) {
    throw notAProject();
  }

  const schemaVersion = candidate.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new CommandFailure(
      'PROJECT_FILE_INVALID',
      `${label} is not a valid JOY Media project file (schemaVersion must be an integer).`,
    );
  }
  if (schemaVersion < 0 || schemaVersion > 3) {
    throw new CommandFailure(
      'PROJECT_SCHEMA_UNSUPPORTED',
      `${label} uses unsupported JOY Media project schema version ${schemaVersion}; this CLI supports versions 0 through 3.`,
    );
  }

  let project: JoyProjectV3;
  try {
    project =
      schemaVersion === 0
        ? migrateToLatest(migrateV0ToV1(candidate as unknown as SpikeProject).project)
        : migrateToLatest(candidate as unknown as JoyProjectV1 | JoyProjectV2 | JoyProjectV3);
  } catch (err) {
    if (err instanceof CommandFailure) throw err;
    throw new CommandFailure(
      'PROJECT_FILE_INVALID',
      `${label} could not be migrated safely (${errorMessage(err)}).`,
    );
  }
  const diagnostics = validateJoyProjectV3(project);
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    const location = first.path ? ` at ${first.path}` : '';
    throw new CommandFailure(
      'PROJECT_FILE_INVALID',
      `${label} is not a valid JOY Media project file${location} (${first.message}).`,
    );
  }
  return project as CliProjectDocument;
}

/** Read and parse a JSON file, with failures that name the file. */
export function readProjectJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommandFailure('PROJECT_NOT_FOUND', `Project file not found: ${path}`);
    }
    throw new CommandFailure('IO_ERROR', `Cannot read ${path}: ${errorMessage(err)}`);
  }
  try {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw new CommandFailure(
      'PROJECT_FILE_INVALID',
      `${path} is not valid JSON (${errorMessage(err)}).`,
    );
  }
}

export function loadProject(identifier: string, sqlitePath?: string): ProjectLoadResult {
  const location = locateProject(identifier, sqlitePath);

  if (location.source === 'file') {
    const parsed = readProjectJson(location.path);
    const revision =
      isRecord(parsed) && Number.isInteger(parsed.revision) && (parsed.revision as number) >= 0
        ? (parsed.revision as number)
        : 1;
    return {
      project: extractProject(parsed, location.path),
      revision,
      source: 'file',
      path: location.path,
    };
  }

  const dbPath = location.path;
  if (!existsSync(dbPath)) {
    throw new CommandFailure(
      'PROJECT_NOT_FOUND',
      `Project "${identifier}" not found: there is no project database yet at ${dbPath}. ` +
        'Create a project first with: joy-media project create "<name>"',
    );
  }

  return withDatabase(dbPath, () => {
    const store = new SqliteProjectStore<CliProjectDocument, unknown>(dbPath);
    try {
      let snapshots;
      try {
        snapshots = store.snapshots(identifier);
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new CommandFailure(
            'PROJECT_DATA_INVALID',
            `The stored data of project "${identifier}" in ${dbPath} is unreadable (${err.message}).`,
          );
        }
        throw err;
      }
      if (snapshots.length === 0) {
        throw new CommandFailure(
          'PROJECT_NOT_FOUND',
          `Project "${identifier}" not found in the project database at ${dbPath}. ` +
            'Run "joy-media project list" to see the available ids.',
        );
      }

      const latest = snapshots[snapshots.length - 1]!;
      return {
        project: extractProject(latest.payload, `The stored copy of project "${identifier}"`),
        revision: latest.revision,
        source: 'sqlite' as const,
        path: dbPath,
      };
    } finally {
      store.close();
    }
  });
}

/** Newest stored revision of a project in the SQLite database (0 when it has none). */
export function latestRevision(projectId: string, sqlitePath?: string): number {
  const dbPath = sqlitePath ?? getDefaultSqlitePath();
  if (!existsSync(dbPath)) return 0;
  return withDatabase(dbPath, () => {
    const store = new SqliteProjectStore<CliProjectDocument, unknown>(dbPath);
    try {
      return store.snapshots(projectId).at(-1)?.revision ?? 0;
    } finally {
      store.close();
    }
  });
}

export function saveProject(
  project: CliProjectDocument,
  target: { source: 'sqlite' | 'file'; path: string; revision: number },
): number {
  const nextRevision = target.revision + 1;
  const updatedProject = {
    ...project,
    updatedAt: new Date().toISOString(),
  };

  if (target.source === 'file') {
    const output = {
      format: 'joy-media-project',
      schemaVersion: 1,
      revision: nextRevision,
      exportedAt: new Date().toISOString(),
      id: updatedProject.id,
      title: updatedProject.title,
      project: updatedProject,
    };
    try {
      writeFileAtomic(target.path, JSON.stringify(output, null, 2));
    } catch (err) {
      throw new CommandFailure('IO_ERROR', `Cannot write ${target.path}: ${errorMessage(err)}`);
    }
    return nextRevision;
  }

  return withExclusiveLock(target.path, () =>
    withDatabase(target.path, () => {
      const store = new SqliteProjectStore<CliProjectDocument, unknown>(target.path);
      try {
        // Compare-and-swap: the caller read `target.revision`; if somebody else has
        // saved since, writing now would silently throw their work away.
        const head = store.snapshots(project.id).at(-1)?.revision ?? 0;
        if (head > target.revision) {
          throw new CommandFailure(
            'REVISION_CONFLICT',
            target.revision === 0
              ? `A project with id "${project.id}" already exists (revision ${head}); nothing was written.`
              : `Project "${project.id}" changed (now at revision ${head}) after it was read at revision ${target.revision}; nothing was written. Re-run the command.`,
          );
        }
        store.writeSnapshot(
          project.id,
          {
            revision: nextRevision,
            schemaVersion: updatedProject.schemaVersion,
            payload: updatedProject,
            checksum: `sha256-${Date.now().toString(16)}`,
          },
          10,
        );
        return nextRevision;
      } finally {
        store.close();
      }
    }),
  );
}

/**
 * Latest revision of every stored project, ordered by id. Rows whose stored data
 * cannot be read are left out of the result and reported through `onSkipped`
 * (so a broken project is never silently invisible).
 */
export function listProjects(
  sqlitePath?: string,
  onSkipped?: (projectId: string, reason: string) => void,
): ProjectSummary[] {
  const dbPath = sqlitePath ?? getDefaultSqlitePath();
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      // Ensure tables exist
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
        .get();
      if (!tableCheck) return [];

      const rows = db
        .prepare(
          `SELECT project_id, revision, payload, schema_version
           FROM snapshots
           WHERE (project_id, revision) IN (
             SELECT project_id, MAX(revision) FROM snapshots GROUP BY project_id
           )
           ORDER BY project_id ASC`,
        )
        .all() as Array<{
        project_id: string;
        revision: number;
        payload: string;
        schema_version: number;
      }>;

      const result: ProjectSummary[] = [];

      for (const row of rows) {
        try {
          const project = JSON.parse(row.payload) as CliProjectDocument;
          const root = project.compositions?.[project.rootCompositionId];
          let clipCount = 0;
          let trackCount = 0;
          let durationUs = 0;

          if (root) {
            trackCount = root.tracks?.length ?? 0;
            durationUs = root.durationUs ?? 0;
            for (const track of root.tracks ?? []) {
              clipCount += track.clips?.length ?? 0;
            }
          }

          result.push({
            id: row.project_id,
            title: project.title ?? row.project_id,
            revision: row.revision,
            updatedAt: project.updatedAt ?? new Date().toISOString(),
            clipCount,
            trackCount,
            durationSeconds: Math.round(durationUs / 1_000_000),
          });
        } catch (err) {
          onSkipped?.(row.project_id, errorMessage(err));
        }
      }

      return result;
    } finally {
      db.close();
    }
  });
}
