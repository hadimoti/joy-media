import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ProjectClaimRegistry,
  ProjectFolder,
  ProjectFolderClaim,
  ProjectFolderEntry,
  ProjectFolderListing,
} from './gate.js';
import {
  ProjectClaimBusyError,
  ProjectClaimRefusedError,
  ProjectClaimRollbackError,
  ProjectRecordRefusedError,
  answerProjectFolderAsk,
  createProjectFolder,
  describeVolumeAnswer,
  listProjectFolders,
  openProjectFolderForEditing,
  projectFolderMediaStates,
  projectFolderName,
  projectPlaceRefusal,
  readProjectFolderDocument,
  readProjectFolderEntry,
  readProjectFolderMedia,
  recordNewProjectFolder,
  restoreProjectFolderRecord,
  saveProjectFolder,
  warmVolumeAnswer,
} from './gate.js';
import {
  PROJECT_FOLDER_ANSWERS,
  PROJECT_FOLDER_OPS,
  type ProjectFolderAnswer,
  type ProjectFolderAnswerReply,
  type ProjectFolderAsk,
  type ProjectFolderCloseReply,
  type ProjectFolderLoadReply,
  type ProjectFolderMediaReply,
  type ProjectFolderSaveMedia,
  type ProjectFolderSaveReply,
  type ProjectFolderCreateReply,
  type ProjectFolderEntryView,
  type ProjectFolderListReply,
  type ProjectFolderListedItem,
  type ProjectFolderOpenReply,
  type ProjectFolderOp,
  type ProjectFolderProblem,
  type ProjectFolderRefusal,
  type ProjectFolderRefused,
  type ProjectFolderRequestMessage,
  type ProjectFolderRestoreReply,
  type ProjectFolderSibling,
  type ProjectFolderUnverifiedReason,
  type ProjectFolderVolume,
  type ProjectFolderWorkerReply,
} from './project-folder-protocol.js';

/**
 * The project-folder rules the desktop runs, on the worker thread (project-folder-worker.ts), so a claim that waits
 * on a lock or on Windows' volume check does not stall the main process. Every outcome is data: a settled claim, the
 * owner's question, or a refusal with a code. No store error text leaves this module.
 *
 * Folders are named by opaque keys from the last listing. A key that was never listed is refused, so the renderer
 * cannot point the desktop at a path of its own choosing.
 */

/** A save as the main process sends it: the renderer's fields, and the original's place the main process found. */
export interface ProjectFolderSaveRequest {
  readonly projectId: string;
  readonly baseRevisionId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly document: unknown;
  readonly media: readonly ProjectFolderSaveMedia[];
}

/** The folder that is open in the editor. One at a time: opening another folder closes it. */
interface OpenFolderSession {
  readonly key: string;
  readonly folder: ProjectFolder;
}

export interface ProjectFolderServiceOptions {
  readonly registry: ProjectClaimRegistry;
  /** The folder that holds new project folders (defaultProjectFoldersDirectory). */
  readonly directory: string;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly newKey?: () => string;
}

export interface ProjectFolderService {
  list(): Promise<ProjectFolderListReply>;
  create(title: string): Promise<ProjectFolderCreateReply>;
  open(key: string): Promise<ProjectFolderOpenReply>;
  answer(key: string, answer: ProjectFolderAnswer): Promise<ProjectFolderAnswerReply>;
  restore(key: string, title: string): Promise<ProjectFolderRestoreReply>;
  /** The saved project of the folder that is open in the editor. */
  load(key: string): Promise<ProjectFolderLoadReply | ProjectFolderRefused>;
  /** Saves the editor's project and its media into the open folder. */
  save(key: string, save: ProjectFolderSaveRequest): Promise<ProjectFolderSaveReply>;
  /** Whether the open folder holds each media file. */
  mediaStates(key: string, assetIds: readonly string[]): Promise<ProjectFolderMediaReply>;
  /** One piece of a media file the open folder holds. */
  mediaBytes(key: string, assetId: string, offset: number): Promise<ProjectFolderMediaReply>;
  /** Closes the folder that is open in the editor. Closing a folder that is not open is harmless. */
  closeFolder(key: string): ProjectFolderCloseReply;
  /** Closes the open folder and the claim registry. Later calls fail, and nothing is written. */
  close(): void;
}

