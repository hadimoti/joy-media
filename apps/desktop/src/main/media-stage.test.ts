import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileRegistry } from './file-registry.js';
import { createMediaStage, MAX_STAGED_BYTES, type MediaStage } from './media-stage.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('media stage', () => {
  let root: string;
  let stageDir: string;
  let recordMedia: ReturnType<typeof vi.fn>;
  let stage: MediaStage;
  let registry: ReturnType<typeof createFileRegistry>;
  let refCount: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'joy-media-stage-'));
    stageDir = join(root, 'staged');
    recordMedia = vi.fn();
    refCount = 0;
    registry = createFileRegistry(() => `ref-${++refCount}`);
    stage = createMediaStage({
      directory: stageDir,
      registry,
      localDatabase: { recordMedia },
      now: () => 'T0',
    });
  });

  afterEach(async () => {
    await stage.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function upload(bytes: Uint8Array, chunkBytes = 4) {
    const begun = await stage.begin({
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      displayName: 'clip.mp4',
    });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      await stage.chunk({
        uploadId: begun.uploadId,
        offset,
        data: bytes.slice(offset, offset + chunkBytes),
      });
    }
    return stage.finish({ uploadId: begun.uploadId });
  }

  it('stores a chunked upload under its hash and registers it for the Worker', async () => {
    const bytes = new TextEncoder().encode('original media bytes');
    const ref = await upload(bytes);

    const stored = join(stageDir, `${sha256(bytes)}.bin`);
    expect(readFileSync(stored)).toEqual(Buffer.from(bytes));
    expect(registry.resolvePath(ref)).toBe(stored);
    expect(recordMedia).toHaveBeenCalledWith({
      refId: ref.id,
      checksum: sha256(bytes),
      kind: 'video',
      byteSize: bytes.byteLength,
      lastVerifiedAt: 'T0',
    });
  });

  it('refuses a chunk that arrives out of order and keeps the upload usable', async () => {
    const bytes = new TextEncoder().encode('abcdefgh');
    const begun = await stage.begin({ sha256: sha256(bytes), bytes: 8, displayName: 'clip.mp4' });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    await expect(
      stage.chunk({ uploadId: begun.uploadId, offset: 4, data: bytes.slice(4) }),
    ).rejects.toThrow('out of order');
    await stage.chunk({ uploadId: begun.uploadId, offset: 0, data: bytes.slice(0, 4) });
    await stage.chunk({ uploadId: begun.uploadId, offset: 4, data: bytes.slice(4) });
    await expect(stage.finish({ uploadId: begun.uploadId })).resolves.toMatchObject({
      kind: 'local-file',
    });
  });

  it('refuses a chunk that would exceed the declared size', async () => {
    const begun = await stage.begin({
      sha256: sha256(new Uint8Array(4)),
      bytes: 4,
      displayName: 'clip.mp4',
    });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    await expect(
      stage.chunk({ uploadId: begun.uploadId, offset: 0, data: new Uint8Array(5) }),
    ).rejects.toThrow('exceeds the declared size');
  });

  it('fails finish and removes the partial file when the bytes do not match the hash', async () => {
    const declared = new TextEncoder().encode('expected');
    const begun = await stage.begin({
      sha256: sha256(declared),
      bytes: declared.byteLength,
      displayName: 'clip.mp4',
    });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    await stage.chunk({
      uploadId: begun.uploadId,
      offset: 0,
      data: new TextEncoder().encode('tampered'),
    });
    await expect(stage.finish({ uploadId: begun.uploadId })).rejects.toThrow(
      'did not match the hash',
    );
    expect(readdirSync(join(stageDir, 'incoming'))).toEqual([]);
    expect(existsSync(join(stageDir, `${sha256(declared)}.bin`))).toBe(false);
    expect(recordMedia).not.toHaveBeenCalled();
  });

  it('reuses a verified cached copy instead of asking for the bytes again', async () => {
    const bytes = new TextEncoder().encode('reused media');
    await upload(bytes);

    const again = await stage.begin({
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      displayName: 'clip.mp4',
    });
    expect(again).toMatchObject({ status: 'cached', ref: { kind: 'local-file' } });
  });

  it('does not trust a cached file whose contents no longer match its hash', async () => {
    const bytes = new TextEncoder().encode('reused media');
    await upload(bytes);
    // Same size, different content: the cache must notice and ask for a fresh upload.
    writeFileSync(join(stageDir, `${sha256(bytes)}.bin`), new TextEncoder().encode('reused MEDIA'));

    const again = await stage.begin({
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      displayName: 'clip.mp4',
    });
    expect(again.status).toBe('upload');
  });

  it('refuses malformed hashes, so a renderer cannot steer the cache path', async () => {
    await expect(
      stage.begin({ sha256: '../../escape', bytes: 3, displayName: 'clip.mp4' }),
    ).rejects.toThrow('hash is invalid');
    await expect(
      stage.begin({ sha256: 'a'.repeat(64), bytes: MAX_STAGED_BYTES + 1, displayName: 'clip.mp4' }),
    ).rejects.toThrow('larger than the local Worker');
    await expect(
      stage.begin({ sha256: 'a'.repeat(64), bytes: 3, displayName: 'nested/clip.mp4' }),
    ).rejects.toThrow('name is invalid');
  });

  it('removes a partial upload when the renderer aborts it', async () => {
    const begun = await stage.begin({
      sha256: sha256(new Uint8Array(8)),
      bytes: 8,
      displayName: 'clip.mp4',
    });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    await stage.chunk({ uploadId: begun.uploadId, offset: 0, data: new Uint8Array(4) });
    expect(readdirSync(join(stageDir, 'incoming'))).toHaveLength(1);

    await stage.abort({ uploadId: begun.uploadId });
    expect(readdirSync(join(stageDir, 'incoming'))).toEqual([]);
    await expect(
      stage.chunk({ uploadId: begun.uploadId, offset: 4, data: new Uint8Array(4) }),
    ).rejects.toThrow('Unknown or expired');
  });

  it('clears partial uploads left behind by an earlier process', async () => {
    const begun = await stage.begin({
      sha256: sha256(new Uint8Array(8)),
      bytes: 8,
      displayName: 'clip.mp4',
    });
    if (begun.status !== 'upload') throw new Error('expected an upload');
    await stage.close();

    // A new process starts with a fresh stage: leftovers from the old one must not survive.
    writeFileSync(join(stageDir, 'incoming', 'orphan.part'), 'stale');
    stage = createMediaStage({
      directory: stageDir,
      registry,
      localDatabase: { recordMedia },
      now: () => 'T1',
    });
    expect(readdirSync(join(stageDir, 'incoming'))).toEqual([]);
  });

  it('evicts the oldest unused copies when the cache is over budget, and keeps copies in use', async () => {
    await stage.close();
    stage = createMediaStage({
      directory: stageDir,
      registry,
      localDatabase: { recordMedia },
      now: () => 'T0',
      cacheBudgetBytes: 10,
    });
    const oldHash = 'b'.repeat(64);
    const oldPath = join(stageDir, `${oldHash}.bin`);
    writeFileSync(oldPath, new Uint8Array(8));
    utimesSync(oldPath, new Date(1_000), new Date(1_000));

    const bytes = new Uint8Array(8).fill(7);
    const ref = await upload(bytes);
    const kept = join(stageDir, `${sha256(bytes)}.bin`);

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(registry.resolvePath(ref)).toBe(kept);
  });

  it('reports a cached copy only when its size matches the declared size', async () => {
    const bytes = new TextEncoder().encode('sized');
    await upload(bytes);
    expect(await stage.cachedPath(sha256(bytes), bytes.byteLength)).toBeDefined();
    expect(await stage.cachedPath(sha256(bytes), bytes.byteLength + 1)).toBeUndefined();
    expect(await stage.cachedPath('../nope', 1)).toBeUndefined();
  });
});
