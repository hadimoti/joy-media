import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CLAIM_WAIT_MS,
  readProjectClaim,
  writeProjectClaim,
  type ProjectClaim,
  type ProjectClaimRegistry,
} from './project-claim-registry.js';
import {
  PROJECT_FOLDER_BUSY_WAIT_MS,
  openProjectFolder,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
  type ProjectFolderEntry,
} from './project-folder.js';

/**
 * New id on open (owner decision, 10 Nov 2026). A project folder keeps its project id. A copy of it
 * arrives with the same id, so the copy gets a new id when it is opened, and one id never names two
 * projects.
 *
 * Which folder is the original is recorded in the machine-local claim registry, by the folder's
 * identity on its volume. A move on the same drive keeps the identity; a copy gets a new one. A
 * folder is recorded under its real path when it is made (`recordNewProjectFolder`). A path that
 * names the same folder through a junction, subst or mapped drive is the same place: places are
 * compared by real path. So, on open:
 * - the recorded identity is this folder's, at the recorded place: it is the original (`kept`);
 * - the recorded identity is this folder's, but the recorded place is gone: this folder was moved, so
 *   it is the original and the record follows it (`kept`);
 * - the recorded identity is this folder's, and the recorded place still holds it: a clone of the
 *   original exists, so the owner decides which of the two is the original (`ask`, `duplicate-identity`);
 * - another folder is the recorded original, and that original is still where it was recorded:
 *   this folder is a copy and gets a new id (`renewed`);
 * - otherwise the owner must say which folder is which (`ask`): a folder with no record, which is
 *   what a lost registry looks like, or a recorded original that is no longer where it was recorded.
 *   The claim writes nothing for an `ask`.
 * A folder whose real path cannot be read, a folder or a recorded place that cannot be read at all,
 * and a recorded place whose drive is not mounted are `unverifiable`, never a guess.
 *
 * The app opens a project for editing only through `openProjectFolderForEditing`. It settles the id
 * first, so an editable folder never carries an id that has not been settled. The owner's answer to
 * an ask goes through `answerProjectFolderAsk`, which never hands out an editable folder.
 *
 * Every claim takes the registry's write lock first, then the folder's, each in one transaction, and
 * commits the registry first. Each of the four lock steps (the two begins and the two commits) waits at
 * most CLAIM_WAIT_MS. Once a claim holds the registry's lock, it keeps that lock through two of those
 * waits and its work. A claim that cannot get a lock throws ProjectClaimBusyError. It writes nothing when
 * it fails before the registry commit. A folder commit that fails after the registry commit leaves the
 * registry record that was committed (see inClaimTransactions).
 */

export type ProjectFolderClaim =
  | { readonly kind: 'none' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'renewed'; readonly previousId: string; readonly id: string }
  | { readonly kind: 'ask'; readonly reason: 'no-record' }
  | {
      readonly kind: 'ask';
      readonly reason: 'claimant-missing' | 'duplicate-identity';
      /** Where the recorded original was last seen, for the owner's prompt. */
      readonly recordedPath: string;
      /** When that place was recorded, for the owner's prompt. */
      readonly recordedAt: string;
    }
  | { readonly kind: 'unverifiable' };

/**
 * A claim could not get a lock in time. The folder was not changed, so the caller may try again. A
 * claim that fails after the registry commit leaves one registry record (see inClaimTransactions).
 */
export class ProjectClaimBusyError extends Error {
  constructor() {
    super('The project is busy. Try again in a moment.');
    this.name = 'ProjectClaimBusyError';
  }
}

/**
 * A claim failed, and a rollback failed too, so a connection may still be inside a transaction. The
 * app should restart before it claims again. The failure that started it is kept in `original`, and
 * every rollback that failed is in `rollbackFailures`.
 */
export class ProjectClaimRollbackError extends Error {
  readonly original: unknown;
  readonly rollbackFailures: readonly unknown[];

