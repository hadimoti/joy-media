import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileTitleInstance, sampleTitleMotion } from '@joy-media/motion-core';
import {
  encodeRgbaPng,
  renderTitleFrames,
  titleFrameCount,
  titleFrameTimes,
} from './title-frames.js';

describe('title frame timing and PNG encoding', () => {
  it('encodes RGBA pixels into a valid PNG with a round-trippable filter-0 IDAT', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128]);
    const png = encodeRgbaPng(2, 1, rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    let offset = 8;
    let idat: Buffer | undefined;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.toString('ascii', offset + 4, offset + 8);
      if (kind === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + length);
      offset += length + 12;
    }
    expect(idat).toBeDefined();
    expect([...inflateSync(idat!).subarray(1)]).toEqual([...rgba]);
  });

  it('creates 45 frame samples for a 1.5 second clip at 30 fps', () => {
    const times = titleFrameTimes(1_500_000, { num: 30, den: 1 });
    expect(titleFrameCount(1_500_000, { num: 30, den: 1 })).toBe(45);
    expect(times).toHaveLength(45);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(33_333);
    expect(times[44]).toBe(1_466_667);
  });

  it('samples a slide-up title at its first, middle and last frames', () => {
    const motion = { presetId: 'joy-slide-up' as const, inUs: 300_000, outUs: 300_000 };
    const times = titleFrameTimes(1_500_000, { num: 30, den: 1 });
    const first = sampleTitleMotion(motion, 1_500_000, times[0]!);
    const middle = sampleTitleMotion(motion, 1_500_000, times[22]!);
    const last = sampleTitleMotion(motion, 1_500_000, times[44]!);
    expect(first).toEqual({ opacity: 0, translateYPx: 80 });
    expect(middle).toEqual({ opacity: 1, translateYPx: 0 });
    expect(last.opacity).toBeGreaterThan(0);
    expect(last.opacity).toBeLessThan(1);
    expect(last.translateYPx).toBe(0);
  });

  it('renders a title frame from the shared title scene frame builder', async () => {
    const result = compileTitleInstance(
      {
        instanceId: 'shared-frame-test',
        templateId: 'joy.p0.title',
        clipId: 'clip-shared-frame-test',
        objectId: 'object-shared-frame-test',
        lines: { primary: 'Shared frame', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
        placement: { xPx: 10, yPx: 20, maxWidthPx: 300, safeInsetPx: 8 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 33_334,
        frame: { widthPx: 320, heightPx: 568 },
      },
      (text, size) => [...text].length * size * 0.55,
    );
    if (!result.ok) throw new Error(`P0 fixture compilation failed: ${result.code}`);
    const rendered = await renderTitleFrames(
      [
        {
          instanceId: 'shared-frame-test',
          instance: result.instance,
          startUs: 0,
          durationUs: 33_334,
        },
      ],
      { width: 320, height: 568, fps: { num: 30, den: 1 } },
    );
    try {
      expect(rendered.layers).toHaveLength(1);
      const png = readFileSync(rendered.layers[0]!.inputPattern.replace('%05d', '00000'));
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    } finally {
      rendered.cleanup();
    }
  }, 60_000);
});
