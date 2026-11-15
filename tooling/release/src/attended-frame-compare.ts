/**
 * The frame compare of the export-semantics scenario (`desktop.export-media-semantics`).
 *
 * A Monitor capture and an export frame never match bit for bit: the Monitor is a screenshot of a canvas
 * shown at its own size, and the export went through an H.264 encode and a YUV round trip, sometimes
 * with another colour matrix. So both frames are first scaled by the driver to the same small size
 * (COMPARE_WIDTH wide), and then compared here with two measures on that size:
 *
 * - SSIM on luma, over 8 by 8 windows moved 4 pixels at a time, with the usual constants. It answers
 *   "is the same picture in the same place", and a small even shift of brightness or colour barely moves it.
 * - The mean absolute difference over all RGB channels, in levels of 0 to 255. It answers "are the
 *   colours close", which SSIM on luma alone cannot see (a red frame and a green frame of the same
 *   luma would pass SSIM).
 *
 * A pair passes when SSIM is at least PICTURE_MIN_SSIM and the mean difference is at most
 * PICTURE_MAX_MEAN_DIFFERENCE, and neither frame is black. This module does no I/O.
 */

/** A frame as 8-bit RGB, three bytes per pixel, rows from the top. */
export interface RgbFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Both frames are scaled to this width before they are compared; the height keeps the export's shape. */
export const COMPARE_WIDTH = 160;

/** The lowest luma SSIM that counts as the same picture. */
export const PICTURE_MIN_SSIM = 0.9;

/** The highest mean absolute RGB difference, in levels, that counts as the same colours. */
export const PICTURE_MAX_MEAN_DIFFERENCE = 12;

/** A frame whose mean luma is at or below this is black: a black frame never proves a match. */
export const BLACK_FRAME_MAX_MEAN_LUMA = 16;

/**
 * The two clips of a dissolve must differ by at least this many levels on average, or the blend could not be
 * told apart from either clip and the dissolve check would prove nothing.
 */
export const DISSOLVE_MIN_CLIP_DIFFERENCE = 24;

const SSIM_WINDOW = 8;
const SSIM_STEP = 4;
const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

export interface FrameComparison {
  readonly ssim: number;
  readonly meanDifference: number;
  readonly referenceMeanLuma: number;
  readonly candidateMeanLuma: number;
  readonly passed: boolean;
  /** Why the pair failed, or an empty text when it passed. */
  readonly reason: string;
}

export interface DissolveJudgement {
  /** Mean difference between the middle frame and the blend the dissolve should give at its progress. */
  readonly residual: number;
  /** Mean difference between the middle frame and the outgoing clip's frame. */
  readonly fromDistance: number;
  /** Mean difference between the middle frame and the incoming clip's frame. */
  readonly toDistance: number;
  /** Mean difference between the two clips' frames. */
  readonly clipDifference: number;
  readonly passed: boolean;
  readonly reason: string;
}

/** The size both frames are scaled to: COMPARE_WIDTH wide, an even height in the export's shape, at least 8. */
export function compareSizeFor(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  if (!(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0)) {
    throw new RangeError('a compare size needs a positive width and height');
  }
  const scaled = Math.round((COMPARE_WIDTH * height) / width / 2) * 2;
  return { width: COMPARE_WIDTH, height: Math.max(SSIM_WINDOW, scaled) };
}

function assertFrame(frame: RgbFrame, label: string): void {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.data.length !== frame.width * frame.height * 3
  ) {
    throw new RangeError(`the ${label} frame is not ${frame.width}x${frame.height} RGB`);
  }
}

function assertSameSize(a: RgbFrame, b: RgbFrame): void {
  assertFrame(a, 'first');
  assertFrame(b, 'second');
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(
      `the frames are ${a.width}x${a.height} and ${b.width}x${b.height}; they must be scaled to one size first`,
    );
  }
}

