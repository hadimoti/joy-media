import { describe, expect, it } from 'vitest';
import { keyframeChangesMiddle, previewAccepted, visiblePixelChange } from './preview-rule.js';

describe('harness preview rule', () => {
  it('passes a default that differs from Before', () => {
    expect(
      previewAccepted({
        isBlankFrame: false,
        defaultVsBeforeMeanDiff: 12,
        adjustedVsDefaultMeanDiffs: [],
      }),
    ).toEqual({ accepted: true, neutralDefault: false });
  });

  it('fails a blank frame even when it differs from Before', () => {
    expect(
      previewAccepted({
        isBlankFrame: true,
        defaultVsBeforeMeanDiff: 40,
        adjustedVsDefaultMeanDiffs: [30],
      }),
    ).toEqual({ accepted: false, neutralDefault: false });
  });

  it('fails a filter whose default and adjusted renders both equal Before', () => {
    expect(
      previewAccepted({
        isBlankFrame: false,
        defaultVsBeforeMeanDiff: 0,
        adjustedVsDefaultMeanDiffs: [0, 0.05],
      }),
    ).toEqual({ accepted: false, neutralDefault: false });
  });

  it('passes a neutral default when an adjusted value visibly changes the picture', () => {
    expect(
      previewAccepted({
        isBlankFrame: false,
        defaultVsBeforeMeanDiff: 0,
        adjustedVsDefaultMeanDiffs: [0, 19.7],
      }),
    ).toEqual({ accepted: true, neutralDefault: true });
  });

  it('requires measured preview and parameter changes to exceed the one-point floor', () => {
    expect(
      previewAccepted({
        isBlankFrame: false,
        defaultVsBeforeMeanDiff: 0.99,
        adjustedVsDefaultMeanDiffs: [1],
      }),
    ).toEqual({ accepted: false, neutralDefault: false });
    expect(visiblePixelChange(1, 10)).toBe(false);
    expect(visiblePixelChange(1.01, 1)).toBe(true);
  });

  it('requires both keyframe comparisons to exceed the measured 0.4-point floor', () => {
    expect(keyframeChangesMiddle(0.4, 1, 2, 1)).toBe(false);
    expect(keyframeChangesMiddle(0.41, 1, 0.41, 1)).toBe(true);
    expect(keyframeChangesMiddle(2, 0, 2, 1)).toBe(false);
  });
});