  constructor(original: unknown, rollbackFailures: readonly unknown[]) {
    super(
      'A project claim failed and could not be rolled back. Restart the app before claiming again.',
    );
    this.name = 'ProjectClaimRollbackError';
    this.original = original;
    this.rollbackFailures = rollbackFailures;
  }
}

/**
 * The owner's answer was refused by a rule, not by a fault. `reason` says which rule refused it.
 */
export class ProjectClaimRefusedError extends Error {
  readonly reason: 'recorded-original-in-place' | 'recorded-original-itself';

  constructor(reason: 'recorded-original-in-place' | 'recorded-original-itself', message: string) {
    super(message);
    this.name = 'ProjectClaimRefusedError';
    this.reason = reason;
  }
}

/**
 * A folder could not be recorded, or an id could not be taken, because a rule refused it. `reason`
 * says which rule. Nothing was written.
 */
export class ProjectRecordRefusedError extends Error {
  readonly reason:
    | 'no-folder-identity'
    | 'missing-folder'
    | 'unreadable-identity'
    | 'unreadable-place'
    | 'other-id-held'
    | 'id-recorded-elsewhere'
    | 'id-held-unrecorded'
    | 'id-in-use';

  constructor(reason: ProjectRecordRefusedError['reason'], message: string) {
    super(message);
    this.name = 'ProjectRecordRefusedError';
    this.reason = reason;
  }
}

/**
 * A project folder opened for editing. An editable folder comes back only for a settled claim
 * (kept, claimed, renewed or none). An `ask` or an unverifiable claim gives no folder.
 */
export type EditableProjectFolder =
  | {
      readonly kind: 'editable';
      readonly folder: ProjectFolder;
      readonly claim: ProjectFolderClaim;
    }
  | { readonly kind: 'held'; readonly claim: ProjectFolderClaim };

/**
 * Writes the catalog entry of a folder made in place, and records the folder as the original of its
 * id, in one transaction. The create path uses this, so a new folder never waits for a first open
 * to be recorded. A folder that already holds the id, through its entry or its documents, is recorded
 * again only as a retry for this same folder at this place, which keeps the stored entry. Any other
 * record is refused, and so is a folder that holds the id with no matching record: then the owner decides.
 * A folder whose real path cannot be read is refused. Every refusal is a ProjectRecordRefusedError, and
 * nothing is written.
 */
export function recordNewProjectFolder(
  folder: ProjectFolder,
  entry: ProjectFolderEntry,
  registry: ProjectClaimRegistry,
): void {
  inClaimTransactions<void>(folder, registry, () => {
    const root = resolve(folder.root);
    const own = readIdentity(root);
    if (own.kind === 'missing') {
      throw new ProjectRecordRefusedError(
        'missing-folder',
        'The folder is missing, so the project cannot be recorded',
      );
    }
    if (own.kind === 'unreadable') {
      throw new ProjectRecordRefusedError(
        'unreadable-identity',
        'The folder identity cannot be read, so the project cannot be recorded',
      );
    }
    if (own.kind === 'no-identity') {
      throw new ProjectRecordRefusedError(
        'no-folder-identity',
        'The volume gives no folder identity, so the project cannot be recorded',
      );
    }
    if (realPathOrUndefined(root) === undefined) {
      throw new ProjectRecordRefusedError(
        'unreadable-place',
        'The real path of the folder cannot be read, so the project cannot be recorded by its place',
      );
    }
    const current = readProjectFolderEntry(folder);
    if (current !== undefined && current.id !== entry.id) {
      throw new ProjectRecordRefusedError(
        'other-id-held',
        'This folder already holds a different project id',
      );
    }
    // Documents of another project id mean this is not that project's folder, whatever its entry says.
    const holdsOtherDocuments =
      folder.database
        .prepare('SELECT 1 FROM project_documents WHERE project_id <> ? LIMIT 1')
        .get(entry.id) !== undefined;
    if (holdsOtherDocuments) {
      throw new ProjectRecordRefusedError(
        'other-id-held',
        'This folder holds documents of another project id',
      );
    }
    const existing = readProjectClaim(registry, entry.id);
    // Only a retry for this same folder may find a record. Any other record names another folder.
    const isRetry =
      existing !== undefined &&
      existing.folderIdentity === own.identity &&
      isSamePlace(existing.folderPath, root);
    if (existing !== undefined && !isRetry) {
      throw new ProjectRecordRefusedError(
        'id-recorded-elsewhere',
        `The project id ${entry.id} is already recorded for another folder`,
      );
    }
    // A folder holds the id through its entry or through a document. It can be recorded only by its own
    // retry: a holder with no record is a copy, or a folder whose registry was lost, and nothing here can
    // tell which.
    const holdsDocuments =
      folder.database
        .prepare('SELECT 1 FROM project_documents WHERE project_id = ? LIMIT 1')
        .get(entry.id) !== undefined;
    if ((current !== undefined || holdsDocuments) && !isRetry) {
      throw new ProjectRecordRefusedError(
        'id-held-unrecorded',
        `This folder holds the project id ${entry.id}, but no record says it is the original`,
      );
    }
    if (current === undefined) {
      writeProjectFolderEntry(folder, { ...entry, homeRoot: storedPlace(root) });
    }
    recordClaim(registry, entry.id, own.identity, root);
  });
}