/** The mean absolute difference over every RGB channel, in levels of 0 to 255. */
export function meanAbsoluteDifference(a: RgbFrame, b: RgbFrame): number {
  assertSameSize(a, b);
  let sum = 0;
  for (let index = 0; index < a.data.length; index += 1) {
    sum += Math.abs(a.data[index]! - b.data[index]!);
  }
  return sum / a.data.length;
}

/** BT.601 luma of each pixel, as the SSIM input. */
function lumaOf(frame: RgbFrame): Float64Array {
  const luma = new Float64Array(frame.width * frame.height);
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    const offset = pixel * 3;
    luma[pixel] =
      0.299 * frame.data[offset]! +
      0.587 * frame.data[offset + 1]! +
      0.114 * frame.data[offset + 2]!;
  }
  return luma;
}

/** The mean luma of a frame, 0 to 255. */
export function meanLuma(frame: RgbFrame): number {
  assertFrame(frame, 'measured');
  const luma = lumaOf(frame);
  let sum = 0;
  for (const value of luma) sum += value;
  return sum / luma.length;
}

/** Window origins along one axis: every SSIM_STEP pixels, and the last window flush with the edge. */
function windowOrigins(length: number): number[] {
  if (length <= SSIM_WINDOW) return [0];
  const origins: number[] = [];
  for (let origin = 0; origin + SSIM_WINDOW <= length; origin += SSIM_STEP) origins.push(origin);
  const last = length - SSIM_WINDOW;
  if (origins[origins.length - 1] !== last) origins.push(last);
  return origins;
}

/**
 * The mean SSIM of the two frames' luma over 8 by 8 windows moved 4 pixels at a time. 1 means the same
 * picture; unrelated pictures give values near 0. A frame smaller than a window is one window.
 */
export function lumaSsim(a: RgbFrame, b: RgbFrame): number {
  assertSameSize(a, b);
  const x = lumaOf(a);
  const y = lumaOf(b);
  const windowWidth = Math.min(SSIM_WINDOW, a.width);
  const windowHeight = Math.min(SSIM_WINDOW, a.height);
  const count = windowWidth * windowHeight;
  let total = 0;
  let windows = 0;
  for (const top of windowOrigins(a.height)) {
    for (const left of windowOrigins(a.width)) {
      let sumX = 0;
      let sumY = 0;
      for (let row = top; row < top + windowHeight; row += 1) {
        for (let column = left; column < left + windowWidth; column += 1) {
          sumX += x[row * a.width + column]!;
          sumY += y[row * a.width + column]!;
        }
      }
      const meanX = sumX / count;
      const meanY = sumY / count;
      let varianceX = 0;
      let varianceY = 0;
      let covariance = 0;
      for (let row = top; row < top + windowHeight; row += 1) {
        for (let column = left; column < left + windowWidth; column += 1) {
          const dx = x[row * a.width + column]! - meanX;
          const dy = y[row * a.width + column]! - meanY;
          varianceX += dx * dx;
          varianceY += dy * dy;
          covariance += dx * dy;
        }
      }
      varianceX /= count;
      varianceY /= count;
      covariance /= count;
      total +=
        ((2 * meanX * meanY + SSIM_C1) * (2 * covariance + SSIM_C2)) /
        ((meanX * meanX + meanY * meanY + SSIM_C1) * (varianceX + varianceY + SSIM_C2));
      windows += 1;
    }
  }
  return total / windows;
}

/** The measures of one pair of frames, as pictureProblems reads them. */
export interface PictureMeasures {
  readonly ssim: number;
  readonly meanDifference: number;
  readonly referenceMeanLuma: number;
  readonly candidateMeanLuma: number;
}

/**
 * The reasons a pair of measured frames is not the same picture: a black frame, SSIM below PICTURE_MIN_SSIM, or
 * a mean difference above PICTURE_MAX_MEAN_DIFFERENCE. Both limits are inclusive (exactly the limit passes). A
 * NaN measure fails. Empty when the pair passes.
 */
