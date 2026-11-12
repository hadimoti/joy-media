import { createHash } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectFolder,
  openProjectFolder,
  readProjectFolderEntry,
  writeProjectFolderEntry,
  type ProjectFolder,
} from './project-folder.js';
import {
  projectFolderMediaStates,
  readProjectFolderDocument,
  readProjectFolderMedia,
  saveProjectFolder,
} from './project-folder-editing.js';

const CLIP = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 31) % 256));
const CLIP_SHA = createHash('sha256').update(CLIP).digest('hex');
const CLIP_ID = `joylib-${CLIP_SHA}`;

let scratch: string;
let opened: ProjectFolder[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-pf-editing-'));
  opened = [];
});

afterEach(async () => {
  for (const folder of opened.splice(0)) folder.close();
  await rm(scratch, { recursive: true, force: true });
});

async function newFolder(title = 'Summer'): Promise<ProjectFolder> {
  const folder = await createProjectFolder(join(scratch, 'projects'), title, () => 't0');
  writeProjectFolderEntry(folder, {
    id: 'project-1',
    title,
    createdAt: 't0',
    updatedAt: 't0',
    timelineProjectId: 'project-1',
    visualProjectId: 'project-1',
  });
  opened.push(folder);
  return folder;
}

async function reopen(folder: ProjectFolder): Promise<ProjectFolder> {
  folder.close();
  opened = opened.filter((item) => item !== folder);
  const again = await openProjectFolder(folder.root);
  opened.push(again);
  return again;
}