/** How many times a new folder's record is tried when its lock is busy. Each try waits for the lock in the store. */
const RECORD_ATTEMPTS = 3;

/** The record-refusal reasons that name an unverifiable folder, in the words of the open reply. */
const UNVERIFIED_REASON: Partial<Record<string, ProjectFolderUnverifiedReason>> = {
  'missing-folder': 'missing-folder',
  'unreadable-identity': 'unreadable-identity',
  'unreadable-place': 'unreadable-place',
  'unverified-volume': 'unverified-volume',
  'no-folder-identity': 'no-folder-identity',
};

export function createProjectFolderService(
  options: ProjectFolderServiceOptions,
): ProjectFolderService {
  const { registry, directory } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => `project-${randomUUID()}`);
  const newKey = options.newKey ?? (() => `folder-${randomUUID()}`);
  const keyByPlace = new Map<string, string>();
  const rootByKey = new Map<string, string>();
  let session: OpenFolderSession | undefined;
  let closed = false;

  /** Closes the folder that is open in the editor, if any. */
  function endSession(): void {
    const current = session;
    session = undefined;
    if (current !== undefined) closeQuietly(current.folder);
  }

  function sessionFor(key: string): OpenFolderSession | undefined {
    return session !== undefined && session.key === key ? session : undefined;
  }

  function keyFor(root: string): string {
    const place = placeOf(root);
    const known = keyByPlace.get(place);
    if (known !== undefined) return known;
    const key = newKey();
    keyByPlace.set(place, key);
    rootByKey.set(key, root);
    return key;
  }

  function rootFor(key: string): string | undefined {
    return rootByKey.get(key);
  }

  function listedItem(listing: ProjectFolderListing): ProjectFolderListedItem {
    const base = { key: keyFor(listing.root), name: basename(listing.root) };
    if (listing.entry !== undefined) return { ...base, entry: entryView(listing.entry) };
    return listing.problem === undefined ? base : { ...base, problem: problemOf(listing.problem) };
  }

  async function list(): Promise<ProjectFolderListReply> {
    const listings = await listProjectFolders(directory);
    forgetKeysNotIn(listings);
    return { kind: 'listed', folders: listings.map((listing) => listedItem(listing)) };
  }

  /** A key names a folder only while that folder is in the last listing. A renamed or removed folder loses its key. */
  function forgetKeysNotIn(listings: readonly ProjectFolderListing[]): void {
    const live = new Set(listings.map((listing) => placeOf(listing.root)));
    for (const [place, key] of keyByPlace) {
      if (live.has(place)) continue;
      keyByPlace.delete(place);
      rootByKey.delete(key);
    }
  }

  /**
   * Records a new folder. A busy lock that came before any record was saved is retried with the same entry, so the folder
   * keeps the id it was given. A busy lock after a saved record is not retried: a retry finds that record as its own and
   * writes nothing, so its error would not say the record is in place. The owner finishes such a folder through the
   * restore route, which takes the id from the record.
   */
  function recordWithRetry(folder: ProjectFolder, entry: ProjectFolderEntry): void {
    for (let attempt = 1; ; attempt += 1) {
      try {
        recordNewProjectFolder(folder, entry, registry);
        return;
      } catch (error) {
        const retry =
          error instanceof ProjectClaimBusyError &&
          !error.appliedInRegistry &&
          attempt < RECORD_ATTEMPTS;
        if (!retry) throw error;
      }
    }
  }

  async function create(title: string): Promise<ProjectFolderCreateReply> {
    const trimmed = title.trim();
    if (trimmed === '') return refused('no-title');
    // The place is checked before anything is written. The directory may not exist yet, so the nearest folder that
    // does exist is checked: it is on the same volume, and no folder is made on a refused drive.
    const existing = nearestExistingPlace(directory);
    await warmVolumeOf(existing);
    const place = projectPlaceRefusal(existing);
    if (place !== undefined) return refused(place, { volume: volumeOf(existing) });
    try {
      await mkdir(directory, { recursive: true });
    } catch {
      // Nothing was made, so the refusal names no folder.
      return refused('failed');
    }
    const name = projectFolderName(trimmed);
    if (existsSync(join(directory, name))) return refused('name-taken', { name });
    const id = newId();
    const stamp = now();
    let folder: ProjectFolder;
    try {
      folder = await createProjectFolder(directory, trimmed, () => stamp);
    } catch (error) {
      // Another process may have made this name since the check above. That is a taken name, and nothing was made here.
      if (
        error instanceof Error &&
        error.message === 'A project folder with that name already exists'
      ) {
        return refused('name-taken', { name });
      }
      // Making the folder can fail after its directory exists. Then the refusal names it, as a made folder does.
      const refusal = refusedFrom(error, {});
      return existsSync(join(directory, name)) ? { ...refusal, name } : refusal;
    }
    const entry: ProjectFolderEntry = {
      id,
      title: trimmed,
      createdAt: stamp,
      updatedAt: stamp,
      timelineProjectId: id,
      visualProjectId: id,
    };
    try {
      recordWithRetry(folder, entry);
    } catch (error) {
      // The folder exists now, so every refusal from here names it: it is a folder, but not yet a project.
      return { ...refusedFrom(error, { root: folder.root }), name };
    } finally {
      closeQuietly(folder);
    }
    return { kind: 'created', key: keyFor(folder.root), name, id, title: trimmed };
  }

  async function open(key: string): Promise<ProjectFolderOpenReply> {
    const root = rootFor(key);
    if (root === undefined) return refused('unknown-folder');
    if (!existsSync(root)) return { kind: 'unverifiable', reason: 'missing-folder' };
    await warmVolumeOf(root);
    // One folder is open in the editor at a time. Opening any folder, this one too, closes the one before.
    endSession();
    try {
      const result = await openProjectFolderForEditing(root, registry);
      if (result.kind === 'held') return await heldReply(root, result.claim);
      let reply: ProjectFolderOpenReply;
      try {
        reply = await readyReply(root, result.folder, result.claim);
      } catch {
        // The claim is settled before the reply is built, so the owner is asked to check the folder, not told nothing changed.
        closeQuietly(result.folder);
        return refused('settled-not-shown');
      }
      // A ready folder stays open for the editor, which loads and saves it by this key until it closes it.
      if (reply.kind === 'ready') session = { key, folder: result.folder };
      else closeQuietly(result.folder);
      return reply;
    } catch (error) {
      return refusedFrom(error, { root });
    }
  }

  async function readyReply(
    root: string,
    folder: ProjectFolder,
    claim: ProjectFolderClaim,
  ): Promise<ProjectFolderOpenReply> {
    if (claim.kind !== 'kept' && claim.kind !== 'claimed' && claim.kind !== 'renewed') {
      // An entry-less folder that the registry does not name is settled as `none`. It is not a project yet.
      return refused('no-entry');
    }
    const entry = readProjectFolderEntry(folder);
    if (entry === undefined) return refused('no-entry');
    const previousId = claim.kind === 'renewed' ? claim.previousId : undefined;
    // A renewed copy names the id it lost, so the owner can see which folders still hold it.
    const siblings = previousId === undefined ? [] : await siblingsOf(root, previousId);
    return {
      kind: 'ready',
      claim: claim.kind,
      id: entry.id,
      title: entry.title,
      ...(previousId === undefined ? {} : { previousId }),
      siblings,
    };
  }

  async function heldReply(
    root: string,
    claim: ProjectFolderClaim,
  ): Promise<ProjectFolderOpenReply> {
    if (claim.kind === 'unverifiable') return unverifiedReply(root);
    if (claim.kind !== 'ask') return refused('failed');
    const listing = await listingOrEmpty(dirname(root));
    const own = listing.find((item) => samePlace(item.root, root));
    const projectId = claim.reason === 'entry-missing' ? claim.projectId : own?.entry?.id;
    const ask: ProjectFolderAsk = {
      reason: claim.reason,
      ...(projectId === undefined ? {} : { projectId }),
      ...(claim.reason === 'no-record'
        ? {}
        : { recordedPath: claim.recordedPath, recordedAt: claim.recordedAt }),
      ...(claim.reason === 'claimant-missing'
        ? { placeState: placeStateOf(root, claim.recordedPath) }
        : {}),
      siblings: siblingsIn(listing, root, projectId),
    };
    return { kind: 'ask', ask };
  }

  function unverifiedReply(root: string): ProjectFolderOpenReply {
    const refusal = projectPlaceRefusal(root);
    const reason =
      refusal === undefined ? 'unverifiable' : (UNVERIFIED_REASON[refusal] ?? 'unverifiable');
    const volume = refusal === 'unverified-volume' ? volumeOf(root) : undefined;
    return {
      kind: 'unverifiable',
      reason,
      ...(volume === undefined ? {} : { volume }),
    };
  }

  async function answer(
    key: string,
    choice: ProjectFolderAnswer,
  ): Promise<ProjectFolderAnswerReply> {
    const root = rootFor(key);
    if (root === undefined) return refused('unknown-folder');
    if (!existsSync(root)) return refused('missing-folder');
    await warmVolumeOf(root);
    let claim: ProjectFolderClaim;
    try {
      claim = await answerProjectFolderAsk(root, registry, choice);
    } catch (error) {
      return refusedFrom(error, { root });
    }
    try {
      return await answeredReply(root, claim);
    } catch {
      // The answer is settled before the reply is built, so the owner is asked to check the folder, not told nothing changed.
      return refused('settled-not-shown');
    }
  }

  async function answeredReply(
    root: string,
    claim: ProjectFolderClaim,
  ): Promise<ProjectFolderAnswerReply> {
    if (claim.kind === 'renewed') {
      return {
        kind: 'answered',
        claim: 'renewed',
        id: claim.id,
        previousId: claim.previousId,
        siblings: await siblingsOf(root, claim.previousId),
      };
    }
    const settled = claim.kind === 'ask' ? 'undecided' : claim.kind;
    // The owner is told the drive only when this folder's own drive is the reason it cannot be checked.
    const volume =
      settled === 'unverifiable' && projectPlaceRefusal(root) === 'unverified-volume'
        ? volumeOf(root)
        : undefined;
    return {
      kind: 'answered',
      claim: settled,
      siblings: [],
      ...(volume === undefined ? {} : { volume }),
    };
  }

  async function restore(key: string, title: string): Promise<ProjectFolderRestoreReply> {
    const root = rootFor(key);
    if (root === undefined) return refused('unknown-folder');
    if (!existsSync(root)) return refused('missing-folder');
    const trimmed = title.trim();
    if (trimmed === '') return refused('no-title');
    await warmVolumeOf(root);
    try {
      await restoreProjectFolderRecord(root, registry, { title: trimmed });
      return { kind: 'restored' };
    } catch (error) {
      return refusedFrom(error, { root });
    }
  }

  async function load(key: string): Promise<ProjectFolderLoadReply | ProjectFolderRefused> {
    const open = sessionFor(key);
    if (open === undefined) return refused('not-open');
    const entry = readProjectFolderEntry(open.folder);
    if (entry === undefined) return refused('no-entry');
    const saved = readProjectFolderDocument(open.folder);
    return {
      kind: 'loaded',
      id: entry.id,
      title: entry.title,
      document: saved?.document ?? null,
      revisionId: saved?.revisionId ?? '',
      documentProjectId: saved?.projectId ?? entry.id,
    };
  }

  async function save(
    key: string,
    request: ProjectFolderSaveRequest,
  ): Promise<ProjectFolderSaveReply> {
    const open = sessionFor(key);
    if (open === undefined) return refused('not-open');
    try {
      const result = await saveProjectFolder(open.folder, request, now);
      if (result.kind === 'saved') return result;
      return refused(result.kind === 'wrong-project' ? 'wrong-project' : 'save-conflict');
    } catch (error) {
      return refusedFrom(error, { root: open.folder.root });
    }
  }

  async function mediaStates(
    key: string,
    assetIds: readonly string[],
  ): Promise<ProjectFolderMediaReply> {
    const open = sessionFor(key);
    if (open === undefined) return refused('not-open');
    return { kind: 'media', states: projectFolderMediaStates(open.folder, assetIds) };
  }

  async function mediaBytes(
    key: string,
    assetId: string,
    offset: number,
  ): Promise<ProjectFolderMediaReply> {
    const open = sessionFor(key);
    if (open === undefined) return refused('not-open');
    const chunk = await readProjectFolderMedia(open.folder, assetId, offset);
    if (chunk === undefined) return refused('media-missing');
    return { kind: 'media-bytes', assetId, ...chunk };
  }

  /**
   * The other folders that hold an id. Best effort: the claim is already settled when this runs, so a listing that
   * fails must not turn a settled change into a refusal that says nothing changed.
   */
  async function siblingsOf(root: string, id: string): Promise<ProjectFolderSibling[]> {
    return siblingsIn(await listingOrEmpty(dirname(root)), root, id);
  }

  /** The folders in a directory. A listing that fails gives none, so the question still shows, without its list. */
  async function listingOrEmpty(directory: string): Promise<ProjectFolderListing[]> {
    try {
      return await listProjectFolders(directory);
    } catch {
      return [];
    }
  }

  function siblingsIn(
    listing: readonly ProjectFolderListing[],
    root: string,
    id: string | undefined,
  ): ProjectFolderSibling[] {
    if (id === undefined) return [];
    return listing
      .filter((item) => item.entry?.id === id && !samePlace(item.root, root))
      .map((item) => ({ key: keyFor(item.root), name: basename(item.root) }));
  }

  return {
    list,
    create,
    open,
    answer,
    restore,
    load,
    save,
    mediaStates,
    mediaBytes,
    closeFolder(key: string): ProjectFolderCloseReply {
      if (sessionFor(key) !== undefined) endSession();
      return { kind: 'closed' };
    },
    close(): void {
      if (closed) return;
      closed = true;
      endSession();
      registry.close();
    },
  };
}

