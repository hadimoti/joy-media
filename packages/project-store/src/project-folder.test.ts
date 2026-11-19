import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectFolder,
  importProjectAsset,
  openProjectFolder,
  projectAssetPath,
  projectFolderName,
  type ProjectFolder,
} from './project-folder.js';

// Fault and race injection at the file-system boundary. The hook runs once, just before the real `link` or `rename`
// of a publication, and then the real call runs, so the bytes and names on disk are real.
const hooks = vi.hoisted(() => ({
  beforePublish: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const runHook = async (from: string, to: string): Promise<void> => {
    const hook = hooks.beforePublish;
    hooks.beforePublish = undefined;
    if (hook !== undefined) await hook(from, to);
  };
  return {
    ...actual,
    link: async (from: string, to: string) => {
      await runHook(from, to);
      return actual.link(from, to);
    },
    rename: async (from: string, to: string) => {
      await runHook(from, to);
      return actual.rename(from, to);
    },
  };
});

const CLIP = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
const CLIP_NAME = `${sha256(CLIP)}.bin`;

let scratch: string;
let opened: ProjectFolder[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-project-folder-'));
  opened = [];
});

afterEach(async () => {
  hooks.beforePublish = undefined;
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

  it('refuses a re-import when the stored original has other bytes of the same length, and keeps that file', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const path = await writeSource('clip.mp4', CLIP);
    await importProjectAsset(folder, { path, kind: 'video', displayName: 'clip.mp4' });

    // Same length as CLIP, one byte changed: the size matches, the checksum does not.
    const corrupt = Buffer.from(
      Array.from(CLIP, (byte, index) => (index === 0 ? (byte + 1) % 256 : byte)),
    );
    expect(corrupt.length).toBe(CLIP.length);
    expect(corrupt.equals(CLIP)).toBe(false);
    const storedPath = join(folder.root, 'assets', CLIP_NAME);
    await writeFile(storedPath, corrupt);

    await expect(
      importProjectAsset(folder, { path, kind: 'video', displayName: 'clip.mp4' }),
    ).rejects.toThrow(/checksum/u);

    // No silent overwrite: the corrupt stored file is kept as it was, and no temporary copy is left behind.
    expect(await readFile(storedPath)).toEqual(corrupt);
    expect(await readdir(join(folder.root, 'assets'))).toEqual([CLIP_NAME]);
  });

  it('removes its partial copy when publishing the original fails', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const path = await writeSource('clip.mp4', CLIP);
    hooks.beforePublish = async () => {
      throw Object.assign(new Error('EPERM: publication refused'), { code: 'EPERM' });
    };

    await expect(
      importProjectAsset(folder, { path, kind: 'video', displayName: 'clip.mp4' }),
    ).rejects.toThrow('publication refused');

    expect(await readdir(join(folder.root, 'assets'))).toEqual([]);
    expect(folder.assets.get(`asset-${sha256(CLIP)}`)).toBeUndefined();
  });

  it('never replaces a file that appears under the stored name during the import', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const path = await writeSource('clip.mp4', CLIP);
    // Another writer stores different bytes of the same length under the name, after the import found no file there.
    const other = Buffer.from(
      Array.from(CLIP, (byte, index) => (index === 0 ? (byte + 1) % 256 : byte)),
    );
    const storedPath = join(folder.root, 'assets', CLIP_NAME);
    hooks.beforePublish = async (_from, to) => {
      await writeFile(to, other);
    };

    await expect(
      importProjectAsset(folder, { path, kind: 'video', displayName: 'clip.mp4' }),
    ).rejects.toThrow(/checksum/u);

    expect(await readFile(storedPath)).toEqual(other);
    expect(await readdir(join(folder.root, 'assets'))).toEqual([CLIP_NAME]);
    expect(folder.assets.get(`asset-${sha256(CLIP)}`)).toBeUndefined();
  });

  it('keeps a file that appears under the stored name with the same bytes as the duplicate', async () => {
    const folder = track(await createProjectFolder(scratch, 'Trip'));
    const path = await writeSource('clip.mp4', CLIP);
    hooks.beforePublish = async (_from, to) => {
      await writeFile(to, CLIP);
    };

    const imported = await importProjectAsset(folder, {
      path,
      kind: 'video',
      displayName: 'clip.mp4',
    });

    expect(imported.storedPath).toBe(`assets/${CLIP_NAME}`);
    expect(await readFile(join(folder.root, 'assets', CLIP_NAME))).toEqual(CLIP);
    expect(await readdir(join(folder.root, 'assets'))).toEqual([CLIP_NAME]);
    expect(folder.assets.get(imported.assetId)?.storedPath).toBe(`assets/${CLIP_NAME}`);
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
