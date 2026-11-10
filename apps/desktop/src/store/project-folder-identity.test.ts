import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimProjectFolderId } from './project-folder-identity.js';
import {
  createProjectFolder,
  listProjectFolders,
  openProjectFolder,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
  type ProjectFolderEntry,
} from './project-folder.js';

const ID = 'project-trip';

let scratch: string;
let opened: ProjectFolder[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-project-identity-'));
  opened = [];
});

afterEach(async () => {
  for (const folder of opened) folder.close();
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

/** A project folder created in place, with an entry and a saved document that names its id. */
async function createOriginal(name: string, id: string): Promise<ProjectFolder> {
  const folder = track(await createProjectFolder(scratch, name));
  writeProjectFolderEntry(folder, entryFor(folder.root, id));
  folder.documents.put({
    projectId: id,
    baseRevisionId: '',
    revisionId: 'r1',
    document: { id, title: 'Trip' },
    lookInstances: { id, instances: {} },
  });
  return folder;
}

describe('new id on open', () => {
  it('an original folder keeps its id when it is opened', async () => {
    const original = await createOriginal('Trip', ID);

    const claim = claimProjectFolderId(original, await listProjectFolders(scratch));

    expect(claim).toEqual({ kind: 'kept' });
    expect(readProjectFolderEntry(original)?.id).toBe(ID);
  });

  it('a copy gets a new id when it is opened, and the original keeps its id', async () => {
    const original = await createOriginal('Trip', ID);
    const originalRoot = original.root;
    forget(original);
    const copyRoot = join(scratch, 'Trip copy.joyproj');
    await cp(originalRoot, copyRoot, { recursive: true });
    const copy = track(await openProjectFolder(copyRoot));

    const claim = claimProjectFolderId(copy, await listProjectFolders(scratch));

    expect(claim.kind).toBe('renewed');
    if (claim.kind !== 'renewed') throw new Error('expected a renewed id');
    expect(claim.previousId).toBe(ID);
    expect(claim.id).not.toBe(ID);
    expect(claim.id).toMatch(/^project-/);
    const renewed = readProjectFolderEntry(copy);
    expect(renewed?.id).toBe(claim.id);
    expect(renewed?.timelineProjectId).toBe(claim.id);
    expect(renewed?.visualProjectId).toBe(claim.id);
    expect(renewed?.homeRoot).toBe(copyRoot);
    expect(copy.documents.get(claim.id)?.document).toEqual({ id: claim.id, title: 'Trip' });
    expect(copy.documents.get(claim.id)?.lookInstances).toEqual({ id: claim.id, instances: {} });
    expect(copy.documents.get(ID)).toBeUndefined();

    const reopenedOriginal = track(await openProjectFolder(originalRoot));
    expect(claimProjectFolderId(reopenedOriginal, await listProjectFolders(scratch))).toEqual({
      kind: 'kept',
    });
    expect(readProjectFolderEntry(reopenedOriginal)?.id).toBe(ID);
    expect(reopenedOriginal.documents.get(ID)?.document).toEqual({ id: ID, title: 'Trip' });
  });

  it('a folder that was moved, with no other holder of its id, keeps the id and claims its place', async () => {
    const moved = track(await createProjectFolder(scratch, 'Moved'));
    writeProjectFolderEntry(moved, {
      ...entryFor(moved.root, 'project-moved'),
      homeRoot: join(scratch, 'Old place.joyproj'),
    });

    const claim = claimProjectFolderId(moved, await listProjectFolders(scratch));

    expect(claim).toEqual({ kind: 'claimed' });
    expect(readProjectFolderEntry(moved)?.id).toBe('project-moved');
    expect(readProjectFolderEntry(moved)?.homeRoot).toBe(moved.root);
  });

  it('when no folder is home for a shared id, the first one opened claims it and the next one renews', async () => {
    const first = track(await createProjectFolder(scratch, 'Stray one'));
    const second = track(await createProjectFolder(scratch, 'Stray two'));
    const gone = join(scratch, 'Gone.joyproj');
    writeProjectFolderEntry(first, { ...entryFor(first.root, 'project-stray'), homeRoot: gone });
    writeProjectFolderEntry(second, { ...entryFor(second.root, 'project-stray'), homeRoot: gone });

    expect(claimProjectFolderId(second, await listProjectFolders(scratch))).toEqual({
      kind: 'claimed',
    });

    const next = claimProjectFolderId(first, await listProjectFolders(scratch));
    expect(next.kind).toBe('renewed');
    if (next.kind !== 'renewed') throw new Error('expected a renewed id');
    expect(next.id).not.toBe('project-stray');
    expect(readProjectFolderEntry(second)?.id).toBe('project-stray');
  });

  it('a folder without a catalog entry is left alone', async () => {
    const empty = track(await createProjectFolder(scratch, 'Empty'));

    expect(claimProjectFolderId(empty, await listProjectFolders(scratch))).toEqual({
      kind: 'none',
    });
  });
});