/**
 * Runs one request from the main process and builds its reply. An unexpected failure becomes a fixed message, so no
 * store detail is sent back, and the detail is logged in the worker.
 */
export async function handleProjectFolderMessage(
  service: ProjectFolderService,
  message: unknown,
): Promise<ProjectFolderWorkerReply> {
  const request = parseRequest(message);
  if (request === undefined) {
    return { id: idOf(message), ok: false, error: 'Invalid project folder request' };
  }
  try {
    return { id: request.id, ok: true, value: await runOp(service, request) };
  } catch (error) {
    if (error instanceof InvalidProjectFolderRequest) {
      return { id: request.id, ok: false, error: 'Invalid project folder request' };
    }
    console.error('[joy-desktop] project folder request failed', error);
    return { id: request.id, ok: false, error: 'The project folder request failed' };
  }
}

class InvalidProjectFolderRequest extends Error {
  constructor() {
    super('Invalid project folder request');
    this.name = 'InvalidProjectFolderRequest';
  }
}

async function runOp(
  service: ProjectFolderService,
  request: ProjectFolderRequestMessage,
): Promise<unknown> {
  const payload = request.payload;
  switch (request.op) {
    case 'list':
      return service.list();
    case 'create':
      return service.create(requiredString(payload, 'title'));
    case 'open':
      return service.open(requiredString(payload, 'key'));
    case 'answer':
      return service.answer(requiredString(payload, 'key'), requiredAnswer(payload));
    case 'restore':
      return service.restore(requiredString(payload, 'key'), requiredString(payload, 'title'));
    case 'load':
      return service.load(requiredString(payload, 'key'));
    case 'save':
      return service.save(requiredString(payload, 'key'), requiredSave(payload));
    case 'media': {
      const key = requiredString(payload, 'key');
      const ids = (payload as Record<string, unknown>)['assetIds'];
      if (Array.isArray(ids)) {
        if (!ids.every((id) => typeof id === 'string')) throw new InvalidProjectFolderRequest();
        return service.mediaStates(key, ids as string[]);
      }
      return service.mediaBytes(key, requiredString(payload, 'assetId'), requiredOffset(payload));
    }
    case 'close':
      return service.closeFolder(requiredString(payload, 'key'));
    case 'shutdown':
      service.close();
      return { kind: 'stopped' };
  }
}

