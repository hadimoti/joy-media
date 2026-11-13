import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssetLibrary } from './asset-library.js';
import type { LocalAsset } from './local-assets.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'joy-asset-library-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function registration(
  overrides: Partial<Omit<LocalAsset, 'storedPath'>> = {},
  bytes = Buffer.from('library media'),
): LocalAsset {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    id: 'asset-1',
    kind: 'image',
    displayName: 'image.png',
    sha256,
    bytes: bytes.byteLength,
    ...overrides,
  };
}

async function writeOriginal(
  temporaryDirectory: string,
  asset: LocalAsset,
  bytes = Buffer.from('library media'),
): Promise<LocalAsset> {
  const storedPath = path.join(temporaryDirectory, `original-${asset.sha256}.bin`);
  await writeFile(storedPath, bytes);
  return { ...asset, storedPath };
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

describe('createAssetLibrary', () => {
  it('adds an image, copies the previous catalog to backup, and copies the original bytes', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const bytes = Buffer.from('library media');
    const asset = await writeOriginal(
      root,
      registration({ descriptor: { mimeType: 'image/png', width: 20 } }, bytes),
      bytes,
    );
    const originalCatalog = JSON.stringify({
      version: 1,
      counts: { total: 0, audio: 0, image: 0 },
      assets: [],
    });
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json'), originalCatalog);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });

    expect(await library.addAsset(asset.id)).toEqual({ ok: true });

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    const id = `joylib-${asset.sha256}`;
    expect(catalog.assets).toHaveLength(1);
    expect(catalog.assets[0]).toMatchObject({ id, relativePath: `images/${id}`, kind: 'image' });
    expect(catalog.counts).toEqual({ total: 1, audio: 0, image: 1, video: 0 });
    expect(await readFile(path.join(directory, `images/${id}`))).toEqual(bytes);
    expect(await readFile(path.join(directory, 'catalog.json.joy-media-backup'), 'utf8')).toBe(
      originalCatalog,
    );
  });

  it('marks an internal export row in the catalog without relying on its name', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const bytes = Buffer.from('internal export bytes');
    const internal = await writeOriginal(
      root,
      {
        ...registration({ id: 'export-attempt-1', kind: 'video', displayName: 'render.stage' }),
        internal: true,
      } as LocalAsset,
      bytes,
    );
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: (assetId) => (assetId === internal.id ? internal : undefined) },
    });

    expect(await library.addAsset(internal.id)).toEqual({ ok: true });

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    expect(catalog.assets).toHaveLength(1);
    expect(catalog.assets[0]).toMatchObject({ internal: true });
  });

  it('keeps a user row when an internal export has the same bytes', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const bytes = Buffer.from('same user and export bytes');
    const user = await writeOriginal(
      root,
      registration({ id: 'user-video', kind: 'video', displayName: 'my-video.mp4' }),
      bytes,
    );
    const internal = await writeOriginal(
      root,
      {
        ...registration({
          id: 'export-attempt-2',
          kind: 'video',
          displayName: 'my-video.mp4.stage',
        }),
        internal: true,
      } as LocalAsset,
      bytes,
    );
    const registrations = new Map([
      [user.id, user],
      [internal.id, internal],
    ]);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: (assetId) => registrations.get(assetId) },
    });

    expect(await library.addAsset(user.id)).toEqual({ ok: true });
    expect(await library.addAsset(internal.id)).toEqual({ ok: true });

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    expect(catalog.assets).toHaveLength(1);
    expect(catalog.assets[0]).toMatchObject({ displayName: 'my-video.mp4' });
    expect(catalog.assets[0].internal).not.toBe(true);
  });

  it('removes an internal row by registration id, never by its content id', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const internal = await writeOriginal(root, {
      ...registration({ id: 'stage-attempt-3', kind: 'video', displayName: 'render.mp4.stage' }),
      internal: true,
    } as LocalAsset);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: (assetId) => (assetId === internal.id ? internal : undefined) },
    });
    await library.addAsset(internal.id);
    const cleanup = (
      library as unknown as {
        removeInternalAsset?: (assetId: string) => Promise<{ readonly removed: boolean }>;
      }
    ).removeInternalAsset;

    expect(cleanup).toBeTypeOf('function');
    await expect(cleanup!.call(library, `joylib-${internal.sha256}`)).resolves.toEqual({
      removed: false,
    });
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets,
    ).toHaveLength(1);
    await expect(cleanup!.call(library, internal.id)).resolves.toEqual({ removed: true });
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets,
    ).toHaveLength(0);
  });

  it('clears leftover internal rows at startup and leaves user rows intact', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const user = await writeOriginal(
      root,
      registration({ id: 'user-image', displayName: 'keep.png' }),
    );
    const internal = await writeOriginal(
      root,
      {
        ...registration({ id: 'stage-attempt-4', kind: 'video', displayName: 'render.mp4.stage' }),
        internal: true,
      } as LocalAsset,
      Buffer.from('leftover export bytes'),
    );
    const registrations = new Map([
      [user.id, user],
      [internal.id, internal],
    ]);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: (assetId) => registrations.get(assetId) },
    });
    await library.addAsset(user.id);
    await library.addAsset(internal.id);
    const cleanup = (library as unknown as { removeInternalEntries?: () => Promise<void> })
      .removeInternalEntries;

    expect(cleanup).toBeTypeOf('function');
    await cleanup!.call(library);

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    expect(catalog.assets).toHaveLength(1);
    expect(catalog.assets[0]).toMatchObject({
      id: `joylib-${user.sha256}`,
      displayName: 'keep.png',
    });
    expect(catalog.counts).toEqual({ total: 1, audio: 0, image: 1, video: 0 });
  });

  it('shows the newest name when the same content is added again under another name', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const bytes = Buffer.from('library media');
    const first = await writeOriginal(
      root,
      registration({ id: 'asset-1', displayName: 'first.png' }, bytes),
      bytes,
    );
    const second = await writeOriginal(
      root,
      registration({ id: 'asset-2', displayName: 'second.png' }, bytes),
      bytes,
    );
    const registrations = new Map([first, second].map((asset) => [asset.id, asset] as const));
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: (assetId) => registrations.get(assetId) },
    });

    expect(await library.addAsset(first.id)).toEqual({ ok: true });
    expect(await library.addAsset(second.id)).toEqual({ ok: true });

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    expect(catalog.assets).toHaveLength(1);
    expect(catalog.counts).toEqual({ total: 1, audio: 0, image: 1, video: 0 });
    expect(catalog.assets[0]).toMatchObject({
      id: `joylib-${first.sha256}`,
      displayName: 'second.png',
      sortName: 'second.png',
    });
  });

  it('renames every legacy entry for the same content', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const bytes = Buffer.from('library media');
    const asset = await writeOriginal(
      root,
      registration({ id: 'asset-1', displayName: 'current.png' }, bytes),
      bytes,
    );
    const id = `joylib-${asset.sha256}`;
    const legacy = {
      id,
      kind: 'image',
      sha256: asset.sha256,
      displayName: 'old.png',
      sortName: 'old.png',
      relativePath: `images/${id}`,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'catalog.json'),
      JSON.stringify({ version: 1, assets: [legacy, legacy] }),
    );
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });

    expect(await library.addAsset(asset.id)).toEqual({ ok: true });

    const catalog = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    expect(catalog.assets.map((item: { displayName: string }) => item.displayName)).toEqual([
      'current.png',
      'current.png',
    ]);
  });

  it('keeps only one entry when the same content is added twice', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets,
    ).toHaveLength(1);
  });

  it('removes a catalog entry without deleting its media file', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = registration();
    const id = `joylib-${asset.sha256}`;
    const mediaPath = path.join(directory, 'images', id);
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(mediaPath, 'keep this media');
    await writeFile(
      path.join(directory, 'catalog.json'),
      JSON.stringify({
        version: 1,
        counts: { total: 1, audio: 0, image: 1, video: 0 },
        assets: [{ id, kind: 'image', relativePath: `images/${id}` }],
      }),
    );
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
    });

    await expect(library.removeEntry(id)).resolves.toEqual({ removed: true });
    expect(JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'))).toMatchObject({
      counts: { total: 0, audio: 0, image: 0, video: 0 },
      assets: [],
    });
    expect(await readFile(mediaPath, 'utf8')).toBe('keep this media');
  });

  it('removes every catalog entry with the requested id', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const id = `joylib-${'d'.repeat(64)}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'catalog.json'),
      JSON.stringify({
        version: 1,
        assets: [{ id, kind: 'image' }, { id, kind: 'image' }, { id: 'other' }],
      }),
    );
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
    });

    await expect(library.removeEntry(id)).resolves.toEqual({ removed: true });
    expect(JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets).toEqual(
      [{ id: 'other' }],
    );
  });

  it('returns removed after the catalog rename even when lock cleanup fails', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const id = `joylib-${'c'.repeat(64)}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'catalog.json'),
      JSON.stringify({ version: 1, assets: [{ id, kind: 'image' }] }),
    );
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
      unlinkLock: async () => {
        throw new Error('lock cleanup failed');
      },
    });

    await expect(library.removeEntry(id)).resolves.toEqual({ removed: true });
    expect(JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets).toEqual(
      [],
    );
  });

  it('returns removed false when the id is not in the catalog', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    await mkdir(directory, { recursive: true });
    const catalog = JSON.stringify({ version: 1, assets: [] });
    await writeFile(path.join(directory, 'catalog.json'), catalog);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
    });

    await expect(library.removeEntry(`joylib-${'a'.repeat(64)}`)).resolves.toEqual({
      removed: false,
    });
    expect(await readFile(path.join(directory, 'catalog.json'), 'utf8')).toBe(catalog);
  });

  it('rejects an invalid id before touching the catalog or library directory', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
    });

    await expect(library.removeEntry('../catalog.json')).rejects.toThrow(
      /Invalid asset library entry id/,
    );
    expect(await exists(directory)).toBe(false);
  });

  it.each([42, { toString: () => `joylib-${'a'.repeat(64)}` }])(
    'rejects a non-string id (%j) with the validation error',
    async (id) => {
      const root = await temporaryDirectory();
      const directory = path.join(root, 'library');
      const library = createAssetLibrary({
        directory: () => directory,
        registrations: { get: () => undefined },
      });

      await expect(library.removeEntry(id as string)).rejects.toThrow(
        /Invalid asset library entry id/,
      );
      expect(await exists(directory)).toBe(false);
    },
  );

  it.each(['write', 'rename'] as const)(
    'leaves the original catalog unchanged and cleans up after a catalog %s failure',
    async (failure) => {
      const root = await temporaryDirectory();
      const directory = path.join(root, 'library');
      const id = `joylib-${'e'.repeat(64)}`;
      const catalogPath = path.join(directory, 'catalog.json');
      const originalCatalog = Buffer.from(JSON.stringify({ version: 1, assets: [{ id }] }));
      await mkdir(directory, { recursive: true });
      await writeFile(catalogPath, originalCatalog);
      const library = createAssetLibrary({
        directory: () => directory,
        registrations: { get: () => undefined },
        ...(failure === 'write'
          ? {
              writeCatalogTemporaryFile: async (filePath: string, data: string) => {
                await writeFile(filePath, data);
                throw new Error('catalog write failed');
              },
            }
          : {
              renameCatalogTemporaryFile: async () => {
                throw new Error('catalog rename failed');
              },
            }),
      });

      await expect(library.removeEntry(id)).rejects.toThrow(`catalog ${failure} failed`);
      expect(await readFile(catalogPath)).toEqual(originalCatalog);
      expect(await exists(`${catalogPath}.lock`)).toBe(false);
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('uses the catalog lock when removing an entry', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const id = `joylib-${'b'.repeat(64)}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'catalog.json'),
      JSON.stringify({ version: 1, assets: [{ id }] }),
    );
    const lockPath = path.join(directory, 'catalog.json.lock');
    await writeFile(lockPath, 'held');
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => undefined },
      lockWaitMs: 20,
    });

    await expect(library.removeEntry(id)).rejects.toThrow(/asset library is busy/i);
    expect(await exists(lockPath)).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets,
    ).toHaveLength(1);
  });

  it.each([
    ['unknown id', undefined, false],
    ['no stored original', {}, false],
    ['bad sha256', { sha256: 'A'.repeat(64) }, true],
    ['unsupported kind', { kind: 'document' }, true],
  ])('fails without writing for %s', async (_name, overrides, hasOriginal) => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = overrides === undefined ? undefined : registration(overrides);
    const storedAsset =
      asset !== undefined && hasOriginal ? await writeOriginal(root, asset) : asset;
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => storedAsset },
    });
    expect(await library.addAsset('asset-1')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The asset library could not be updated: /),
    });
    expect(await exists(path.join(directory, 'catalog.json'))).toBe(false);
    expect(await exists(path.join(directory, 'catalog.json.lock'))).toBe(false);
  });

  it('does not reference a missing original when the copy fails', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = registration();
    const missingOriginal = { ...asset, storedPath: path.join(root, 'missing-original.bin') };
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => missingOriginal },
    });

    expect(await library.addAsset(asset.id)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The asset library could not be updated: /),
    });
    expect(await exists(path.join(directory, 'catalog.json'))).toBe(false);
    expect(await exists(path.join(directory, 'catalog.json.lock'))).toBe(false);
  });

  it('places audio files in audio', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration({ kind: 'audio' }));
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await exists(path.join(directory, 'audio', `joylib-${asset.sha256}`))).toBe(true);
  });

  it('leaves an invalid catalog byte-identical when refusing to update it', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    const invalidCatalog = Buffer.from('{broken catalog');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json'), invalidCatalog);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect((await library.addAsset(asset.id)).ok).toBe(false);
    expect(await readFile(path.join(directory, 'catalog.json'))).toEqual(invalidCatalog);
    expect(await exists(path.join(directory, 'catalog.json.joy-media-backup'))).toBe(false);
    expect(await exists(path.join(directory, `images/joylib-${asset.sha256}`))).toBe(true);
  });

  it('times out on a fresh lock and removes its own lock file', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json.lock'), 'held');
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
      lockWaitMs: 20,
    });
    const result = await library.addAsset(asset.id);
    expect(result).toEqual({
      ok: false,
      error: 'The asset library is busy. Try the import again.',
    });
    expect(await exists(path.join(directory, 'catalog.json'))).toBe(false);
    expect(await exists(path.join(directory, 'catalog.json.lock'))).toBe(true);
  });

  it('copies the original before taking the lock', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json.lock'), 'held');
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
      lockWaitMs: 20,
    });
    const id = `joylib-${asset.sha256}`;
    const targetPath = path.join(directory, 'images', id);

    expect(await library.addAsset(asset.id)).toEqual({
      ok: false,
      error: 'The asset library is busy. Try the import again.',
    });
    expect(await exists(targetPath)).toBe(true);
    expect(await exists(path.join(directory, 'catalog.json'))).toBe(false);
  });

  it('keeps the media file that is already stored when the same content is added again', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });

    const targetPath = path.join(directory, 'images', `joylib-${asset.sha256}`);
    await writeFile(targetPath, 'the bytes that are already stored');

    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await readFile(targetPath, 'utf8')).toBe('the bytes that are already stored');
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')).assets,
    ).toHaveLength(1);
  });

  it('leaves a partial lock token after a write failure until it is stale', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    let failTokenWrite = true;
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
      lockWaitMs: 100,
      writeOwnerToken: async (handle, token) => {
        if (failTokenWrite) {
          failTokenWrite = false;
          await handle.writeFile(token.slice(0, 5));
          throw new Error('token write failed');
        }
        await handle.writeFile(token);
      },
    });
    const lockPath = path.join(directory, 'catalog.json.lock');

    expect(await library.addAsset(asset.id)).toEqual({
      ok: false,
      error: 'The asset library could not be updated: token write failed',
    });
    expect(await exists(lockPath)).toBe(true);
    const staleTime = new Date(Date.now() - 61_000);
    await utimes(lockPath, staleTime, staleTime);
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
  });

  it('removes a stale lock and completes the add', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, 'catalog.json.lock');
    await writeFile(lockPath, 'stale');
    const staleTime = new Date(Date.now() - 61_000);
    await utimes(lockPath, staleTime, staleTime);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await exists(lockPath)).toBe(false);
    expect(await stat(path.join(directory, 'catalog.json'))).toBeDefined();
  });

  it('preserves a different owner token if the lock changes during the add', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    const lockPath = path.join(directory, 'catalog.json.lock');
    await mkdir(directory, { recursive: true });
    const takeoverAsset = {
      ...asset,
      get displayName() {
        writeFileSync(lockPath, 'another-owner-token');
        return asset.displayName;
      },
    };
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => takeoverAsset },
    });

    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await readFile(lockPath, 'utf8')).toBe('another-owner-token');
  });

  it('keeps success when the catalog is written but lock cleanup fails', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    const lockPath = path.join(directory, 'catalog.json.lock');
    let replacedLock = false;
    const takeoverAsset = {
      ...asset,
      get displayName() {
        if (!replacedLock) {
          unlinkSync(lockPath);
          mkdirSync(lockPath);
          replacedLock = true;
        }
        return asset.displayName;
      },
    };
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => takeoverAsset },
    });

    expect(await library.addAsset(asset.id)).toEqual({ ok: true });
    expect(await exists(path.join(directory, 'catalog.json'))).toBe(true);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });

  it('returns prefixed errors when registration or directory lookup throws', async () => {
    const root = await temporaryDirectory();
    const asset = await writeOriginal(root, registration());
    const throwingRegistration = createAssetLibrary({
      directory: () => root,
      registrations: {
        get: () => {
          throw new Error('registration failed');
        },
      },
    });
    const throwingDirectory = createAssetLibrary({
      directory: () => {
        throw new Error('directory failed');
      },
      registrations: { get: () => asset },
    });

    expect(await throwingRegistration.addAsset(asset.id)).toEqual({
      ok: false,
      error: 'The asset library could not be updated: registration failed',
    });
    expect(await throwingDirectory.addAsset(asset.id)).toEqual({
      ok: false,
      error: 'The asset library could not be updated: directory failed',
    });
  });

  it('fails when an existing catalog has no assets array', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'library');
    const asset = await writeOriginal(root, registration());
    await mkdir(directory, { recursive: true });
    const invalidCatalog = '{"version":1}';
    await writeFile(path.join(directory, 'catalog.json'), invalidCatalog);
    const library = createAssetLibrary({
      directory: () => directory,
      registrations: { get: () => asset },
    });
    expect((await library.addAsset(asset.id)).ok).toBe(false);
    expect(await readFile(path.join(directory, 'catalog.json'), 'utf8')).toBe(invalidCatalog);
  });
});
