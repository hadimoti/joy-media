import { describe, expect, it } from 'vitest';
import { previewAccepted } from './preview-rule.js';

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
});
