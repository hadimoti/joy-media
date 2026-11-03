import { describe, expect, it } from 'vitest';
import { avcCodecString, selectAvcLevels } from './avc-level.js';

describe('selectAvcLevels', () => {
  it('picks level 4.0 for 1080x1920 at 30 fps', () => {
    expect(selectAvcLevels(1080, 1920, 30)[0]).toBe(40);
  });

  it('picks level 4.0 for 1920x1080 at 30 fps', () => {
    expect(selectAvcLevels(1920, 1080, 30)[0]).toBe(40);
  });

  it('picks level 4.2 for 1920x1080 at 60 fps', () => {
    expect(selectAvcLevels(1920, 1080, 60)[0]).toBe(42);
  });

  it('picks level 3.1 for 1280x720 at 30 fps', () => {
    expect(selectAvcLevels(1280, 720, 30)[0]).toBe(31);
  });

  it('picks level 3.0 for 640x360 at 30 fps', () => {
    expect(selectAvcLevels(640, 360, 30)[0]).toBe(30);
  });

  it('picks level 5.1 for 3840x2160 at 30 fps', () => {
    expect(selectAvcLevels(3840, 2160, 30)[0]).toBe(51);
  });

  it('rounds odd sizes up to macroblocks', () => {
    // 1081x1921 is 68x121 macroblocks, which no longer fits the 4.0 rate limit.
    expect(selectAvcLevels(1081, 1921, 30)[0]).toBe(42);
    // 641x361 is still 41x23 macroblocks.
    expect(selectAvcLevels(641, 361, 30)[0]).toBe(30);
  });

  it('returns the fitting level plus two fallbacks, in increasing order', () => {
    expect(selectAvcLevels(1080, 1920, 30)).toEqual([40, 41, 42]);
    expect(selectAvcLevels(640, 360, 30)).toEqual([30, 31, 32]);
    expect(selectAvcLevels(1280, 720, 30)).toEqual([31, 32, 40]);
  });

  it('stops at the highest level when there is no fallback left', () => {
    expect(selectAvcLevels(3840, 2160, 30)).toEqual([51, 52]);
  });

  it('falls back to level 5.2 when no level fits', () => {
    expect(selectAvcLevels(8000, 8000, 120)).toEqual([52]);
  });

  it('falls back to level 5.2 for a broken format', () => {
    expect(selectAvcLevels(0, 1080, 30)).toEqual([52]);
    expect(selectAvcLevels(1920, 1080, 0)).toEqual([52]);
    expect(selectAvcLevels(Number.NaN, 1080, 30)).toEqual([52]);
  });

  it('accepts a frame that exactly hits the macroblock limit of a level', () => {
    // 1280x720 is 80x45 = 3600 macroblocks, exactly the frame size limit of level 3.1,
    // and 3600 * 30 is exactly its macroblocks-per-second limit.
    expect(selectAvcLevels(1280, 720, 30)[0]).toBe(31);
    expect(selectAvcLevels(1280, 720, 31)[0]).toBe(32);
  });
});

describe('selectAvcLevels with a bit rate', () => {
  it('moves up to a level whose bit rate limit covers the target', () => {
    // Level 4.0 allows 25 Mbit/s in the High profile, so 1080p30 at 62.2 Mbit/s needs level 4.1.
    expect(selectAvcLevels(1920, 1080, 30, 62_208_000)[0]).toBe(41);
    expect(selectAvcLevels(1920, 1080, 30, 12_441_600)[0]).toBe(40);
  });

  it('applies the Main profile limit, which has no High profile factor', () => {
    // Level 4.1 allows 50 Mbit/s in Main, so 62.2 Mbit/s needs level 5.0.
    expect(selectAvcLevels(1920, 1080, 30, 62_208_000, 'main')).toEqual([50, 51, 52]);
  });

  it('falls back to level 5.2 when the target is above every level', () => {
    // Without a bit rate, 1080p30 would give [40, 41, 42]; no level allows 400 Mbit/s.
    expect(selectAvcLevels(1920, 1080, 30, 400_000_000)).toEqual([52]);
  });

  it('ignores a bit rate that is not a positive number', () => {
    expect(selectAvcLevels(1920, 1080, 30, Number.NaN)[0]).toBe(40);
  });
});

describe('avcCodecString', () => {
  it('builds the codec string of each profile', () => {
    expect(avcCodecString('high', 40)).toBe('avc1.640028');
    expect(avcCodecString('main', 40)).toBe('avc1.4D0028');
    expect(avcCodecString('constrainedBaseline', 31)).toBe('avc1.42E01F');
  });

  it('writes the level as two uppercase hex digits', () => {
    expect(avcCodecString('high', 10)).toBe('avc1.64000A');
    expect(avcCodecString('high', 52)).toBe('avc1.640034');
    expect(avcCodecString('high', 31)).toBe('avc1.64001F');
  });
});
