import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectFolder,
  importProjectAsset,
  openProjectFolder,
  projectAssetPath,
  projectFolderName,
  type ProjectFolder,
} from './project-folder.js';

const CLIP = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
const CLIP_NAME = `${sha256(CLIP)}.bin`;

let scratch: string;
let opened: ProjectFolder[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-project-folder-'));
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeSource(name: string, bytes: Buffer): Promise<string> {
  const directory = join(scratch, 'source');
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

describe('projectFolderName', () => {
  it('keeps a readable title and adds the suffix', () => {
    expect(projectFolderName('Trip: Day 1')).toBe('Trip Day 1.joyproj');
  });

  it('falls back to Project for an empty title', () => {
    expect(projectFolderName('   ')).toBe('Project.joyproj');
  });

  it('guards reserved Windows names and trailing dots', () => {
    expect(projectFolderName('CON')).toBe('_CON.joyproj');
    expect(projectFolderName('Final cut. ')).toBe('Final cut.joyproj');
  });
});

describe('project folder lifecycle', () => {
  it('creates NAME.joyproj with a database, assets and cache', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    expect(folder.root).toBe(join(scratch, 'Trip.joyproj'));
    expect(existsSync(join(folder.root, 'project.sqlite'))).toBe(true);
    expect(existsSync(join(folder.root, 'assets'))).toBe(true);
    expect(existsSync(join(folder.root, 'cache'))).toBe(true);
  });

  it('refuses to create over an existing folder', async () => {
    track(await createProjectFolder(scratch, 'Trip'));
    await expect(createProjectFolder(scratch, 'Trip')).rejects.toThrow('already exists');
  });

  it('refuses to open a folder that is not a project', async () => {
    await expect(openProjectFolder(scratch)).rejects.toThrow('project.sqlite is missing');
  });
});

describe('importing originals', () => {
  it('copies the bytes to assets/<sha256>.bin and stores a relative path', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const path = await writeSource('clip.mp4', CLIP);

    const imported = await importProjectAsset(folder, {
      path,
      kind: 'video',
      displayName: 'clip.mp4',
    });

    expect(imported.storedPath).toBe(`assets/${CLIP_NAME}`);
    expect(imported.bytes).toBe(CLIP.length);
    expect(await readFile(join(folder.root, 'assets', CLIP_NAME))).toEqual(CLIP);
    const row = folder.assets.get(imported.assetId);
    expect(row?.displayName).toBe('clip.mp4');
    expect(row?.storedPath).toBe(`assets/${CLIP_NAME}`);
  });

  it('keeps one file per checksum and the first display name', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const first = await importProjectAsset(folder, {
      path: await writeSource('clip.mp4', CLIP),
      kind: 'video',
      displayName: 'clip.mp4',
    });

    const second = await importProjectAsset(folder, {
      path: await writeSource('copy.mp4', CLIP),
      kind: 'video',
      displayName: 'copy.mp4',
    });

    expect(second.assetId).toBe(first.assetId);
    expect(second.displayName).toBe('clip.mp4');
    // The second copy's temporary file is gone, and only the one original is stored.
    expect(await readdir(join(folder.root, 'assets'))).toEqual([CLIP_NAME]);
  });

  it('leaves nothing behind when the source is missing', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));

    await expect(
      importProjectAsset(folder, {
        path: join(scratch, 'missing.mp4'),
        kind: 'video',
        displayName: 'missing.mp4',
      }),
    ).rejects.toThrow();

    expect(await readdir(join(folder.root, 'assets'))).toEqual([]);
  });
});

describe('the document', () => {
  it('saves a revision, refuses a stale write, and reads it back after reopening', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));

    const first = folder.documents.put({
      projectId: 'p1',
      baseRevisionId: '',
      revisionId: 'r1',
      document: { title: 'Trip', clips: 2 },
    });
    const stale = folder.documents.put({
      projectId: 'p1',
      baseRevisionId: 'r0',
      revisionId: 'r2',
      document: { title: 'Old' },
    });
    expect(first).toEqual({ kind: 'saved', revisionId: 'r1' });
    expect(stale.kind).toBe('conflict');

    const root = folder.root;
    forget(folder);
    const reopened = track(await openProjectFolder(root));
    expect(reopened.documents.get('p1')).toEqual({
      projectId: 'p1',
      revisionId: 'r1',
      document: { title: 'Trip', clips: 2 },
    });
  });
});

describe('a copied or damaged folder', () => {
  it('reopens a copy whose original resolves inside the copy', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const imported = await importProjectAsset(folder, {
      path: await writeSource('clip.mp4', CLIP),
      kind: 'video',
      displayName: 'clip.mp4',
    });
    const root = folder.root;
    forget(folder);

    const copyRoot = join(scratch, 'Trip copy.joyproj');
    await cp(root, copyRoot, { recursive: true });
    const copy = track(await openProjectFolder(copyRoot));

    expect(projectAssetPath(copy, imported.assetId)).toBe(join(copyRoot, 'assets', CLIP_NAME));
    expect(await readFile(join(copyRoot, 'assets', CLIP_NAME))).toEqual(CLIP);
  });

  it('reports a deleted original as missing', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const imported = await importProjectAsset(folder, {
      path: await writeSource('clip.mp4', CLIP),
      kind: 'video',
      displayName: 'clip.mp4',
    });

    await unlink(join(folder.root, 'assets', CLIP_NAME));

    expect(projectAssetPath(folder, imported.assetId)).toBeUndefined();
  });

  it('refuses a stored path outside assets/', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const imported = await importProjectAsset(folder, {
      path: await writeSource('clip.mp4', CLIP),
      kind: 'video',
      displayName: 'clip.mp4',
    });

    folder.assets.markStored(imported.assetId, '../escape.bin');

    expect(projectAssetPath(folder, imported.assetId)).toBeUndefined();
  });

  it('recreates a deleted cache folder and keeps the index', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const imported = await importProjectAsset(folder, {
      path: await writeSource('clip.mp4', CLIP),
      kind: 'video',
      displayName: 'clip.mp4',
    });
    const root = folder.root;
    forget(folder);
    await rm(join(root, 'cache'), { recursive: true, force: true });

    const reopened = track(await openProjectFolder(root));

    expect(existsSync(join(root, 'cache'))).toBe(true);
    expect(reopened.assets.get(imported.assetId)?.displayName).toBe('clip.mp4');
    expect(projectAssetPath(reopened, imported.assetId)).toBe(join(root, 'assets', CLIP_NAME));
  });
});
