import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectFolder,
  listProjectFolders,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
  type ProjectFolderEntry,
} from './project-folder.js';

const ENTRY: ProjectFolderEntry = {
  id: 'p1',
  title: 'Trip',
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  timelineProjectId: 't1',
  visualProjectId: 'v1',
};

let scratch: string;
let opened: ProjectFolder[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-project-folder-entry-'));
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

describe('the catalog entry', () => {
  it('stores one entry per folder and returns the latest', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    expect(readProjectFolderEntry(folder)).toBeUndefined();

    writeProjectFolderEntry(folder, ENTRY);
    writeProjectFolderEntry(folder, {
      ...ENTRY,
      title: 'Trip 2',
      updatedAt: '2026-11-11T00:00:00.000Z',
    });

    expect(readProjectFolderEntry(folder)?.title).toBe('Trip 2');
    const count = folder.database
      .prepare('SELECT COUNT(*) AS total FROM project_folder_entry')
      .get() as { total: number };
    expect(count.total).toBe(1);
  });

  it('keeps a trashed time when one is set', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    writeProjectFolderEntry(folder, { ...ENTRY, trashedAt: '2026-11-12T00:00:00.000Z' });
    expect(readProjectFolderEntry(folder)?.trashedAt).toBe('2026-11-12T00:00:00.000Z');
  });
});

describe('listing project folders', () => {
  it('returns nothing for a folder that does not exist', async () => {
    expect(await listProjectFolders(join(scratch, 'missing'))).toEqual([]);
  });

  it('lists each folder with its entry, and reports a folder without one', async () => {
    const trip = track(await createProjectFolder(scratch, 'Trip'));
    writeProjectFolderEntry(trip, ENTRY);
    track(await createProjectFolder(scratch, 'Notes'));

    const listing = await listProjectFolders(scratch);

    expect(listing).toEqual([
      { root: join(scratch, 'Notes.joyproj'), problem: 'no catalog entry' },
      { root: join(scratch, 'Trip.joyproj'), entry: ENTRY },
    ]);
  });

  it('ignores items that are not NAME.joyproj folders', async () => {
    const trip = track(await createProjectFolder(scratch, 'Trip'));
    writeProjectFolderEntry(trip, ENTRY);
    await mkdir(join(scratch, 'Photos'));
    await writeFile(join(scratch, 'Other.joyproj'), 'a file, not a folder');

    const listing = await listProjectFolders(scratch);

    expect(listing.map((item) => item.root)).toEqual([join(scratch, 'Trip.joyproj')]);
  });

  it('reports a corrupt project.sqlite as a problem and still lists the other folders', async () => {
    const alpha = track(await createProjectFolder(scratch, 'Alpha'));
    writeProjectFolderEntry(alpha, { ...ENTRY, id: 'p-alpha', title: 'Alpha' });
    const alphaRoot = alpha.root;
    forget(alpha);
    await writeFile(join(alphaRoot, 'project.sqlite'), 'this is not a database');

    const beta = track(await createProjectFolder(scratch, 'Beta'));
    writeProjectFolderEntry(beta, { ...ENTRY, id: 'p-beta', title: 'Beta' });

    const listing = await listProjectFolders(scratch);

    expect(listing[0]?.root).toBe(alphaRoot);
    expect(listing[0]?.entry).toBeUndefined();
    expect(listing[0]?.problem).toEqual(expect.any(String));
    expect(listing[1]?.entry?.title).toBe('Beta');
  });

  it('reports a malformed entry as a problem', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    folder.database.exec(
      `INSERT INTO project_folder_entry (id, entry_json) VALUES (1, '{"id": 1}')`,
    );

    const listing = await listProjectFolders(scratch);

    expect(listing).toEqual([
      { root: join(scratch, 'Trip.joyproj'), problem: 'The project folder entry is malformed' },
    ]);
  });
});