/** Settles the id of a folder that has just been opened. */
export function claimProjectFolderId(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
  createId: () => string = newProjectId,
): ProjectFolderClaim {
  return inClaimTransactions<ProjectFolderClaim>(folder, registry, () =>
    settleClaim(folder, registry, resolve(folder.root), createId),
  );
}

/**
 * Opens a project folder for editing. The id is settled first. An editable folder comes back only
 * for a claim that is kept, claimed, renewed or none. An `ask` or an unverifiable claim gives no
 * folder: it is closed, and the owner's answer goes through `answerProjectFolderAsk`.
 *
 * Opening sets up the folder's cache and schema before the claim runs, so the folder is written to
 * even when it is held. The claim itself writes nothing for a held folder. The folder is opened with
 * the claim's short wait, so a locked folder does not hold the caller for long.
 */
export async function openProjectFolderForEditing(
  root: string,
  registry: ProjectClaimRegistry,
): Promise<EditableProjectFolder> {
  const folder = await openForClaim(root);
  let claim: ProjectFolderClaim;
  try {
    claim = claimProjectFolderId(folder, registry);
  } catch (error) {
    folder.close();
    throw error;
  }
  if (claim.kind === 'ask' || claim.kind === 'unverifiable') {
    folder.close();
    return { kind: 'held', claim };
  }
  return { kind: 'editable', folder, claim };
}

/**
 * The owner's answer to an ask. The folder is opened for the answer only, and closed again. It is
 * never handed out for editing.
 */
export async function answerProjectFolderAsk(
  root: string,
  registry: ProjectClaimRegistry,
  answer: 'original' | 'copy',
): Promise<ProjectFolderClaim> {
  const folder = await openForClaim(root);
  try {
    return answer === 'original'
      ? resolveProjectFolderAsOriginal(folder, registry)
      : resolveProjectFolderAsCopy(folder, registry);
  } finally {
    folder.close();
  }
}

/**
 * The owner's answer to an ask: this folder is the original. It is refused while a folder with a
 * different identity is the recorded original and still is where it was recorded. A live clone with
 * this same identity does not refuse it: the owner decides which of the two is the original.
 */
