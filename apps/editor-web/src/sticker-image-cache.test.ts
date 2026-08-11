import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StickerImageCache } from './sticker-image-cache.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/test-fixtures/media',
);

describe('StickerImageCache animated ownership', () => {
  it('selects animated frames by source time and disposes on replacement', async () => {
    const cache = new StickerImageCache();
    const blob = animatedGifBlob();
    const animation = {
      frameCount: 4,
      cycleDurationUs: 1_000_000,
      loopCount: 0,
      hasAlpha: true,
    } as const;

    await cache.syncObject({
      objectId: 'object',
      assetId: 'asset',
      crop: emptyCrop(),
      animation,
      mimeType: 'image/gif',
      loadBlob: async () => blob,
    });
    const first = cache.bitmaps(0).get('object')!;
    const second = cache.bitmaps(300_000).get('object')!;
    expect(first.data).not.toEqual(second.data);

    cache.clearObject('object');
    expect(cache.bitmaps()).not.toHaveProperty('object');
  });

  it('does not publish a stale async load after the object is cleared', async () => {
    const cache = new StickerImageCache();
    const blob = animatedGifBlob();
    let release: (() => void) | undefined;
    const pending = new Promise<Blob>((resolve) => {
      release = () => resolve(blob);
    });

    const loading = cache.syncObject({
      objectId: 'object',
      assetId: 'asset',
      crop: emptyCrop(),
      animation: {
        frameCount: 4,
        cycleDurationUs: 1_000_000,
        loopCount: 0,
        hasAlpha: true,
      },
      mimeType: 'image/gif',
      loadBlob: async () => pending,
    });
    cache.clearObject('object');
    release!();
    await loading;
    expect(cache.bitmaps()).toEqual(new Map());
  });
});

function animatedGifBlob(): Blob {
  return new Blob([readFileSync(join(fixtureRoot, 'animated.gif'))], { type: 'image/gif' });
}

function emptyCrop() {
  return { left: 0, top: 0, right: 0, bottom: 0 } as const;
}