function parseRequest(message: unknown): ProjectFolderRequestMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as { id?: unknown; op?: unknown; payload?: unknown };
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id)) return undefined;
  if (!(PROJECT_FOLDER_OPS as readonly unknown[]).includes(candidate.op)) return undefined;
  return {
    id: candidate.id,
    op: candidate.op as ProjectFolderOp,
    payload: candidate.payload,
  };
}

function idOf(message: unknown): number {
  if (typeof message !== 'object' || message === null) return -1;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : -1;
}

function requiredString(payload: unknown, field: string): string {
  if (typeof payload !== 'object' || payload === null) throw new InvalidProjectFolderRequest();
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new InvalidProjectFolderRequest();
  return value;
}

function requiredOffset(payload: unknown): number {
  const value = (payload as Record<string, unknown>)['offset'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectFolderRequest();
  }
  return value;
}

/** A save from the main process. Every field is checked; a media item may carry the place the main process found. */
function requiredSave(payload: unknown): ProjectFolderSaveRequest {
  const record = payload as Record<string, unknown>;
  const media = record['media'];
  if (!Array.isArray(media) || !('document' in record)) throw new InvalidProjectFolderRequest();
  return {
    projectId: requiredString(payload, 'projectId'),
    baseRevisionId: requiredString(payload, 'baseRevisionId'),
    revisionId: requiredString(payload, 'revisionId'),
    title: requiredString(payload, 'title'),
    document: record['document'],
    media: media.map((item: unknown) => {
      const sha256 = optionalString(item, 'sha256');
      const sourcePath = optionalString(item, 'sourcePath');
      return {
        assetId: requiredString(item, 'assetId'),
        kind: requiredString(item, 'kind'),
        displayName: requiredString(item, 'displayName'),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(sourcePath === undefined ? {} : { sourcePath }),
      };
    }),
  };
}