export function pictureProblems(measures: PictureMeasures): string[] {
  const problems: string[] = [];
  if (measures.referenceMeanLuma <= BLACK_FRAME_MAX_MEAN_LUMA) {
    problems.push('the reference frame is black');
  }
  if (measures.candidateMeanLuma <= BLACK_FRAME_MAX_MEAN_LUMA) {
    problems.push('the export frame is black');
  }
  if (!(measures.ssim >= PICTURE_MIN_SSIM)) {
    problems.push(`SSIM ${measures.ssim.toFixed(6)} is below ${PICTURE_MIN_SSIM}`);
  }
  if (!(measures.meanDifference <= PICTURE_MAX_MEAN_DIFFERENCE)) {
    problems.push(
      `the mean difference ${measures.meanDifference.toFixed(2)} is above ${PICTURE_MAX_MEAN_DIFFERENCE} levels`,
    );
  }
  return problems;
}

/**
 * Compares a reference frame (the Monitor capture) with a candidate (the export frame at the same time).
 * Both must already be the same size. The pair passes when pictureProblems finds nothing.
 */
export function compareFrames(reference: RgbFrame, candidate: RgbFrame): FrameComparison {
  const measures: PictureMeasures = {
    ssim: lumaSsim(reference, candidate),
    meanDifference: meanAbsoluteDifference(reference, candidate),
    referenceMeanLuma: meanLuma(reference),
    candidateMeanLuma: meanLuma(candidate),
  };
  const problems = pictureProblems(measures);
  return {
    ...measures,
    passed: problems.length === 0,
    reason: problems.join('; '),
  };
}

/** The frame a linear dissolve gives at a progress from 0 (all `from`) to 1 (all `to`). */
export function blendFrames(from: RgbFrame, to: RgbFrame, progress: number): RgbFrame {
  assertSameSize(from, to);
  if (!(Number.isFinite(progress) && progress >= 0 && progress <= 1)) {
    throw new RangeError('a dissolve progress is between 0 and 1');
  }
  const data = new Uint8Array(from.data.length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.round(from.data[index]! * (1 - progress) + to.data[index]! * progress);
  }
  return { width: from.width, height: from.height, data };
}

/**
 * Judges the frame in the middle of a dissolve. It passes when the frame is close to the blend of the two
 * clips at the dissolve's progress, and clearly closer to that blend than to either clip alone, so a hard
 * cut (the frame is one clip) or a missing clip fails. The clips must differ enough for this to be seen.
 */
export function judgeDissolve(input: {
  readonly middle: RgbFrame;
  readonly from: RgbFrame;
  readonly to: RgbFrame;
  readonly progress: number;
}): DissolveJudgement {
  const expected = blendFrames(input.from, input.to, input.progress);
  const residual = meanAbsoluteDifference(input.middle, expected);
  const fromDistance = meanAbsoluteDifference(input.middle, input.from);
  const toDistance = meanAbsoluteDifference(input.middle, input.to);
  const clipDifference = meanAbsoluteDifference(input.from, input.to);
  const problems: string[] = [];
  if (!(clipDifference >= DISSOLVE_MIN_CLIP_DIFFERENCE)) {
    problems.push(
      `the two clips differ by ${clipDifference.toFixed(2)} levels, under ${DISSOLVE_MIN_CLIP_DIFFERENCE}, so a blend cannot be seen`,
    );
  }
  if (!(residual <= PICTURE_MAX_MEAN_DIFFERENCE)) {
    problems.push(
      `the middle frame is ${residual.toFixed(2)} levels from the expected blend, above ${PICTURE_MAX_MEAN_DIFFERENCE}`,
    );
  }
  if (!(residual * 2 <= Math.min(fromDistance, toDistance))) {
    problems.push(
      `the middle frame is not clearly a blend: ${residual.toFixed(2)} from the blend, ` +
        `${fromDistance.toFixed(2)} from the outgoing clip, ${toDistance.toFixed(2)} from the incoming clip`,
    );
  }
  return {
    residual,
    fromDistance,
    toDistance,
    clipDifference,
    passed: problems.length === 0,
    reason: problems.join('; '),
  };
}
