import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectImageAnimation, validateImageAnimationBudget } from './animated-image-metadata.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/test-fixtures/media',
);

describe('inspectImageAnimation', () => {
  it('reads GIF frame timing, transparency, and finite loop count', () => {
    expect(inspectImageAnimation(gifFixture(), 'image/gif')).toEqual({
      frameCount: 2,
      cycleDurationUs: 150_000,
      loopCount: 2,
      hasAlpha: true,
    });
  });

  it('reads animated WebP frame timing and alpha', () => {
    expect(inspectImageAnimation(webpFixture(), 'image/webp')).toEqual({
      frameCount: 2,
      cycleDurationUs: 125_000,
      loopCount: 0,
      hasAlpha: true,
    });
  });

  it('returns no animation metadata for non-animated or unknown bytes', () => {
    expect(inspectImageAnimation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBe(
      undefined,
    );
    expect(inspectImageAnimation(new Uint8Array([1, 2, 3]), 'image/gif')).toBe(undefined);
  });

  it('rejects truncated recognized containers', () => {
    expect(() => inspectImageAnimation(new TextEncoder().encode('GIF89a'), 'image/gif')).toThrow(
      'metadata is invalid',
    );
    expect(() => inspectImageAnimation(webpFixture().slice(0, 20), 'image/webp')).toThrow(
      'metadata is invalid',
    );
  });

  it('matches the committed GIF and WebP fixtures', () => {
    expect(inspectImageAnimation(readFileSync(join(fixtureRoot, 'animated.gif')))).toEqual({
      frameCount: 4,
      cycleDurationUs: 1_000_000,
      loopCount: 0,
      hasAlpha: true,
    });
    expect(inspectImageAnimation(readFileSync(join(fixtureRoot, 'animated.webp')))).toEqual({
      frameCount: 4,
      cycleDurationUs: 1_000_000,
      loopCount: 0,
      hasAlpha: true,
    });
    expect(inspectImageAnimation(readFileSync(join(fixtureRoot, 'image.webp')))).toBeUndefined();
    expect(() => inspectImageAnimation(readFileSync(join(fixtureRoot, 'corrupt.gif')))).toThrow(
      'metadata is invalid',
    );
    expect(() => inspectImageAnimation(readFileSync(join(fixtureRoot, 'corrupt.webp')))).toThrow(
      'metadata is invalid',
    );
  });

  it('rejects animation budgets before decoded frames are allocated', () => {
    expect(() =>
      validateImageAnimationBudget(
        { frameCount: 10_001, cycleDurationUs: 1_000_000, loopCount: 0, hasAlpha: false },
        10,
        10,
      ),
    ).toThrow('frame-count resource limit');
    expect(() =>
      validateImageAnimationBudget({
        frameCount: 2,
        cycleDurationUs: 86_400_000_001,
        loopCount: 0,
        hasAlpha: false,
      }),
    ).toThrow('cycle-duration resource limit');
    expect(() =>
      validateImageAnimationBudget(
        { frameCount: 100, cycleDurationUs: 1_000_000, loopCount: 0, hasAlpha: true },
        4096,
        4096,
      ),
    ).toThrow('decoded-memory resource limit');
  });
});

function gifFixture(): Uint8Array {
  const bytes: number[] = [
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
    0x21,
    0xff,
    0x0b,
    ...text('NETSCAPE2.0'),
    0x03,
    0x01,
    0x02,
    0x00,
    0x00,
    ...graphicControl(5, true),
    ...imageFrame(),
    ...graphicControl(10, false),
    ...imageFrame(),
    0x3b,
  ];
  return Uint8Array.from(bytes);
}

function webpFixture(): Uint8Array {
  const vp8x = chunk('VP8X', [0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const anim = chunk('ANIM', [0, 0, 0, 0, 0, 0]);
  const first = chunk('ANMF', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 0, 0]);
  const second = chunk('ANMF', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 75, 0, 0, 0]);
  const body = [...vp8x, ...anim, ...first, ...second];
  return Uint8Array.from([
    ...text('RIFF'),
    ...littleEndian32(body.length + 4),
    ...text('WEBP'),
    ...body,
  ]);
}

function graphicControl(delayCs: number, transparent: boolean): number[] {
  return [0x21, 0xf9, 0x04, transparent ? 0x01 : 0, delayCs & 0xff, delayCs >> 8, 0, 0];
}

function imageFrame(): number[] {
  return [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0];
}

function chunk(name: string, data: number[]): number[] {
  return [...text(name), ...littleEndian32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

function littleEndian32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function text(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}
