/**
 * The harness rule for "the preview differs from Before" (T-V04), kept apart from the browser runner so
 * it can be unit tested.
 *
 * A preview passes when it is not blank and differs from the Before frame. A neutral default (hue 0,
 * saturation 0, vibrance 0) legitimately renders like Before; it passes only when it is not blank AND some
 * adjusted parameter value visibly changes the picture. A blank frame, or a filter whose default and adjusted
 * renders both equal Before, still fails.
 */
export interface PreviewRuleInput {
  readonly isBlankFrame: boolean;
  readonly defaultVsBeforeMeanDiff: number;
  /** For each parameter sweep that itself passed: the larger of low-vs-default and high-vs-default mean diffs. */
  readonly adjustedVsDefaultMeanDiffs: readonly number[];
}

export const PREVIEW_VISIBLE_MEAN_DIFF = 1.0;
export const PARAMETER_VISIBLE_MEAN_DIFF = 1.0;
export const KEYFRAME_VISIBLE_MEAN_DIFF = 0.4;

export function visiblePixelChange(meanAbsDiff: number, changedPixels: number): boolean {
  return changedPixels > 0 && meanAbsDiff > PARAMETER_VISIBLE_MEAN_DIFF;
}

export function keyframeChangesMiddle(
  midVsStartMeanDiff: number,
  midVsStartChangedPixels: number,
  midVsEndMeanDiff: number,
  midVsEndChangedPixels: number,
): boolean {
  return (
    midVsStartChangedPixels > 0 &&
    midVsEndChangedPixels > 0 &&
    midVsStartMeanDiff > KEYFRAME_VISIBLE_MEAN_DIFF &&
    midVsEndMeanDiff > KEYFRAME_VISIBLE_MEAN_DIFF
  );
}

export function previewAccepted(input: PreviewRuleInput): {
  accepted: boolean;
  neutralDefault: boolean;
} {
  if (input.isBlankFrame) return { accepted: false, neutralDefault: false };
  if (input.defaultVsBeforeMeanDiff > PREVIEW_VISIBLE_MEAN_DIFF) {
    return { accepted: true, neutralDefault: false };
  }
  const adjustedVisible = input.adjustedVsDefaultMeanDiffs.some(
    (diff) => diff > PREVIEW_VISIBLE_MEAN_DIFF,
  );
  return { accepted: adjustedVisible, neutralDefault: adjustedVisible };
}
