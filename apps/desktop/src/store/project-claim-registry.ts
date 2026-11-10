import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The machine-local record of which folder holds each project id (owner decision, 10 Nov 2026:
 * everything stays local). A copy of a project folder carries the same id as the original, and
 * nothing inside the folders says which one is the original. This record says it, by the folder's
 * identity on its volume and the path it was last seen at. It lives in the app's data folder,
 * outside every project. One row per id; a claim on the same id replaces the row.
 *
 * Losing this file does not lose any project. A folder with no record asks the owner instead of
 * guessing (see project-folder-identity.ts).
 */

export interface ProjectClaim {
  readonly projectId: string;
  /** The folder's identity on its volume, as `identityFromStats` builds it. */
  readonly folderIdentity: string;
  /** The path the folder was last seen at. */
  readonly folderPath: string;
  /** When this record was written (ISO 8601). */
  readonly recordedAt: string;
}

export interface ProjectClaimRegistry {
  readonly database: DatabaseSync;
  close(): void;
}

/** How long a claim waits for each lock before it gives up with a busy error. */
export const CLAIM_WAIT_MS = 500;

const CLAIMS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS project_claims (
  project_id TEXT PRIMARY KEY,
  folder_identity TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  recorded_at TEXT NOT NULL
)`;

/** Opens the registry file, creating it and its folder when they do not exist yet. */
export function openProjectClaimRegistry(filePath: string): ProjectClaimRegistry {
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    // A claim waits at most CLAIM_WAIT_MS for the lock, so it never holds the UI thread for long.
    database.exec(`PRAGMA busy_timeout = ${CLAIM_WAIT_MS}`);
    database.exec(CLAIMS_TABLE_SQL);
  } catch (error) {
    database.close();
    throw error;
  }
  return { database, close: () => database.close() };
}

/** The claim recorded for a project id, or `undefined` when none was recorded. */
export function readProjectClaim(
  registry: ProjectClaimRegistry,
  projectId: string,
): ProjectClaim | undefined {
  const row = registry.database
    .prepare(
      'SELECT folder_identity, folder_path, recorded_at FROM project_claims WHERE project_id = ?',
    )
    .get(projectId) as
    { folder_identity: string; folder_path: string; recorded_at: string } | undefined;
  if (row === undefined) return undefined;
  return {
    projectId,
    folderIdentity: row.folder_identity,
    folderPath: row.folder_path,
    recordedAt: row.recorded_at,
  };
}

/** Records the folder that holds a project id, replacing any earlier record for that id. */
export function writeProjectClaim(registry: ProjectClaimRegistry, claim: ProjectClaim): void {
  registry.database
    .prepare(
      `INSERT INTO project_claims (project_id, folder_identity, folder_path, recorded_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         folder_identity = excluded.folder_identity,
         folder_path = excluded.folder_path,
         recorded_at = excluded.recorded_at`,
    )
    .run(claim.projectId, claim.folderIdentity, claim.folderPath, claim.recordedAt);
}
