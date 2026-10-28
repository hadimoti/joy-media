import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalAssetSchema, SqliteLocalAssetStore } from '../store/local-assets.js';
import { createLocalOriginalWriter } from './local-originals.js';

const BYTES = new TextEncoder().encode('original bytes');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-media-originals-'));
  tempDirs.push(dir);
  return dir;
}

function createAssets(): SqliteLocalAssetStore {
  const db = new DatabaseSync(':memory:');
  ensureLocalAssetSchema(db);
  const assets = new SqliteLocalAssetStore(db, () => 'T0');
  assets.register({
    id: 'asset-1',
    kind: 'video',
    displayName: 'clip.webm.stage',
    sha256: SHA256,
    bytes: BYTES.byteLength,
  });
  return assets;
}

describe('createLocalOriginalWriter', () => {
  it('stores the original under its checksum and marks the asset as stored', async () => {
    const directory = join(tempDir(), 'originals');
    const assets = createAssets();
    const writer = createLocalOriginalWriter({ directory, assets });

    await expect(writer.storeOriginal('asset-1', BYTES)).resolves.toEqual({ ok: true });
    expect(assets.storedPath('asset-1')).toBe(join(directory, `${SHA256}.bin`));
    expect(readdirSync(directory)).toEqual([`${SHA256}.bin`]);
  });

  it('keeps a file already stored under the same checksum and leaves no partial file', async () => {
    const directory = tempDir();
    writeFileSync(join(directory, `${SHA256}.bin`), BYTES);
    const writer = createLocalOriginalWriter({ directory, assets: createAssets() });

    await expect(writer.storeOriginal('asset-1', BYTES)).resolves.toEqual({ ok: true });
    expect(readdirSync(directory)).toEqual([`${SHA256}.bin`]);
  });

  it('refuses an unregistered asset, a size mismatch and a checksum mismatch', async () => {
    const writer = createLocalOriginalWriter({ directory: tempDir(), assets: createAssets() });

    await expect(writer.storeOriginal('missing', BYTES)).resolves.toEqual({
      ok: false,
      error: 'Asset is not registered',
    });
    await expect(
      writer.storeOriginal('asset-1', new Uint8Array(BYTES.byteLength + 1)),
    ).resolves.toEqual({ ok: false, error: 'Original size does not match its registration' });
    await expect(
      writer.storeOriginal('asset-1', new TextEncoder().encode('ORIGINAL BYTES')),
    ).resolves.toEqual({ ok: false, error: 'Original does not match its registered checksum' });
  });

  it('answers a filesystem failure with a fixed message that carries no path', async () => {
    const root = tempDir();
    const blocker = join(root, 'originals');
    writeFileSync(blocker, 'a file where the folder should be');
    const assets = createAssets();
    const writer = createLocalOriginalWriter({ directory: blocker, assets });

    const result = await writer.storeOriginal('asset-1', BYTES);

    expect(result).toEqual({ ok: false, error: 'Original could not be stored' });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(assets.storedPath('asset-1')).toBeUndefined();
  });
});
