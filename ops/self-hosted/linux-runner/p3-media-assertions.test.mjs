import { describe, expect, it } from 'vitest';
import {
  compareExactFrameCount,
  expectedPresentationFrameCount,
  matchAuthoredEvents,
  validateIntendedResolution,
  validateLookRegions,
  validateDecodedPixelSamples,
} from './p3-media-assertions.mjs';

describe('P3 media assertions', () => {
  it('resolves the 240/241 boundary from rational authored duration', () => {
    expect(
      expectedPresentationFrameCount({ durationUs: 8_000_000, frameRateNum: 30, frameRateDen: 1 }),
    ).toBe(240);
    expect(
      expectedPresentationFrameCount({ durationUs: 8_000_001, frameRateNum: 30, frameRateDen: 1 }),
    ).toBe(241);
  });

  it('rejects a one-frame discrepancy exactly', () => {
    expect(compareExactFrameCount(240, 240).ok).toBe(true);
    expect(compareExactFrameCount(241, 240)).toMatchObject({ ok: false });
  });

  it('requires the intended encoded resolution', () => {
    expect(
      validateIntendedResolution({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }).ok,
    ).toBe(true);
    expect(
      validateIntendedResolution({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }),
    ).toMatchObject({ ok: false });
    expect(
      validateIntendedResolution({ width: 0, height: 1080 }, { width: 1920, height: 1080 }),
    ).toMatchObject({ ok: false });
  });

  it('matches authored events by identity and rejects a 300ms shift', () => {
    const expected = [
      { id: 'early-beat', timeSeconds: 0.5 },
      { id: 'middle-beat', timeSeconds: 1.5 },
      { id: 'late-beat', timeSeconds: 2.5 },
    ];
    expect(matchAuthoredEvents(expected, expected).ok).toBe(true);
    expect(
      matchAuthoredEvents(
        expected,
        expected.map((event) => ({ ...event, timeSeconds: event.timeSeconds + 0.3 })),
      ).ok,
    ).toBe(false);
    expect(matchAuthoredEvents(expected, expected.slice(0, 2))).toMatchObject({ ok: false });
  });

  it('rejects blank or spatially static decoded samples', () => {
    const blank = [
      { fraction: 0.1, stats: { nonBlackFraction: 0, tileLuma: [0, 0, 0, 0] } },
      { fraction: 0.5, stats: { nonBlackFraction: 0, tileLuma: [0, 0, 0, 0] } },
    ];
    expect(validateDecodedPixelSamples(blank).ok).toBe(false);
    const moving = [
      { fraction: 0.1, stats: { nonBlackFraction: 0.5, tileLuma: [5, 5, 5, 5] } },
      { fraction: 0.5, stats: { nonBlackFraction: 0.5, tileLuma: [5, 7, 5, 5] } },
    ];
    expect(validateDecodedPixelSamples(moving).ok).toBe(true);
  });

  it('rejects missing and cropped authored Look/text regions', () => {
    const regions = [
      { id: 'look-background', tiles: [0, 1, 4, 5] },
      { id: 'title-glyphs', tiles: [10, 11] },
    ];
    const visible = [
      {
        fraction: 0.1,
        stats: { tileLuma: [20, 20, 0, 0, 20, 20, 0, 0, 0, 0, 30, 30, 0, 0, 0, 0] },
      },
      {
        fraction: 0.5,
        stats: { tileLuma: [18, 18, 0, 0, 18, 18, 0, 0, 0, 0, 28, 28, 0, 0, 0, 0] },
      },
    ];
    expect(validateLookRegions(visible, regions).ok).toBe(true);
    const missingLook = visible.map((sample) => ({
      ...sample,
      stats: { tileLuma: sample.stats.tileLuma.map((value, index) => (index < 6 ? 0 : value)) },
    }));
    expect(validateLookRegions(missingLook, regions)).toMatchObject({ ok: false });
    const croppedTitle = visible.map((sample) => ({
      ...sample,
      stats: {
        tileLuma: sample.stats.tileLuma.map((value, index) =>
          index === 10 || index === 11 ? 0 : value,
        ),
      },
    }));
    expect(validateLookRegions(croppedTitle, regions)).toMatchObject({ ok: false });
  });
});