export function resolveProjectFolderAsOriginal(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
): ProjectFolderClaim {
  return inClaimTransactions<ProjectFolderClaim>(folder, registry, () => {
    const root = resolve(folder.root);
    const entry = readProjectFolderEntry(folder);
    if (entry === undefined) return { kind: 'none' };
    const own = readIdentity(root);
    if (own.kind !== 'known') return { kind: 'unverifiable' };
    if (realPathOrUndefined(root) === undefined) return { kind: 'unverifiable' };
    const record = readProjectClaim(registry, entry.id);
    const isRecordedHere =
      record !== undefined &&
      record.folderIdentity === own.identity &&
      isSamePlace(record.folderPath, root);
    if (record !== undefined && !isRecordedHere) {
      const place = recordedPlace(record);
      if (place === 'unknown') return { kind: 'unverifiable' };
      if (place === 'live' && record.folderIdentity !== own.identity) {
        throw new ProjectClaimRefusedError(
          'recorded-original-in-place',
          'The recorded original of this project id is still where it was recorded, so this folder cannot take its place',
        );
      }
    }
    recordClaim(registry, entry.id, own.identity, root);
    if (!isHomeAt(entry, root)) {
      writeProjectFolderEntry(folder, { ...entry, homeRoot: storedPlace(root) });
    }
    return { kind: 'claimed' };
  });
}

/**
 * The owner's answer to an ask: this folder is a copy. It gets a new id. If the folder is really the
 * original, moved to another drive, its id changes when it is opened again. The ask prompt must say so.
 */
export function resolveProjectFolderAsCopy(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
  createId: () => string = newProjectId,
): ProjectFolderClaim {
  return inClaimTransactions<ProjectFolderClaim>(folder, registry, () => {
    const root = resolve(folder.root);
    const entry = readProjectFolderEntry(folder);
    if (entry === undefined) return { kind: 'none' };
    const own = readIdentity(root);
    if (own.kind !== 'known') return { kind: 'unverifiable' };
    if (realPathOrUndefined(root) === undefined) return { kind: 'unverifiable' };
    const record = readProjectClaim(registry, entry.id);
    if (record !== undefined) {
      const sameIdentity = record.folderIdentity === own.identity;
      if (sameIdentity && isSamePlace(record.folderPath, root)) {
        throw new ProjectClaimRefusedError(
          'recorded-original-itself',
          'This folder is the recorded original of its project id, so it cannot be a copy',
        );
      }
      // A recorded place that cannot be read is never a guess, so the answer changes nothing.
      const place = recordedPlace(record);
      if (place === 'unknown') return { kind: 'unverifiable' };
      // The same identity at a gone place is the moved original. A live place is a clone.
      if (sameIdentity && place === 'gone') {
        throw new ProjectClaimRefusedError(
          'recorded-original-itself',
          'This folder is the recorded original of its project id, so it cannot be a copy',
        );
      }
    }
    return renewAsCopy(folder, registry, entry, own.identity, root, createId);
  });
}

function settleClaim(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
  root: string,
  createId: () => string,
): ProjectFolderClaim {
  // Read inside the transaction, so the decision and the write see the same entry.
  const entry = readProjectFolderEntry(folder);
  if (entry === undefined) return { kind: 'none' };
  const own = readIdentity(root);
  if (own.kind !== 'known') return { kind: 'unverifiable' };
  // A real path that cannot be read is never a guess: nothing is decided or written for it.
  if (realPathOrUndefined(root) === undefined) return { kind: 'unverifiable' };

  const record = readProjectClaim(registry, entry.id);
  // Without a record, nothing says which folder is the original, even where this one is home.
  // A copy of a lost original is home at the old place too, so the owner decides.
  if (record === undefined) return { kind: 'ask', reason: 'no-record' };
  if (record.folderIdentity === own.identity && isSamePlace(record.folderPath, root)) {
    if (!isHomeAt(entry, root)) {
      writeProjectFolderEntry(folder, { ...entry, homeRoot: storedPlace(root) });
    }
    return { kind: 'kept' };
  }

  const place = recordedPlace(record);
  if (place === 'unknown') return { kind: 'unverifiable' };
  if (record.folderIdentity === own.identity) {
    // The same identity at another place. A live recorded place is a clone, and the owner decides.
    if (place === 'live') return askAboutPlace('duplicate-identity', record);
    // The recorded place no longer holds this identity, so this folder was moved: it is the original.
    recordClaim(registry, entry.id, own.identity, root);
    if (!isHomeAt(entry, root)) {
      writeProjectFolderEntry(folder, { ...entry, homeRoot: storedPlace(root) });
    }
    return { kind: 'kept' };
  }
  if (place === 'gone') return askAboutPlace('claimant-missing', record);
  return renewAsCopy(folder, registry, entry, own.identity, root, createId);
}

