import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
    expect(await exists(path.join(directory, `images/joylib-${asset.sha256}`))).toBe(false);
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