function optionalString(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) throw new InvalidProjectFolderRequest();
  const value = (payload as Record<string, unknown>)[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidProjectFolderRequest();
  return value;
}

function requiredAnswer(payload: unknown): ProjectFolderAnswer {
  const value = requiredString(payload, 'answer');
  if ((PROJECT_FOLDER_ANSWERS as readonly string[]).includes(value)) {
    return value as ProjectFolderAnswer;
  }
  throw new InvalidProjectFolderRequest();
}

function refused(
  code: ProjectFolderRefusal,
  extra: {
    readonly volume?: ProjectFolderVolume | undefined;
    readonly name?: string | undefined;
    readonly appliedInRegistry?: boolean | undefined;
  } = {},
): ProjectFolderRefused {
  return {
    kind: 'refused',
    code,
    ...(extra.volume === undefined ? {} : { volume: extra.volume }),
    ...(extra.name === undefined ? {} : { name: extra.name }),
    ...(extra.appliedInRegistry === true ? { appliedInRegistry: true } : {}),
  };
}

/**
 * Closes a folder after its claim has run, whether the claim settled or threw. A failed close does not change that outcome,
 * so it is not reported to the owner, who would otherwise be told that nothing changed. It is logged with its error, so a
 * leaked connection is visible.
 */
function closeQuietly(folder: ProjectFolder): void {
  try {
    folder.close();
  } catch (error) {
    console.error('[joy-desktop] a project folder could not be closed', error);
  }
}