function askAboutPlace(
  reason: 'claimant-missing' | 'duplicate-identity',
  record: ProjectClaim,
): ProjectFolderClaim {
  return { kind: 'ask', reason, recordedPath: record.folderPath, recordedAt: record.recordedAt };
}

function renewAsCopy(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
  entry: ProjectFolderEntry,
  identity: string,
  root: string,
  createId: () => string,
): ProjectFolderClaim {
  const id = createId();
  // A repeated id would overwrite the record of another folder, so a taken id is refused.
  if (readProjectClaim(registry, id) !== undefined) {
    throw new ProjectRecordRefusedError(
      'id-in-use',
      'The new project id is already recorded for another folder',
    );
  }
  renewIdentity(folder, entry, id, root);
  recordClaim(registry, id, identity, root);
  return { kind: 'renewed', previousId: entry.id, id };
}

/**
 * Runs `work` inside a write transaction on the registry and on the folder. The registry's lock is
 * taken first, so claims on this machine line up in one order, and the registry commits first. If
 * the registry's commit fails, both roll back and nothing changed. If the folder's commit fails
 * after the registry's, the folder keeps its old id, and the registry keeps the record it committed.
 * For a claim that renewed the folder, that record names an id no folder holds. For an owner's answer,
 * the record already names the answering folder. Either way the caller gets ProjectClaimBusyError and must
 * run the claim again. Running it again is safe: an answer finds its own record and settles again, and a
 * renewal may leave one more record.
 */
function inClaimTransactions<T>(
  folder: ProjectFolder,
  registry: ProjectClaimRegistry,
  work: () => T,
): T {
  let registryOpen = false;
  let folderOpen = false;
  try {
    folder.database.exec(`PRAGMA busy_timeout = ${CLAIM_WAIT_MS}`);
    registry.database.exec(`PRAGMA busy_timeout = ${CLAIM_WAIT_MS}`);
    registry.database.exec('BEGIN IMMEDIATE');
    registryOpen = true;
    folder.database.exec('BEGIN IMMEDIATE');
    folderOpen = true;
    const result = work();
    registry.database.exec('COMMIT');
    registryOpen = false;
    folder.database.exec('COMMIT');
    folderOpen = false;
    return result;
  } catch (error) {
    // Both connections are rolled back, even when the first rollback fails, so a folder failure
    // never leaves the registry inside a transaction. Every rollback that fails is reported.
    const folderFailure = folderOpen ? rollback(folder.database) : undefined;
    const registryFailure = registryOpen ? rollback(registry.database) : undefined;
    const claimError = busyAsClaimError(error);
    const rollbackFailures = [folderFailure, registryFailure].filter(
      (failure) => failure !== undefined,
    );
    if (rollbackFailures.length > 0) {
      throw new ProjectClaimRollbackError(claimError, rollbackFailures);
    }
    throw claimError;
  } finally {
    restoreFolderWait(folder);
  }
}

/** Puts back the folder's normal busy wait. A connection that is already closed has nothing to restore. */
function restoreFolderWait(folder: ProjectFolder): void {
  try {
    folder.database.exec(`PRAGMA busy_timeout = ${PROJECT_FOLDER_BUSY_WAIT_MS}`);
  } catch {
    // The connection is closed, so there is no wait to restore.
  }
}

