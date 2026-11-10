import type * as NodeFs from 'node:fs';
import { realpathSync, statSync } from 'node:fs';
import { cp, mkdtemp, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openProjectClaimRegistry,
  readProjectClaim,
  type ProjectClaimRegistry,
} from './project-claim-registry.js';
import {
  ProjectClaimBusyError,
  ProjectClaimRefusedError,
  ProjectClaimRollbackError,
  answerProjectFolderAsk,
  claimProjectFolderId,
  identityFromStats,
  isBusyError,
  openProjectFolderForEditing,
  recordNewProjectFolder,
  resolveProjectFolderAsCopy,
  resolveProjectFolderAsOriginal,
} from './project-folder-identity.js';
import {
  PROJECT_DATABASE_FILE,
  createProjectFolder,
  openProjectFolder,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
  type ProjectFolderEntry,
} from './project-folder.js';

/**
 * Folder identities the tests fake: a path that reads as another folder's identity (a clone), or a
 * path whose read fails with a given code. Every other path is read from the disk as usual.
 */
const identityFaults = vi.hoisted(
  () => new Map<string, { identity?: { dev: bigint; ino: bigint }; code?: string }>(),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const { resolve: resolvePath } = await import('node:path');
  return {
    ...actual,
    statSync: (target: string, options?: unknown) => {
      const fault = identityFaults.get(resolvePath(target));
      if (fault?.code !== undefined) {
        throw Object.assign(new Error(`${fault.code}: simulated`), { code: fault.code });
      }
      if (fault?.identity !== undefined) return fault.identity;
      return actual.statSync(target, options as Parameters<typeof actual.statSync>[1]);
    },
  };
});

const ID = 'project-trip';

/** The real path of a folder: where the registry and the home path store it. */
const real = (path: string): string => realpathSync.native(path);

let scratch: string;
let registryPath: string;
let registry: ProjectClaimRegistry;
let opened: ProjectFolder[];
let rivals: ProjectClaimRegistry[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-project-identity-'));
  registryPath = join(scratch, 'app-data', 'project-claims.sqlite');
  registry = openProjectClaimRegistry(registryPath);
  opened = [];
  rivals = [];
});

afterEach(async () => {
  identityFaults.clear();
  for (const folder of opened) folder.close();
  for (const rival of rivals) rival.close();
  registry.close();
  await rm(scratch, { recursive: true, force: true });
});

function track(folder: ProjectFolder): ProjectFolder {
  opened.push(folder);
  return folder;
}

function forget(folder: ProjectFolder): void {
  folder.close();
  opened = opened.filter((item) => item !== folder);
}

function entryFor(root: string, id: string): ProjectFolderEntry {
  return {
    id,
    title: 'Trip',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    timelineProjectId: id,
    visualProjectId: id,
    homeRoot: root,
  };
}

/** A project folder made in place and recorded as the original of its id, with a saved document. */
async function createOriginal(name: string, id: string): Promise<ProjectFolder> {
  const folder = track(await createProjectFolder(scratch, name));
  recordNewProjectFolder(folder, entryFor(folder.root, id), registry);
  folder.documents.put({
    projectId: id,
    baseRevisionId: '',
    revisionId: 'r1',
    document: { id, title: 'Trip' },
    lookInstances: { id, instances: {} },
  });
  return folder;
}

/**
 * A recorded original, copied, and the copy opened. The copy's home is the original's old place.
 */
async function openedCopyOfOriginal(): Promise<{
  readonly copy: ProjectFolder;
  readonly copyRoot: string;
  readonly originalRoot: string;
}> {
  const original = await createOriginal('Trip', ID);
  const originalRoot = original.root;
  forget(original);
  const copyRoot = join(scratch, 'Trip copy.joyproj');
  await cp(originalRoot, copyRoot, { recursive: true });
  return { copy: track(await openProjectFolder(copyRoot)), copyRoot, originalRoot };
}

/** A recorded original copied, then moved away. The copy is opened; its home is the old place. */
async function originalMovedAwayFromCopy(): Promise<{
  readonly copy: ProjectFolder;
  readonly movedRoot: string;
  readonly originalRoot: string;
  /** The original's real path, taken before it moved. */
  readonly originalReal: string;
}> {
  const { copyRoot, originalRoot } = await openedCopyOfOriginal();
  const originalReal = real(originalRoot);
  const movedRoot = join(scratch, 'Moved trip.joyproj');
  await rename(originalRoot, movedRoot);
  return { copy: track(await openProjectFolder(copyRoot)), movedRoot, originalRoot, originalReal };
}

