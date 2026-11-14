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

export const PREVIEW_VISIBLE_MEAN_DIFF = 0.1;

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
