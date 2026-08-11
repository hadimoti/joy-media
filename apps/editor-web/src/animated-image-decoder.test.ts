import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAnimatedImageFrameSource } from './animated-image-decoder.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/test-fixtures/media',
);

describe('createAnimatedImageFrameSource', () => {
  it('composites GIF frames and wraps time within the cycle', async () => {
    const source = await createAnimatedImageFrameSource(blobFromBytes(gifFixture(), 'image/gif'), {
      frameCount: 2,
      cycleDurationUs: 150_000,
      loopCount: 0,
      hasAlpha: true,
    });
    expect(source.frames).toHaveLength(2);
    expect(source.frameAt(1_000).startUs).toBe(0);
    expect(source.frameAt(120_000).startUs).toBe(50_000);
    expect(source.frameAt(151_000).startUs).toBe(0);
    expect(source.frames[0]!.bitmap.data.length).toBe(4);
    source.dispose();
  });

  it('fails closed for animated WebP until a compatible decoder is available', async () => {
    await expect(
      createAnimatedImageFrameSource(blobFromBytes(new Uint8Array([1, 2, 3]), 'image/webp'), {
        frameCount: 2,
        cycleDurationUs: 100_000,
        loopCount: 0,
        hasAlpha: false,
      }),
    ).rejects.toThrow('animated WebP decoding');
  });

  it('decodes the committed animated GIF fixture into distinct timed frames', async () => {
    const bytes = readFileSync(join(fixtureRoot, 'animated.gif'));
    const source = await createAnimatedImageFrameSource(new Blob([bytes], { type: 'image/gif' }), {
      frameCount: 4,
      cycleDurationUs: 1_000_000,
      loopCount: 0,
      hasAlpha: true,
    });
    expect(source.frames).toHaveLength(4);
    expect(source.frames.map((frame) => frame.endUs - frame.startUs)).toEqual([
      250_000, 250_000, 250_000, 250_000,
    ]);
    expect(source.frameAt(0).bitmap.data).not.toEqual(source.frameAt(300_000).bitmap.data);
    source.dispose();
  });
});

function gifFixture(): Uint8Array {
  return Uint8Array.from([
    ...text('GIF89a'),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    ...graphicControl(5),
    ...imageFrame(),
    ...graphicControl(10),
    ...imageFrame(),
    0x3b,
  ]);
}

function graphicControl(delayCs: number): number[] {
  return [0x21, 0xf9, 0x04, 0, delayCs & 0xff, delayCs >> 8, 0, 0];
}

function imageFrame(): number[] {
  return [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0];
}

function text(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  const copy = bytes.slice().buffer as ArrayBuffer;
  return new Blob([copy], { type });
}