describe('new id on open', () => {
  it('a folder recorded when it was made keeps its id on every open', async () => {
    const original = await createOriginal('Trip', ID);

    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(original.root));
    expect(claimProjectFolderId(original, registry)).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(original)?.id).toBe(ID);
  });

  it('a folder with no record asks, even where it is home, and nothing is written', async () => {
    const unrecorded = track(await createProjectFolder(scratch, 'Unrecorded'));
    writeProjectFolderEntry(unrecorded, entryFor(unrecorded.root, 'project-unrecorded'));

    expect(claimProjectFolderId(unrecorded, registry)).toEqual({
      kind: 'ask',
      reason: 'no-record',
    });
    expect(readProjectClaim(registry, 'project-unrecorded')).toBeUndefined();

    expect(resolveProjectFolderAsOriginal(unrecorded, registry)).toEqual({ kind: 'claimed' });
    expect(claimProjectFolderId(unrecorded, registry)).toEqual({ kind: 'kept' });
  });

  it('a copy gets a new id when it is opened, and the original keeps its id', async () => {
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    forget(original);
    const copyRoot = join(scratch, 'Trip copy.joyproj');
    await cp(originalRoot, copyRoot, { recursive: true });
    const copy = track(await openProjectFolder(copyRoot));

    const claim = claimProjectFolderId(copy, registry);

    expect(claim.kind).toBe('renewed');
    if (claim.kind !== 'renewed') throw new Error('expected a renewed id');
    expect(claim.previousId).toBe(ID);
    expect(claim.id).toMatch(/^project-/);
    const renewed = readProjectFolderEntry(copy);
    expect(renewed?.id).toBe(claim.id);
    expect(renewed?.timelineProjectId).toBe(claim.id);
    expect(renewed?.visualProjectId).toBe(claim.id);
    expect(renewed?.homeRoot).toBe(real(copyRoot));
    expect(copy.documents.get(claim.id)?.document).toEqual({ id: claim.id, title: 'Trip' });
    expect(copy.documents.get(claim.id)?.lookInstances).toEqual({ id: claim.id, instances: {} });
    expect(copy.documents.get(ID)).toBeUndefined();
    expect(readProjectClaim(registry, claim.id)?.folderPath).toBe(real(copyRoot));

    const reopenedOriginal = track(await openProjectFolder(originalRoot));
    expect(claimProjectFolderId(reopenedOriginal, registry)).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(reopenedOriginal)?.id).toBe(ID);
    expect(reopenedOriginal.documents.get(ID)?.document).toEqual({ id: ID, title: 'Trip' });
    expect(claimProjectFolderId(copy, registry)).toEqual({ kind: 'kept' });
  });

  it('a copy opened while its original is away asks, and does not take the id', async () => {
    const { copy, movedRoot, originalReal } = await originalMovedAwayFromCopy();

    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'claimant-missing',
      recordedPath: originalReal,
    });
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);

    const moved = track(await openProjectFolder(movedRoot));
    expect(claimProjectFolderId(moved, registry)).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(moved)?.homeRoot).toBe(real(movedRoot));
    expect(claimProjectFolderId(copy, registry).kind).toBe('renewed');
  });

  it('a folder that only sits where the original was does not count as the original', async () => {
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    forget(original);
    const movedRoot = join(scratch, 'Moved trip.joyproj');
    await rename(originalRoot, movedRoot);
    // A new folder with the same content, in the old place.
    await cp(movedRoot, originalRoot, { recursive: true });
    const impostor = track(await openProjectFolder(originalRoot));

    expect(claimProjectFolderId(impostor, registry)).toMatchObject({
      kind: 'ask',
      reason: 'claimant-missing',
    });
    const moved = track(await openProjectFolder(movedRoot));
    expect(claimProjectFolderId(moved, registry)).toEqual({ kind: 'kept' });
  });

  it('a clone of a live original is asked about, and the owner can settle it as the copy', async () => {
    const { copy, copyRoot, originalRoot } = await openedCopyOfOriginal();
    // The clone reads as the original: a bit-for-bit copy of a drive keeps the file identities.
    const original = statSync(originalRoot, { bigint: true });
    identityFaults.set(resolve(copyRoot), { identity: { dev: original.dev, ino: original.ino } });

    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'duplicate-identity',
      recordedPath: real(originalRoot),
    });
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);
    expect(resolveProjectFolderAsCopy(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });

    const reopened = track(await openProjectFolder(originalRoot));
    expect(claimProjectFolderId(reopened, registry)).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(copy)?.id).not.toBe(ID);
  });

  it('the owner can make the clone the original, and the other folder then asks', async () => {
    const { copy, copyRoot, originalRoot } = await openedCopyOfOriginal();
    const original = statSync(originalRoot, { bigint: true });
    identityFaults.set(resolve(copyRoot), { identity: { dev: original.dev, ino: original.ino } });

    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'duplicate-identity',
    });
    // A live holder with the same identity does not refuse the answer: the owner decides.
    expect(resolveProjectFolderAsOriginal(copy, registry)).toEqual({ kind: 'claimed' });

    const reopened = track(await openProjectFolder(originalRoot));
    expect(claimProjectFolderId(reopened, registry)).toMatchObject({
      kind: 'ask',
      reason: 'duplicate-identity',
    });
  });

  it('a junction to a project folder is the same folder, not a clone', async () => {
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    const junction = join(scratch, 'Trip link');
    await symlink(originalRoot, junction, 'junction');
    const viaJunction = track(await openProjectFolder(junction));
    try {
      expect(claimProjectFolderId(viaJunction, registry)).toEqual({ kind: 'kept' });
      // The home path keeps its real place: opening through the alias does not rewrite it.
      expect(readProjectFolderEntry(viaJunction)?.homeRoot).toBe(real(originalRoot));
      expect(() => resolveProjectFolderAsCopy(viaJunction, registry)).toThrow('recorded original');
      expect(claimProjectFolderId(original, registry)).toEqual({ kind: 'kept' });
    } finally {
      forget(viaJunction);
      // Removes the junction itself, not the folder it points to.
      await rmdir(junction);
    }
  });

  it('a folder recorded through an alias is stored by its real place', async () => {
    const folder = track(await createProjectFolder(scratch, 'Aliased'));
    const realRoot = real(folder.root);
    const alias = join(scratch, 'Aliased link');
    await symlink(folder.root, alias, 'junction');
    const viaAlias = track(await openProjectFolder(alias));
    try {
      recordNewProjectFolder(viaAlias, entryFor(alias, ID), registry);
      expect(readProjectClaim(registry, ID)?.folderPath).toBe(realRoot);
      expect(readProjectFolderEntry(viaAlias)?.homeRoot).toBe(realRoot);
    } finally {
      forget(viaAlias);
      await rmdir(alias);
    }
    // With the alias gone, the real place keeps its record and is the original.
    const atRealPlace = track(await openProjectFolder(realRoot));
    expect(claimProjectFolderId(atRealPlace, registry)).toEqual({ kind: 'kept' });
  });

  it('a recorded place on a volume that is not mounted is unverifiable, not gone', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();
    identityFaults.set(real(originalRoot), { code: 'ENOENT' });
    identityFaults.set(resolve(parse(originalRoot).root), { code: 'ENOENT' });

    expect(claimProjectFolderId(copy, registry)).toEqual({ kind: 'unverifiable' });
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);
  });

  it('a recorded place that is no longer a folder asks as missing', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();
    identityFaults.set(real(originalRoot), { code: 'ENOTDIR' });

    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'claimant-missing',
      recordedPath: real(originalRoot),
    });
  });

  it('the owner can settle an ask as a copy, which gives it a new id', async () => {
    const { copy, movedRoot } = await originalMovedAwayFromCopy();
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'claimant-missing',
    });

    expect(resolveProjectFolderAsCopy(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    const moved = track(await openProjectFolder(movedRoot));
    expect(claimProjectFolderId(moved, registry)).toEqual({ kind: 'kept' });
  });

  it('the owner can settle an ask as the original, and the other folder then becomes the copy', async () => {
    const { copy, movedRoot } = await originalMovedAwayFromCopy();
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'ask',
      reason: 'claimant-missing',
    });

    expect(resolveProjectFolderAsOriginal(copy, registry)).toEqual({ kind: 'claimed' });
    const moved = track(await openProjectFolder(movedRoot));
    expect(claimProjectFolderId(moved, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);
  });

  it('the owner cannot take the place of a recorded original that is still in place', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();

    expect(() => resolveProjectFolderAsOriginal(copy, registry)).toThrow(ProjectClaimRefusedError);
    expect(() => resolveProjectFolderAsOriginal(copy, registry)).toThrow(
      'still where it was recorded',
    );
    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);
  });

  it('the recorded original cannot be settled as a copy', async () => {
    const original = await createOriginal('Trip', ID);

    expect(() => resolveProjectFolderAsCopy(original, registry)).toThrow(ProjectClaimRefusedError);
    expect(() => resolveProjectFolderAsCopy(original, registry)).toThrow('recorded original');
    expect(readProjectFolderEntry(original)?.id).toBe(ID);
  });

  it('a lost registry does not let a copy take the id from its original', async () => {
    // The original is moved, and a copy of it is put back at the original's old place.
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    forget(original);
    const movedRoot = join(scratch, 'Moved trip.joyproj');
    await rename(originalRoot, movedRoot);
    await cp(movedRoot, originalRoot, { recursive: true });
    // The registry is lost.
    registry.close();
    await rm(registryPath, { force: true });
    registry = openProjectClaimRegistry(registryPath);
    const copy = track(await openProjectFolder(originalRoot));
    const moved = track(await openProjectFolder(movedRoot));

    expect(claimProjectFolderId(copy, registry)).toEqual({ kind: 'ask', reason: 'no-record' });
    expect(claimProjectFolderId(moved, registry)).toEqual({ kind: 'ask', reason: 'no-record' });
    expect(readProjectClaim(registry, ID)).toBeUndefined();

    expect(resolveProjectFolderAsOriginal(moved, registry)).toEqual({ kind: 'claimed' });
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    expect(readProjectFolderEntry(moved)?.id).toBe(ID);
  });

  it('two folders that share an id: the owner settles the first, and the other renews', async () => {
    const first = track(await createProjectFolder(scratch, 'Stray one'));
    const second = track(await createProjectFolder(scratch, 'Stray two'));
    writeProjectFolderEntry(first, entryFor(first.root, 'project-stray'));
    writeProjectFolderEntry(second, entryFor(second.root, 'project-stray'));

    expect(claimProjectFolderId(first, registry)).toEqual({ kind: 'ask', reason: 'no-record' });
    expect(resolveProjectFolderAsOriginal(first, registry)).toEqual({ kind: 'claimed' });
    expect(claimProjectFolderId(second, registry)).toMatchObject({
      kind: 'renewed',
      previousId: 'project-stray',
    });
    expect(readProjectFolderEntry(first)?.id).toBe('project-stray');
  });

  it('the editable gate hands out a folder only for a settled claim', async () => {
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    forget(original);
    const copyRoot = join(scratch, 'Trip copy.joyproj');
    await cp(originalRoot, copyRoot, { recursive: true });
    await rename(originalRoot, join(scratch, 'Moved trip.joyproj'));

    const held = await openProjectFolderForEditing(copyRoot, registry);
    expect(held).toMatchObject({
      kind: 'held',
      claim: { kind: 'ask', reason: 'claimant-missing' },
    });

    expect(await answerProjectFolderAsk(copyRoot, registry, 'copy')).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    const editable = await openProjectFolderForEditing(copyRoot, registry);
    if (editable.kind !== 'editable') throw new Error('expected an editable folder');
    track(editable.folder);
    expect(editable.claim).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(editable.folder)?.id).not.toBe(ID);
  });

  it('the editable gate holds a folder whose identity cannot be read', async () => {
    const { copyRoot } = await openedCopyOfOriginal();
    identityFaults.set(resolve(copyRoot), { code: 'EIO' });

    expect(await openProjectFolderForEditing(copyRoot, registry)).toEqual({
      kind: 'held',
      claim: { kind: 'unverifiable' },
    });
  });

  it('recording a folder refuses an id that a live clone at another place holds', async () => {
    const { copy, copyRoot, originalRoot } = await openedCopyOfOriginal();
    // The copy reads as a clone of the original: same identity, and the original is still live.
    const original = statSync(originalRoot, { bigint: true });
    identityFaults.set(resolve(copyRoot), { identity: { dev: original.dev, ino: original.ino } });

    expect(() => recordNewProjectFolder(copy, entryFor(copyRoot, ID), registry)).toThrow(
      'already recorded for another folder',
    );
    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
  });

  it('a folder without a catalog entry is left alone', async () => {
    const empty = track(await createProjectFolder(scratch, 'Empty'));

    expect(claimProjectFolderId(empty, registry)).toEqual({ kind: 'none' });
  });

  it('a claim cannot run inside another claim on the same copy, so the copy keeps one id', async () => {
    const { copy: first, copyRoot } = await openedCopyOfOriginal();
    const second = track(await openProjectFolder(copyRoot));
    const rival = openProjectClaimRegistry(registryPath);
    rivals.push(rival);
    rival.database.exec('PRAGMA busy_timeout = 0');

    let interleaved: unknown;
    const claim = claimProjectFolderId(first, registry, () => {
      // Runs while the first claim holds the registry lock and the copy's write lock, as a second
      // open would.
      try {
        claimProjectFolderId(second, rival, () => 'project-second');
      } catch (error) {
        interleaved = error;
      }
      return 'project-first';
    });

    expect(interleaved).toBeInstanceOf(ProjectClaimBusyError);
    expect(claim).toEqual({ kind: 'renewed', previousId: ID, id: 'project-first' });
    expect(readProjectFolderEntry(first)?.id).toBe('project-first');
    expect(first.documents.get('project-first')?.document).toEqual({
      id: 'project-first',
      title: 'Trip',
    });
    expect(first.documents.get('project-second')).toBeUndefined();
    expect(first.documents.get(ID)).toBeUndefined();
  });

  it('a claim that cannot lock the folder throws, and writes nothing', async () => {
    const { copy, copyRoot, originalRoot } = await openedCopyOfOriginal();
    const blocker = new DatabaseSync(join(copyRoot, PROJECT_DATABASE_FILE));
    try {
      blocker.exec('BEGIN IMMEDIATE');

      expect(() => claimProjectFolderId(copy, registry, () => 'project-blocked')).toThrow(
        ProjectClaimBusyError,
      );
      expect(readProjectClaim(registry, 'project-blocked')).toBeUndefined();
      expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
      expect(readProjectFolderEntry(copy)?.id).toBe(ID);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
  });

  it('a folder commit that fails leaves the folder with its old id, and the copy renews later', async () => {
    const { copy, copyRoot } = await openedCopyOfOriginal();
    // A read blocks a commit only under the default rollback journal, which this test relies on.
    expect(copy.database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    const reader = new DatabaseSync(join(copyRoot, PROJECT_DATABASE_FILE));
    try {
      // A read that stays open blocks the folder's commit. The registry commit can still happen.
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM project_folder_entry').get();

      expect(() => claimProjectFolderId(copy, registry, () => 'project-next')).toThrow(
        ProjectClaimBusyError,
      );
      expect(readProjectFolderEntry(copy)?.id).toBe(ID);
      expect(copy.documents.get(ID)?.document).toEqual({ id: ID, title: 'Trip' });
      expect(copy.documents.get('project-next')).toBeUndefined();
      // By design, the registry keeps the record its commit wrote. No folder holds that id.
      expect(readProjectClaim(registry, 'project-next')).toBeDefined();
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
  });

  it('a registry commit that fails leaves the folder with its old id', async () => {
    const { copy } = await openedCopyOfOriginal();
    registry.database.exec('PRAGMA busy_timeout = 0');
    const reader = new DatabaseSync(registryPath);
    try {
      // A read that stays open blocks the registry's commit, which comes first.
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM project_claims').get();

      expect(() => claimProjectFolderId(copy, registry, () => 'project-next')).toThrow(
        ProjectClaimBusyError,
      );
      expect(readProjectFolderEntry(copy)?.id).toBe(ID);
      expect(copy.documents.get(ID)?.document).toEqual({ id: ID, title: 'Trip' });
      expect(copy.documents.get('project-next')).toBeUndefined();
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
    expect(readProjectClaim(registry, 'project-next')).toBeUndefined();
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
  });

  it('recording a new folder can be retried after its folder commit failed', async () => {
    const folder = track(await createProjectFolder(scratch, 'Retry'));
    const entry = entryFor(folder.root, 'project-retry');
    const reader = new DatabaseSync(join(folder.root, PROJECT_DATABASE_FILE));
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM project_folder_entry').get();

      expect(() => recordNewProjectFolder(folder, entry, registry)).toThrow(ProjectClaimBusyError);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
    // The entry was not written, but the registry kept the record its commit wrote.
    expect(readProjectFolderEntry(folder)).toBeUndefined();
    expect(readProjectClaim(registry, 'project-retry')?.folderIdentity).toBeDefined();

    recordNewProjectFolder(folder, entry, registry);

    expect(claimProjectFolderId(folder, registry)).toEqual({ kind: 'kept' });
  });

  it('a retry of recording keeps the stored entry, whatever the caller passes', async () => {
    const folder = track(await createProjectFolder(scratch, 'Keeps'));
    recordNewProjectFolder(folder, entryFor(folder.root, ID), registry);

    recordNewProjectFolder(
      folder,
      { ...entryFor(folder.root, ID), title: 'Other title', updatedAt: '2030-01-01T00:00:00.000Z' },
      registry,
    );

    expect(readProjectFolderEntry(folder)).toMatchObject({
      id: ID,
      title: 'Trip',
      updatedAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it('recording a folder refuses a folder that already holds another project id', async () => {
    const folder = track(await createProjectFolder(scratch, 'Holds one'));
    writeProjectFolderEntry(folder, entryFor(folder.root, 'project-first-id'));

    expect(() =>
      recordNewProjectFolder(folder, entryFor(folder.root, 'project-second-id'), registry),
    ).toThrow('already holds a different project id');
    expect(readProjectFolderEntry(folder)?.id).toBe('project-first-id');
  });

  it('a failed folder rollback is reported, and the registry stays usable', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();
    let failRollback = true;
    // The copy's connection, with its ROLLBACK made to fail while the flag is set.
    const database = new Proxy(copy.database, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'exec') {
          return (sql: string) => {
            if (failRollback && sql === 'ROLLBACK') throw new Error('simulated rollback failure');
            return target.exec(sql);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stub: ProjectFolder = { ...copy, database };

    let failure: unknown;
    try {
      // Refused, because the original is still where it was recorded. Then the rollback fails.
      resolveProjectFolderAsOriginal(stub, registry);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectClaimRollbackError);
    const original = (failure as ProjectClaimRollbackError).original;
    expect(original).toBeInstanceOf(ProjectClaimRefusedError);
    expect((original as Error).message).toMatch(/still where it was recorded/);

    // The copy's transaction is still open, because its rollback was made to fail. Run the real one.
    failRollback = false;
    copy.database.exec('ROLLBACK');
    // The registry was rolled back regardless, so a later claim on it works.
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
  });

  it('a failed registry rollback is reported, and the registry works again once it is rolled back', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();
    let failRollback = true;
    // The registry's connection, with its ROLLBACK made to fail while the flag is set.
    const database = new Proxy(registry.database, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'exec') {
          return (sql: string) => {
            if (failRollback && sql === 'ROLLBACK') throw new Error('simulated rollback failure');
            return target.exec(sql);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stub: ProjectClaimRegistry = { database, close: () => registry.close() };

    let failure: unknown;
    try {
      resolveProjectFolderAsOriginal(copy, stub);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectClaimRollbackError);
    expect(((failure as ProjectClaimRollbackError).original as Error).message).toMatch(
      /still where it was recorded/,
    );

    // The registry's transaction is still open, because its rollback was made to fail. Run the real one.
    failRollback = false;
    registry.database.exec('ROLLBACK');
    expect(claimProjectFolderId(copy, registry)).toMatchObject({
      kind: 'renewed',
      previousId: ID,
    });
    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
  });

  it('a folder whose path is missing is unverifiable, and nothing is written', async () => {
    const { copy, originalRoot } = await openedCopyOfOriginal();
    const missing: ProjectFolder = { ...copy, root: join(scratch, 'Not here.joyproj') };

    expect(claimProjectFolderId(missing, registry)).toEqual({ kind: 'unverifiable' });
    expect(readProjectFolderEntry(copy)?.id).toBe(ID);
    expect(readProjectClaim(registry, ID)?.folderPath).toBe(real(originalRoot));
  });

  it('a stored document that does not name the old id is kept byte for byte', async () => {
    const original = track(await createProjectFolder(scratch, 'Plain'));
    recordNewProjectFolder(original, entryFor(original.root, ID), registry);
    original.documents.put({
      projectId: ID,
      baseRevisionId: '',
      revisionId: 'r1',
      document: { id: 'project-other', title: 'Trip', values: [1.5, 2] },
      lookInstances: { id: 'project-other', instances: {} },
    });
    const originalRoot = original.root;
    forget(original);
    const copyRoot = join(scratch, 'Plain copy.joyproj');
    await cp(originalRoot, copyRoot, { recursive: true });
    const copy = track(await openProjectFolder(copyRoot));
    const before = copy.database
      .prepare('SELECT document_json, look_instances_json FROM project_documents')
      .get();

    const claim = claimProjectFolderId(copy, registry);

    if (claim.kind !== 'renewed') throw new Error('expected a renewed id');
    const after = copy.database
      .prepare(
        'SELECT document_json, look_instances_json FROM project_documents WHERE project_id = ?',
      )
      .get(claim.id);
    expect(after).toEqual(before);
  });

  it('only the top-level id and the document key name the project in the folder schema', async () => {
    const { copy } = await openedCopyOfOriginal();
    copy.assets.register({
      id: `asset-${'a'.repeat(64)}`,
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 10,
    });

    const tables = copy.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    // Every column whose name mentions a project, whether or not a row holds the id yet.
    const projectColumns = tables.flatMap((table) =>
      (copy.database.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[])
        .filter((column) => /project/i.test(column.name))
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(projectColumns).toEqual(['project_documents.project_id']);
  });

  it('after a renewal, no table in the copy still names the old id', async () => {
    const { copy } = await openedCopyOfOriginal();
    copy.assets.register({
      id: `asset-${'a'.repeat(64)}`,
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 10,
    });

    expect(claimProjectFolderId(copy, registry).kind).toBe('renewed');
    const tables = copy.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toContain('project_documents');
    for (const { name } of tables) {
      for (const row of copy.database.prepare(`SELECT * FROM "${name}"`).all()) {
        expect(JSON.stringify(row)).not.toContain(ID);
      }
    }
  });

  it('a renewal renames every reference to the old id and keeps the other fields', async () => {
    const original = track(await createProjectFolder(scratch, 'Nested'));
    recordNewProjectFolder(
      original,
      {
        ...entryFor(original.root, ID),
        title: 'T'.repeat(200),
        timelineProjectId: 'timeline-other',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-02-02T00:00:00.000Z',
      },
      registry,
    );
    original.documents.put({
      projectId: ID,
      baseRevisionId: '',
      revisionId: 'r1',
      document: {
        id: ID,
        title: 'Trip',
        clips: [{ id: 'clip-1', projectId: ID }],
        byProject: { [ID]: 'kept' },
      },
      lookInstances: { id: ID, instances: { 'inst-1': { projectId: ID } } },
    });
    const originalRoot = original.root;
    forget(original);
    const copyRoot = join(scratch, 'Nested copy.joyproj');
    await cp(originalRoot, copyRoot, { recursive: true });
    const copy = track(await openProjectFolder(copyRoot));

    const claim = claimProjectFolderId(copy, registry);
    if (claim.kind !== 'renewed') throw new Error('expected a renewed id');

    expect(readProjectFolderEntry(copy)).toMatchObject({
      id: claim.id,
      title: 'T'.repeat(200),
      timelineProjectId: 'timeline-other',
      visualProjectId: claim.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
      homeRoot: real(copyRoot),
    });
    expect(copy.documents.get(claim.id)?.document).toEqual({
      id: claim.id,
      title: 'Trip',
      clips: [{ id: 'clip-1', projectId: claim.id }],
      byProject: { [claim.id]: 'kept' },
    });
    expect(copy.documents.get(claim.id)?.lookInstances).toEqual({
      id: claim.id,
      instances: { 'inst-1': { projectId: claim.id } },
    });
    expect(copy.documents.get(ID)).toBeUndefined();
  });
});

describe('folder identity', () => {
  it('a volume that gives no identities gives none', () => {
    expect(identityFromStats({ dev: 1n, ino: 0n })).toBeUndefined();
    expect(identityFromStats({ dev: 1n, ino: 42n })).toBe('1:42');
  });
});

describe('busy errors', () => {
  it('recognises the busy and locked codes, with or without extended bits, and nothing else', () => {
    const coded = (errcode: number): Error =>
      Object.assign(new Error('database is locked'), { errcode });

    expect(isBusyError(coded(5))).toBe(true);
    expect(isBusyError(coded(6))).toBe(true);
    expect(isBusyError(coded(517))).toBe(true);
    expect(isBusyError(coded(773))).toBe(true);
    expect(isBusyError(coded(19))).toBe(false);
    expect(isBusyError(new Error('database is locked'))).toBe(false);
    expect(isBusyError('database is locked')).toBe(false);
  });
});
