import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalAssetSchema, SqliteLocalAssetStore } from '../store/local-assets.js';
import { createLocalOriginalWriter, MAX_ORIGINAL_CHUNK_BYTES } from './local-originals.js';

const BYTES = new TextEncoder().encode('chunked original bytes');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'joy-media-chunked-'));
  tempDirs.push(root);
  const db = new DatabaseSync(':memory:');
  ensureLocalAssetSchema(db);
  const assets = new SqliteLocalAssetStore(db, () => 'T0');
  assets.register({
    id: 'asset-1',
    kind: 'video',
    displayName: 'clip.mp4',
    sha256: SHA256,
    bytes: BYTES.byteLength,
  });
  const directory = join(root, 'originals');
  return { directory, writer: createLocalOriginalWriter({ directory, assets }) };
}

/** Temporary files of unfinished uploads, which must never outlive the upload. */
function partialFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.upload'));
  } catch {
    return [];
  }
}

describe('chunked original uploads', () => {
  it('commits the file under its checksum once every piece has arrived', async () => {
    const { directory, writer } = setup();

    expect(await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 10))).toEqual({
      ok: true,
    });
    expect(await writer.appendOriginalChunk('asset-1', 10, BYTES.subarray(10))).toEqual({
      ok: true,
    });
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({ ok: true });

    expect(readFileSync(join(directory, `${SHA256}.bin`))).toEqual(Buffer.from(BYTES));
    expect(partialFiles(directory)).toEqual([]);
  });

  it('refuses a piece that does not start where the last one ended', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 5));

    expect(await writer.appendOriginalChunk('asset-1', 9, BYTES.subarray(9))).toEqual({
      ok: false,
      error: 'Original upload is out of order',
    });
    expect(partialFiles(directory)).toEqual([]);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original upload is incomplete',
    });
  });

  it('refuses a piece that repeats bytes already written, and drops the upload', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 10));

    expect(await writer.appendOriginalChunk('asset-1', 5, BYTES.subarray(5, 10))).toEqual({
      ok: false,
      error: 'Original upload is out of order',
    });
    expect(partialFiles(directory)).toEqual([]);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original upload is incomplete',
    });
  });

  it('refuses a piece that would make the upload larger than its registration', async () => {
    const { writer } = setup();

    expect(
      await writer.appendOriginalChunk('asset-1', 0, new Uint8Array(BYTES.byteLength + 1)),
    ).toEqual({ ok: false, error: 'Original size does not match its registration' });
  });

  it('refuses a finish that is short of the registered size, and removes the file', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 5));

    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original size does not match its registration',
    });
    expect(partialFiles(directory)).toEqual([]);
    expect(existsSync(join(directory, `${SHA256}.bin`))).toBe(false);
  });

  it('refuses a piece above the one-message limit', async () => {
    const { writer } = setup();

    expect(
      await writer.appendOriginalChunk('asset-1', 0, new Uint8Array(MAX_ORIGINAL_CHUNK_BYTES + 1)),
    ).toEqual({ ok: false, error: 'Original piece is larger than one message allows' });
  });

  it('refuses a finished upload whose bytes do not match the checksum, and removes it', async () => {
    const { directory, writer } = setup();
    const wrong = new Uint8Array(BYTES);
    wrong[0] = wrong[0]! ^ 0xff;
    await writer.appendOriginalChunk('asset-1', 0, wrong);

    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original does not match its registered checksum',
    });
    expect(partialFiles(directory)).toEqual([]);
    expect(existsSync(join(directory, `${SHA256}.bin`))).toBe(false);
  });

  it('removes an unfinished upload when the renderer aborts it', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 4));

    await writer.abortOriginalUpload('asset-1');

    expect(partialFiles(directory)).toEqual([]);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original upload is incomplete',
    });
  });

  it('ignores an abort when there is no upload to drop', async () => {
    const { writer } = setup();

    await expect(writer.abortOriginalUpload('asset-1')).resolves.toBeUndefined();
    await expect(writer.abortAllOriginalUploads()).resolves.toBeUndefined();
  });

  it('drops every unfinished upload on quit, and removes its temporary file', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 4));

    await writer.abortAllOriginalUploads();

    expect(partialFiles(directory)).toEqual([]);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original upload is incomplete',
    });
  });

  it('removes temporary files left by an earlier run when the writer starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-media-chunked-'));
    tempDirs.push(root);
    const directory = join(root, 'originals');
    mkdirSync(directory);
    writeFileSync(join(directory, 'left-behind.upload'), 'partial');
    writeFileSync(join(directory, `${SHA256}.bin`), BYTES);
    const db = new DatabaseSync(':memory:');
    ensureLocalAssetSchema(db);

    createLocalOriginalWriter({ directory, assets: new SqliteLocalAssetStore(db, () => 'T0') });

    expect(partialFiles(directory)).toEqual([]);
    expect(readFileSync(join(directory, `${SHA256}.bin`))).toEqual(Buffer.from(BYTES));
  });

  it('keeps two pieces that arrive together in order', async () => {
    const { directory, writer } = setup();

    const results = await Promise.all([
      writer.appendOriginalChunk('asset-1', 0, BYTES.subarray(0, 10)),
      writer.appendOriginalChunk('asset-1', 10, BYTES.subarray(10)),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({ ok: true });
    expect(readFileSync(join(directory, `${SHA256}.bin`))).toEqual(Buffer.from(BYTES));
  });

  it('commits an upload whose checksum file already exists, and keeps that file', async () => {
    const { directory, writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({ ok: true });

    await writer.appendOriginalChunk('asset-1', 0, BYTES);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({ ok: true });
    expect(partialFiles(directory)).toEqual([]);
    expect(readFileSync(join(directory, `${SHA256}.bin`))).toEqual(Buffer.from(BYTES));
  });

  it('refuses a second finish once the upload has been committed', async () => {
    const { writer } = setup();
    await writer.appendOriginalChunk('asset-1', 0, BYTES);
    expect(await writer.finishOriginalUpload('asset-1')).toEqual({ ok: true });

    expect(await writer.finishOriginalUpload('asset-1')).toEqual({
      ok: false,
      error: 'Original upload is incomplete',
    });
  });

  it('reports a storage failure with the fixed message when the originals folder is a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-media-chunked-'));
    tempDirs.push(root);
    const blocker = join(root, 'originals');
    writeFileSync(blocker, 'not a folder');
    const db = new DatabaseSync(':memory:');
    ensureLocalAssetSchema(db);
    const assets = new SqliteLocalAssetStore(db, () => 'T0');
    assets.register({
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: SHA256,
      bytes: BYTES.byteLength,
    });
    const writer = createLocalOriginalWriter({ directory: blocker, assets });

    expect(await writer.appendOriginalChunk('asset-1', 0, BYTES)).toEqual({
      ok: false,
      error: 'Original could not be stored',
    });
  });

  it('refuses a chunk for an asset that is not registered', async () => {
    const { writer } = setup();

    expect(await writer.appendOriginalChunk('missing', 0, BYTES)).toEqual({
      ok: false,
      error: 'Asset is not registered',
    });
  });
});