/** Maps any error from a claim, a record or a restore to a refusal code. Unknown errors become `failed`. */
function refusedFrom(
  error: unknown,
  context: { readonly root?: string; readonly name?: string } = {},
): ProjectFolderRefused {
  if (error instanceof ProjectClaimBusyError) {
    return {
      kind: 'refused',
      code: 'busy',
      ...(error.appliedInRegistry ? { appliedInRegistry: true } : {}),
    };
  }
  if (error instanceof ProjectClaimRollbackError) {
    return refused('restart', { appliedInRegistry: error.appliedInRegistry });
  }
  if (error instanceof ProjectClaimRefusedError) return refused(error.reason);
  if (error instanceof ProjectRecordRefusedError) {
    const volume =
      error.reason === 'unverified-volume' && context.root !== undefined
        ? volumeOf(context.root)
        : undefined;
    return refused(error.reason, { volume, name: context.name });
  }
  if (isDamaged(error)) return refused('damaged');
  if (error instanceof Error && error.message.startsWith('Not a project folder')) {
    return refused('not-a-folder');
  }
  // A failure after a record was committed is partly applied. The store marks it, and this reads the mark.
  if (isAppliedInRegistry(error)) return refused('failed', { appliedInRegistry: true });
  return refused('failed');
}

function isAppliedInRegistry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly appliedInRegistry?: unknown }).appliedInRegistry === true
  );
}