async function source(name: string, bytes: Buffer = CLIP): Promise<string> {
  const directory = join(scratch, 'source');
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

const DOCUMENT = { timeline: { id: 'project-1' }, visual: { id: 'project-1', assets: {} } };

describe('saving a folder project and opening it again', () => {
  it('has no saved project before the first save', async () => {
    const folder = await newFolder();
    expect(readProjectFolderDocument(folder)).toBeUndefined();
  });

  it('keeps the document and copies the media into the folder, so a reopen finds both', async () => {
    let folder = await newFolder();
    const result = await saveProjectFolder(
      folder,
      {
        projectId: 'project-1',
        baseRevisionId: '',
        revisionId: 'r1',
        title: 'Summer',
        document: DOCUMENT,
        media: [
          {
            assetId: CLIP_ID,
            kind: 'video',
            displayName: 'beach.mp4',
            sha256: CLIP_SHA,
            sourcePath: await source('beach.mp4'),
          },
        ],
      },
      () => 't1',
    );
    expect(result).toEqual({ kind: 'saved', revisionId: 'r1', notStored: [] });
    // The original is removed from where the desktop kept it: the folder holds its own copy.
    await unlink(join(scratch, 'source', 'beach.mp4'));

    folder = await reopen(folder);
    expect(readProjectFolderDocument(folder)).toEqual({
      projectId: 'project-1',
      revisionId: 'r1',
      document: DOCUMENT,
    });
    expect(await readdir(join(folder.root, 'assets'))).toEqual([`${CLIP_SHA}.bin`]);
    expect(projectFolderMediaStates(folder, [CLIP_ID])).toEqual([
      {
        assetId: CLIP_ID,
        present: true,
        bytes: CLIP.length,
        sha256: CLIP_SHA,
        displayName: 'beach.mp4',
      },
    ]);
    const chunk = await readProjectFolderMedia(folder, CLIP_ID, 0);
    expect(chunk?.total).toBe(CLIP.length);
    expect(Buffer.from(chunk?.bytes ?? new Uint8Array()).equals(CLIP)).toBe(true);
    expect(readProjectFolderEntry(folder)).toMatchObject({ id: 'project-1', updatedAt: 't1' });
  });

  it('reads stored media in pieces from an offset', async () => {
    const folder = await newFolder();
    await saveProjectFolder(folder, {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: DOCUMENT,
      media: [
        {
          assetId: CLIP_ID,
          kind: 'video',
          displayName: 'beach.mp4',
          sourcePath: await source('a'),
        },
      ],
    });
    const piece = await readProjectFolderMedia(folder, CLIP_ID, 4000, 2000);
    expect(piece).toMatchObject({ offset: 4000, total: CLIP.length });
    expect(Buffer.from(piece?.bytes ?? new Uint8Array()).equals(CLIP.subarray(4000))).toBe(true);
    expect(await readProjectFolderMedia(folder, CLIP_ID, CLIP.length + 1)).toBeUndefined();
    expect(await readProjectFolderMedia(folder, 'joylib-unknown', 0)).toBeUndefined();
  });

  it('names media with no readable original as not stored, and still saves the document', async () => {
    const folder = await newFolder();
    const result = await saveProjectFolder(folder, {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: DOCUMENT,
      media: [
        { assetId: 'joylib-none', kind: 'image', displayName: 'logo.png' },
        {
          assetId: 'joylib-gone',
          kind: 'image',
          displayName: 'gone.png',
          sourcePath: join(scratch, 'no-such-file'),
        },
      ],
    });
    expect(result).toEqual({
      kind: 'saved',
      revisionId: 'r1',
      notStored: ['joylib-none', 'joylib-gone'],
    });
    expect(readProjectFolderDocument(folder)?.revisionId).toBe('r1');
    expect(projectFolderMediaStates(folder, ['joylib-none'])).toEqual([
      { assetId: 'joylib-none', present: false },
    ]);
  });

  it('refuses media whose bytes do not match the checksum the editor named', async () => {
    const folder = await newFolder();
    const result = await saveProjectFolder(folder, {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: DOCUMENT,
      media: [
        {
          assetId: CLIP_ID,
          kind: 'video',
          displayName: 'beach.mp4',
          sha256: CLIP_SHA,
          sourcePath: await source('other.mp4', Buffer.from('other bytes')),
        },
      ],
    });
    expect(result).toMatchObject({ kind: 'saved', notStored: [CLIP_ID] });
    expect(
      (await readdir(join(folder.root, 'assets'))).filter((name) => !name.startsWith('.')),
    ).toEqual([]);
  });

  it('refuses a save built on an old revision, and keeps the newer one', async () => {
    const folder = await newFolder();
    const base = { projectId: 'project-1', title: 'Summer', document: DOCUMENT, media: [] };
    await saveProjectFolder(folder, { ...base, baseRevisionId: '', revisionId: 'r1' });
    await saveProjectFolder(folder, { ...base, baseRevisionId: 'r1', revisionId: 'r2' });
    await expect(
      saveProjectFolder(folder, { ...base, baseRevisionId: 'r1', revisionId: 'r3' }),
    ).resolves.toEqual({ kind: 'conflict', revisionId: 'r2' });
    expect(readProjectFolderDocument(folder)?.revisionId).toBe('r2');
  });

  it('refuses a save for another project id', async () => {
    const folder = await newFolder();
    await expect(
      saveProjectFolder(folder, {
        projectId: 'project-other',
        baseRevisionId: '',
        revisionId: 'r1',
        title: 'Summer',
        document: DOCUMENT,
        media: [],
      }),
    ).resolves.toEqual({ kind: 'wrong-project' });
    expect(readProjectFolderDocument(folder)).toBeUndefined();
  });

  it('keeps the title the editor saves in the folder entry', async () => {
    const folder = await newFolder();
    await saveProjectFolder(folder, {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: '  Summer final ',
      document: DOCUMENT,
      media: [],
    });
    expect(readProjectFolderEntry(folder)?.title).toBe('Summer final');
  });
});

describe('a copied folder', () => {
  it('reads the saved row of its old id until it is saved under its new id, then keeps one row', async () => {
    const original = await newFolder();
    await saveProjectFolder(original, {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: DOCUMENT,
      media: [
        {
          assetId: CLIP_ID,
          kind: 'video',
          displayName: 'beach.mp4',
          sourcePath: await source('b'),
        },
      ],
    });
    original.close();
    opened = opened.filter((item) => item !== original);
    const copyRoot = join(scratch, 'projects', 'Summer copy.joyproj');
    cpSync(original.root, copyRoot, { recursive: true });
    const copy = await openProjectFolder(copyRoot);
    opened.push(copy);
    // The claim gives a copy a new id; here the entry is written as the claim would.
    const entry = readProjectFolderEntry(copy);
    if (entry === undefined) throw new Error('expected an entry');
    writeProjectFolderEntry(copy, {
      ...entry,
      id: 'project-2',
      timelineProjectId: 'project-2',
      visualProjectId: 'project-2',
    });

    expect(readProjectFolderDocument(copy)).toMatchObject({
      projectId: 'project-1',
      revisionId: 'r1',
    });
    expect(projectFolderMediaStates(copy, [CLIP_ID])[0]?.present).toBe(true);

    await expect(
      saveProjectFolder(copy, {
        projectId: 'project-2',
        baseRevisionId: '',
        revisionId: 'c1',
        title: 'Summer copy',
        document: { ...DOCUMENT, timeline: { id: 'project-2' } },
        media: [{ assetId: CLIP_ID, kind: 'video', displayName: 'beach.mp4' }],
      }),
    ).resolves.toEqual({ kind: 'saved', revisionId: 'c1', notStored: [] });
    const rows = copy.database.prepare('SELECT project_id FROM project_documents').all();
    expect(rows).toEqual([{ project_id: 'project-2' }]);

    const originalAgain = await openProjectFolder(original.root);
    opened.push(originalAgain);
    expect(readProjectFolderDocument(originalAgain)).toMatchObject({
      projectId: 'project-1',
      revisionId: 'r1',
    });
    expect(existsSync(join(copyRoot, 'assets', `${CLIP_SHA}.bin`))).toBe(true);
  });
});