/** Opens a folder for a claim. A lock held by another connection during the open is reported as busy. */
async function openForClaim(root: string): Promise<ProjectFolder> {
  try {
    return await openProjectFolder(root, undefined, CLAIM_WAIT_MS);
  } catch (error) {
    throw busyAsClaimError(error);
  }
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * True when an error is a lock held by another connection. SQLite's extended result codes keep the
 * primary code in their low byte, so that byte is compared.
 */
export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { errcode?: unknown }).errcode;
  if (typeof code !== 'number') return false;
  const primary = code & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

function busyAsClaimError(error: unknown): unknown {
  return isBusyError(error) ? new ProjectClaimBusyError() : error;
}

/**
 * Rolls the connection back. Returns the failure when the connection is still in a transaction, or when it
 * cannot say whether it is. A closed connection cannot be asked, so its rollback failure is reported.
 */
function rollback(database: DatabaseSync): unknown {
  try {
    database.exec('ROLLBACK');
    return undefined;
  } catch (error) {
    return isInTransaction(database) ? error : undefined;
  }
}

function isInTransaction(database: DatabaseSync): boolean {
  try {
    return database.isTransaction;
  } catch {
    return true;
  }
}

/**
 * A folder's identity on its volume. `missing` means the path is not there. `unreadable` means the stat
 * failed for another reason, such as a share that is unreachable. `no-identity` means the volume gives no
 * identities. Nothing can be decided from any of the three.
 */
type IdentityRead =
  | { readonly kind: 'known'; readonly identity: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'no-identity' };

