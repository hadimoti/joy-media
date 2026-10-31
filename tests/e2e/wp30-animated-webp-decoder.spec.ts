import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_FIXTURE_DIR } from './wp29-r5-harness.js';

test.describe('WP-30 animated WebP decoding', () => {
  test('proves Chromium decodes distinct animated WebP frames', async ({ page }) => {
    await page.goto('/');
    const bytes = Array.from(readFileSync(join(MEDIA_FIXTURE_DIR, 'animated.webp')));
    const result = await page.evaluate(async (payload) => {
      const Decoder = (
        globalThis as typeof globalThis & {
          ImageDecoder?: new (options: { data: ArrayBuffer; type: string }) => {
            completed: Promise<void>;
            tracks: { ready?: Promise<void>; selectedTrack?: { frameCount: number } };
            decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
            close(): void;
          };
        }
      ).ImageDecoder;
      if (Decoder === undefined) return { available: false, frameCount: 0, hashes: [] as string[] };
      const decoder = new Decoder({ data: Uint8Array.from(payload).buffer, type: 'image/webp' });
      await decoder.completed;
      if (decoder.tracks.ready !== undefined) await decoder.tracks.ready;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      const hashes: string[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const decoded = await decoder.decode({ frameIndex: index });
        const width = decoded.image.displayWidth;
        const height = decoded.image.displayHeight;
        const pixels = new Uint8Array(width * height * 4);
        await decoded.image.copyTo(pixels, { format: 'RGBA' });
        let hash = 2166136261;
        for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
        hashes.push(String(hash >>> 0));
        decoded.image.close();
      }
      decoder.close();
      return { available: true, frameCount, hashes };
    }, bytes);
    expect(result.available).toBe(true);
    expect(result.frameCount).toBe(4);
    expect(new Set(result.hashes).size).toBeGreaterThan(1);
  });
});
