import { describe, expect, it } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import {
  isMediaMissing,
  relinkMissingMedia,
  verifyReplacementMedia,
  type RelinkCache,
} from './media-relink.js';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const original = new TextEncoder().encode('original clip bytes');
const replacementSameSize = new TextEncoder().encode('tampered clip bytes');

async function recordFor(bytes: Uint8Array): Promise<AssetRecordV1> {
  return {
    id: 'asset-clip',
    kind: 'video',
    displayName: 'clip.mp4',
    sha256: await sha256(bytes),
    bytes: bytes.byteLength,
    descriptor: { mimeType: 'video/mp4' },
  };
}

function memoryCache(): RelinkCache & {
  writes: Array<{ descriptor: OriginalAssetDescriptor; file: Blob }>;
} {
  const stored = new Map<string, Blob>();
  const writes: Array<{ descriptor: OriginalAssetDescriptor; file: Blob }> = [];
  return {
    writes,
    async get(assetId) {
      return stored.get(assetId);
    },
    async put(descriptor, file) {
      writes.push({ descriptor, file });
      stored.set(descriptor.assetId, file);
    },
  };
}

describe('media relink verification', () => {
  it('accepts a replacement whose hash and byte length match the original record', async () => {
    const record = await recordFor(original);
    const verdict = await verifyReplacementMedia(record, new Blob([original]));
    expect(verdict).toEqual({ ok: true });
  });

  it('refuses a replacement with the same size but different bytes', async () => {
    const record = await recordFor(original);
    const verdict = await verifyReplacementMedia(record, new Blob([replacementSameSize]));
    expect(verdict).toEqual({ ok: false, reason: 'hash-mismatch' });
  });

  it('refuses a replacement with a different byte length before hashing', async () => {
    const record = await recordFor(original);
    const verdict = await verifyReplacementMedia(record, new Blob([original, new Uint8Array([1])]));
    expect(verdict).toEqual({ ok: false, reason: 'size-mismatch' });
  });

  it('refuses any replacement when the record has no checksum to verify against', async () => {
    const record: AssetRecordV1 = { id: 'asset-clip', kind: 'video', displayName: 'clip.mp4' };
    const verdict = await verifyReplacementMedia(record, new Blob([original]));
    expect(verdict).toEqual({ ok: false, reason: 'missing-integrity' });
  });
});

describe('media relink write path', () => {
  it('writes a verified replacement through the cache with the record identity', async () => {
    const record = await recordFor(original);
    const cache = memoryCache();
    const verdict = await relinkMissingMedia(cache, record, new Blob([original]));
    expect(verdict).toEqual({ ok: true });
    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0]!.descriptor).toEqual({
      assetId: 'asset-clip',
      sha256: record.sha256,
      bytes: original.byteLength,
      mimeType: 'video/mp4',
    });
  });

  it('writes nothing when the replacement fails verification', async () => {
    const record = await recordFor(original);
    const cache = memoryCache();
    const verdict = await relinkMissingMedia(cache, record, new Blob([replacementSameSize]));
    expect(verdict).toEqual({ ok: false, reason: 'hash-mismatch' });
    expect(cache.writes).toHaveLength(0);
  });

  it('reports media as missing until a verified original is cached', async () => {
    const record = await recordFor(original);
    const cache = memoryCache();
    expect(await isMediaMissing(cache, record.id)).toBe(true);
    await relinkMissingMedia(cache, record, new Blob([original]));
    expect(await isMediaMissing(cache, record.id)).toBe(false);
  });
});