function readIdentity(root: string): IdentityRead {
  let stats: { readonly dev: bigint; readonly ino: bigint };
  try {
    stats = statSync(root, { bigint: true });
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  const identity = identityFromStats(stats);
  return identity === undefined ? { kind: 'no-identity' } : { kind: 'known', identity };
}

/**
 * Where a recorded folder is now. `live`: its place still holds the recorded identity, on whatever drive it
 * is. `gone`: the place is missing, or holds another identity, and the drive at the place is the volume the
 * record was made on, which is mounted. `unknown`: the place cannot be read, its volume gives no identities,
 * or its drive is another volume or is not mounted at all, so nothing says whether the record's own volume
 * is there.
 */
function recordedPlace(record: ProjectClaim): 'live' | 'gone' | 'unknown' {
  const read = readIdentity(record.folderPath);
  if (read.kind === 'known' && read.identity === record.folderIdentity) return 'live';
  if (read.kind === 'unreadable' || read.kind === 'no-identity') return 'unknown';
  return volumeIsPresent(record) ? 'gone' : 'unknown';
}

/**
 * True when the drive at a recorded place is the volume the record was made on, and is mounted. Windows
 * gives every path on a volume the same device number, so a drive letter that another volume has taken is
 * not that volume.
 */
function volumeIsPresent(record: ProjectClaim): boolean {
  try {
    const drive = statSync(parse(record.folderPath).root, { bigint: true });
    // The identity starts with the device number of the volume the folder was on.
    return `${drive.dev}` === record.folderIdentity.split(':')[0];
  } catch {
    return false;
  }
}

/**
 * True when two paths name the same folder: the same real path, with junctions, subst drives and
 * mapped drives resolved, and case ignored on Windows. A path that cannot be resolved names no place.
 */
function isSamePlace(a: string, b: string): boolean {
  const left = realPathOrUndefined(a);
  const right = realPathOrUndefined(b);
  if (left === undefined || right === undefined) return false;
  return samePathText(left, right);
}

/** Two real paths name the same place as text. Windows paths are compared without case. */
function samePathText(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * The place a folder is stored under: its real path, so that an alias (a subst drive, a junction)
 * never outlives the drive it names. A folder whose real path cannot be read is refused, so nothing is
 * ever stored under an alias.
 */
function storedPlace(root: string): string {
  const place = realPathOrUndefined(root);
  if (place === undefined) {
    throw new ProjectRecordRefusedError(
      'unreadable-place',
      'The real path of the folder cannot be read, so it cannot be stored by its place',
    );
  }
  return place;
}

/** The identity string for a stat result. A zero index means the volume gives no identities. */
export function identityFromStats(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
}): string | undefined {
  return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
}

function recordClaim(
  registry: ProjectClaimRegistry,
  projectId: string,
  identity: string,
  root: string,
): void {
  writeProjectClaim(registry, {
    projectId,
    folderIdentity: identity,
    folderPath: storedPlace(root),
    recordedAt: new Date().toISOString(),
  });
}

function newProjectId(): string {
  return `project-${randomUUID()}`;
}

/** True when the stored home path is this folder's real place. An alias stored as the home is not. */
function isHomeAt(entry: ProjectFolderEntry, root: string): boolean {
  return entry.homeRoot !== undefined && samePathText(entry.homeRoot, storedPlace(root));
}

/**
 * Moves the folder to a new id: the entry, the document key, and the references to the old id in the
 * stored document and look instances. The revision is not changed. The caller holds the transaction.
 *
 * The timeline and visual ids are document ids, not always the project id, so each changes only when
 * it named the old project. Every other field of the entry is kept as it was read. A stored text that
 * does not hold the old id is not rewritten at all, and a rewritten text changes only the string tokens
 * that hold the old id.
 */
function renewIdentity(
  folder: ProjectFolder,
  entry: ProjectFolderEntry,
  id: string,
  root: string,
): void {
  const previousId = entry.id;
  const row = folder.database
    .prepare(
      'SELECT document_json, look_instances_json FROM project_documents WHERE project_id = ?',
    )
    .get(previousId) as
    { readonly document_json: string; readonly look_instances_json: string | null } | undefined;
  // Both stored texts must be JSON before anything is written, so a text that is not throws here.
  if (row !== undefined) {
    JSON.parse(row.document_json);
    if (row.look_instances_json !== null) JSON.parse(row.look_instances_json);
  }
  writeProjectFolderEntry(folder, {
    ...entry,
    id,
    timelineProjectId: entry.timelineProjectId === previousId ? id : entry.timelineProjectId,
    visualProjectId: entry.visualProjectId === previousId ? id : entry.visualProjectId,
    homeRoot: storedPlace(root),
  });
  if (row === undefined) return;
  const document = renameIdInJson(row.document_json, previousId, id);
  const lookInstances =
    row.look_instances_json === null
      ? undefined
      : renameIdInJson(row.look_instances_json, previousId, id);
  if (document === undefined && lookInstances === undefined) {
    folder.database
      .prepare('UPDATE project_documents SET project_id = ? WHERE project_id = ?')
      .run(id, previousId);
    return;
  }
  folder.database
    .prepare(
      'UPDATE project_documents SET project_id = ?, document_json = ?, look_instances_json = ? WHERE project_id = ?',
    )
    .run(id, document ?? row.document_json, lookInstances ?? row.look_instances_json, previousId);
}

// Unrolled, so a long string does not push a backtrack entry for every one of its characters.
const JSON_STRING_TOKEN = /"[^"\\]*(?:\\.[^"\\]*)*"/g;

/**
 * Replaces the old id where a JSON string holds it exactly: as a value, or as an object key, at any
 * depth. Only string tokens are read and replaced, so every number, space and other string keeps its
 * exact text. A number beyond 2^53 would not survive a parse and a stringify. Returns undefined when no
 * string holds the old id. The text must be valid JSON. The old id is unique to this project, so a string
 * equal to it names this project. A project document must never hold the id of another project, or a copy
 * would rename that reference too.
 */
function renameIdInJson(text: string, previousId: string, id: string): string | undefined {
  const result = text.replace(JSON_STRING_TOKEN, (token) =>
    JSON.parse(token) === previousId ? JSON.stringify(id) : token,
  );
  return result === text ? undefined : result;
}