function isDamaged(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return error instanceof Error && error.message === 'The project folder entry is malformed';
}

function entryView(entry: ProjectFolderEntry): ProjectFolderEntryView {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    timelineProjectId: entry.timelineProjectId,
    visualProjectId: entry.visualProjectId,
    ...(entry.trashedAt === undefined ? {} : { trashedAt: entry.trashedAt }),
  };
}

function problemOf(problem: string): ProjectFolderProblem {
  if (problem === 'project.sqlite is missing') return 'not-a-folder';
  if (problem === 'no catalog entry') return 'no-entry';
  // A folder whose database is locked by a claim is busy, not unreadable.
  if (problem.startsWith('not read') || /locked|busy/i.test(problem)) return 'not-read-in-time';
  return 'unreadable';
}

/** The nearest folder that exists on the way to `path`. A new folder's volume is decided by it. */
/**
 * Condition (q): asks Windows about the volume that holds `path` without blocking the worker thread, before a claim or
 * a place check runs its own (blocking) check, which then finds the answer kept. Every folder in the projects folder
 * is on one volume, so one question covers them. A path that cannot be read is left to the check itself.
 */
async function warmVolumeOf(path: string): Promise<void> {
  try {
    const place = await realpath(path);
    const stats = await stat(place, { bigint: true });
    await warmVolumeAnswer(place, stats.dev);
  } catch {
    // The claim's own check reads the place again and decides.
  }
}

function nearestExistingPlace(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * What is at a recorded place now, for the owner's question about a missing original. The recorded place is a real
 * path, so this folder is compared by its real path too: the default folder may be reached through a junction.
 */
function placeStateOf(
  root: string,
  recordedPath: string,
): 'missing' | 'other-folder' | 'this-folder' {
  if (realPlaceOf(root) === placeOf(recordedPath)) return 'this-folder';
  return existsSync(recordedPath) ? 'other-folder' : 'missing';
}

/** The real path of a folder, lowercased as placeOf does. A path that cannot be read keeps its own text. */
function realPlaceOf(path: string): string {
  try {
    return placeOf(realpathSync.native(path));
  } catch {
    return placeOf(path);
  }
}

/** The drive and file system Windows last reported for a folder's volume, if an answer is kept for it. */
function volumeOf(path: string): ProjectFolderVolume | undefined {
  let device: bigint;
  try {
    device = statSync(path, { bigint: true }).dev;
  } catch {
    return undefined;
  }
  const description = describeVolumeAnswer(device, realPlaceOf(path));
  return description === undefined
    ? undefined
    : { drive: description.drive, fileSystem: description.fileSystem };
}

function placeOf(path: string): string {
  return resolve(path).toLowerCase();
}

function samePlace(a: string, b: string): boolean {
  return placeOf(a) === placeOf(b);
}
