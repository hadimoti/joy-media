import { describe, expect, it } from 'vitest';
import {
  BLACK_FRAME_MAX_MEAN_LUMA,
  COMPARE_WIDTH,
  PICTURE_MAX_MEAN_DIFFERENCE,
  PICTURE_MIN_SSIM,
  blendFrames,
  compareFrames,
  compareSizeFor,
  judgeDissolve,
  lumaSsim,
  meanAbsoluteDifference,
  meanLuma,
  type RgbFrame,
} from './attended-frame-compare.ts';

const W = 160;
const H = 90;

function frameOf(pixel: (x: number, y: number) => readonly number[], width = W, height = H): RgbFrame {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * width + x) * 3;
      data[offset] = r!;
      data[offset + 1] = g!;
      data[offset + 2] = b!;
    }
  }
  return { width, height, data };
}

/** A picture with edges and areas: a bar pattern and a bright box, like a test chart. */
function chart(boxX = 40): RgbFrame {
  return frameOf((x, y) => {
    const inBox = x >= boxX && x < boxX + 30 && y >= 20 && y < 60;
    if (inBox) return [240, 240, 240];
    const bar = Math.floor(x / 20) % 4;
    return [[200, 40, 40], [40, 200, 40], [40, 40, 200], [200, 200, 40]][bar]!;
  });
}

/** Deterministic noise of at most ±amount levels per channel, like an encode. */
function withNoise(frame: RgbFrame, amount: number): RgbFrame {
  const data = new Uint8Array(frame.data.length);
  let seed = 12345;
  for (let index = 0; index < data.length; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const delta = (seed % (2 * amount + 1)) - amount;
    data[index] = Math.min(255, Math.max(0, frame.data[index]! + delta));
  }
  return { ...frame, data };
}

function offsetBy(frame: RgbFrame, levels: number): RgbFrame {
  return { ...frame, data: frame.data.map((value) => Math.min(255, Math.max(0, value + levels))) };
}

const solid = (rgb: readonly number[]): RgbFrame => frameOf(() => rgb);

describe('compareSizeFor', () => {
  it('keeps the export shape at the compare width, with an even height', () => {
    expect(compareSizeFor(1920, 1080)).toEqual({ width: COMPARE_WIDTH, height: 90 });
    expect(compareSizeFor(1280, 720)).toEqual({ width: 160, height: 90 });
    expect(compareSizeFor(1080, 1920)).toEqual({ width: 160, height: 284 });
    expect(compareSizeFor(960, 720)).toEqual({ width: 160, height: 120 });
  });

  it('never goes below one SSIM window and refuses an empty size', () => {
    expect(compareSizeFor(4000, 10).height).toBe(8);
    expect(() => compareSizeFor(0, 10)).toThrow('positive width and height');
  });
});

describe('measures', () => {
  it('gives 1 and 0 for the same frame', () => {
    const a = chart();
    expect(lumaSsim(a, a)).toBeCloseTo(1, 10);
    expect(meanAbsoluteDifference(a, a)).toBe(0);
  });

  it('reads mean luma with BT.601 weights', () => {
    expect(meanLuma(solid([255, 255, 255]))).toBeCloseTo(255, 6);
    expect(meanLuma(solid([0x2a, 0x6f, 0xdb]))).toBeCloseTo(0.299 * 42 + 0.587 * 111 + 0.114 * 219, 6);
  });

  it('refuses frames of two sizes or a frame whose bytes do not fit its size', () => {
    expect(() => lumaSsim(chart(), frameOf(() => [0, 0, 0], 80, 45))).toThrow('scaled to one size');
    expect(() =>
      meanAbsoluteDifference(chart(), { width: W, height: H, data: new Uint8Array(10) }),
    ).toThrow('is not 160x90 RGB');
  });
});

describe('compareFrames', () => {
  it('passes an encoded copy of the same picture', () => {
    const result = compareFrames(chart(), withNoise(chart(), 4));
    expect(result.passed).toBe(true);
    expect(result.ssim).toBeGreaterThanOrEqual(PICTURE_MIN_SSIM);
    expect(result.meanDifference).toBeLessThanOrEqual(PICTURE_MAX_MEAN_DIFFERENCE);
    expect(result.reason).toBe('');
  });

  it('passes a small even colour shift, as a colour-matrix difference gives', () => {
    expect(compareFrames(chart(), offsetBy(chart(), 6)).passed).toBe(true);
  });

  it('fails the same chart with its box moved: SSIM falls', () => {
    const result = compareFrames(chart(40), chart(100));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('SSIM');
  });

  it('fails a frame whose colours drifted though its structure is the same: the mean difference rises', () => {
    const result = compareFrames(chart(), offsetBy(chart(), 30));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('mean difference');
  });

  it('fails two black frames, which match but prove nothing', () => {
    const black = solid([4, 4, 4]);
    const result = compareFrames(black, black);
    expect(result.ssim).toBeCloseTo(1, 6);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('the reference frame is black');
    expect(result.reason).toContain('the export frame is black');
    expect(result.referenceMeanLuma).toBeLessThanOrEqual(BLACK_FRAME_MAX_MEAN_LUMA);
  });

  it('fails a black export against a real Monitor picture', () => {
    const result = compareFrames(chart(), solid([0, 0, 0]));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('the export frame is black');
  });
});

describe('blendFrames and judgeDissolve', () => {
  const from = chart();
  const to = solid([0x2a, 0x6f, 0xdb]);

  it('blends linearly, all from at 0 and all to at 1', () => {
    expect(blendFrames(from, to, 0).data).toEqual(from.data);
    expect(blendFrames(from, to, 1).data).toEqual(to.data);
    const half = blendFrames(solid([0, 0, 0]), solid([200, 100, 50]), 0.5);
    expect([...half.data.slice(0, 3)]).toEqual([100, 50, 25]);
    expect(() => blendFrames(from, to, 1.5)).toThrow('between 0 and 1');
  });

  it('passes a frame that is the blend at the progress, with encode noise', () => {
    const middle = withNoise(blendFrames(from, to, 0.53), 3);
    const judgement = judgeDissolve({ middle, from, to, progress: 0.53 });
    expect(judgement.passed).toBe(true);
    expect(judgement.residual).toBeLessThan(judgement.fromDistance / 2);
    expect(judgement.residual).toBeLessThan(judgement.toDistance / 2);
  });

  it('fails a hard cut: the middle frame is the outgoing clip', () => {
    const judgement = judgeDissolve({ middle: from, from, to, progress: 0.5 });
    expect(judgement.passed).toBe(false);
    expect(judgement.reason).toContain('not clearly a blend');
  });

  it('fails a cut to the incoming clip', () => {
    expect(judgeDissolve({ middle: to, from, to, progress: 0.5 }).passed).toBe(false);
  });

  it('fails when the two clips are too alike for a blend to be seen', () => {
    const judgement = judgeDissolve({
      middle: from,
      from,
      to: offsetBy(from, 5),
      progress: 0.5,
    });
    expect(judgement.passed).toBe(false);
    expect(judgement.reason).toContain('cannot be seen');
  });
});
