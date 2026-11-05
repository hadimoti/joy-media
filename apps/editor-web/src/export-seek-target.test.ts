import { describe, expect, it } from 'vitest';
import { frameCentreSeekUs } from './export-seek-target.js';

const FRAME_30 = 1_000_000 / 30;
/** The frame index a seek target lands in. */
const frameOf = (targetUs: number, frameUs: number): number => Math.floor(targetUs / frameUs);

describe('frameCentreSeekUs', () => {
  it('aims at the middle of the frame that holds the source time', () => {
    expect(frameCentreSeekUs(0, FRAME_30)).toBeCloseTo(FRAME_30 / 2, 6);
    expect(frameOf(frameCentreSeekUs(5_000_000, FRAME_30), FRAME_30)).toBe(150);
  });

  it('keeps a time just short of a frame edge in the earlier frame', () => {
    const edge = 179 * FRAME_30;
    expect(frameOf(frameCentreSeekUs(edge - 1.33, FRAME_30), FRAME_30)).toBe(178);
    expect(frameOf(frameCentreSeekUs(edge - 0.67, FRAME_30), FRAME_30)).toBe(178);
  });

  it('keeps a time exactly on a frame edge in the frame that starts there', () => {
    expect(frameOf(frameCentreSeekUs(179 * FRAME_30, FRAME_30), FRAME_30)).toBe(179);
  });

  it('stays in the first frame for a negative time', () => {
    expect(frameCentreSeekUs(-500, FRAME_30)).toBeCloseTo(FRAME_30 / 2, 6);
  });

  it('gives the reversed export sequence its intended frames', () => {
    // Clip B reversed: its in-point is the last sample (5 999 999 µs), and output frame n after the
    // cut reads 1 frame less than the one before, as the export computes it.
    for (let n = 180; n <= 359; n++) {
      const playheadUs = Math.round((n * 1_000_000) / 30);
      const sourceUs = 5_999_999 - (playheadUs - 6_000_000);
      expect(frameOf(frameCentreSeekUs(sourceUs, FRAME_30), FRAME_30)).toBe(359 - n);
    }
  });
});
