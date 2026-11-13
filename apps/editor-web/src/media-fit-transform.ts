export type MediaFitMode = 'fit' | 'fill';

export interface MediaFitTransformInput {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly mode: MediaFitMode;
  readonly rotationDeg?: number;
  readonly crop?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Fractions of the cropped box. Missing coordinates use its centre. */
  readonly anchor?: { readonly x: number; readonly y: number };
}

export interface MediaFitTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const MAX_CROP_EDGE = 0.49;

function cleanNearInteger(value: number): number {
  if (Math.abs(value) <= 1e-10) return 0;
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 1e-10 ? nearest : value;
}

/**
 * Calculate a uniform contain/cover transform for the visible media box.
 * `x` and `y` are translations of the uncropped source's top-left corner.
 */
export function calculateMediaFitTransform(
  input: MediaFitTransformInput,
): MediaFitTransform | undefined {
  const {
    sourceWidth,
    sourceHeight,
    frameWidth,
    frameHeight,
    mode,
    rotationDeg = 0,
    crop = { left: 0, top: 0, right: 0, bottom: 0 },
    anchor = { x: 0.5, y: 0.5 },
  } = input;
  if (
    ![sourceWidth, sourceHeight, frameWidth, frameHeight, rotationDeg].every(Number.isFinite) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    (mode !== 'fit' && mode !== 'fill')
  )
    return undefined;

  const cropEdges = [crop.left, crop.top, crop.right, crop.bottom];
  if (
    !cropEdges.every((edge) => Number.isFinite(edge) && edge >= 0) ||
    ![anchor.x, anchor.y].every((value) => Number.isFinite(value) && value >= -1 && value <= 2)
  )
    return undefined;

  const visibleCrop = {
    left: Math.min(crop.left, MAX_CROP_EDGE),
    top: Math.min(crop.top, MAX_CROP_EDGE),
    right: Math.min(crop.right, MAX_CROP_EDGE),
    bottom: Math.min(crop.bottom, MAX_CROP_EDGE),
  };
  const visibleLeft = sourceWidth * visibleCrop.left;
  const visibleTop = sourceHeight * visibleCrop.top;
  const visibleWidth = sourceWidth * (1 - visibleCrop.left - visibleCrop.right);
  const visibleHeight = sourceHeight * (1 - visibleCrop.top - visibleCrop.bottom);
  const radians = (rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotatedWidth = visibleWidth * Math.abs(cosine) + visibleHeight * Math.abs(sine);
  const rotatedHeight = visibleWidth * Math.abs(sine) + visibleHeight * Math.abs(cosine);
  const scale =
    mode === 'fit'
      ? Math.min(frameWidth / rotatedWidth, frameHeight / rotatedHeight)
      : Math.max(
          (frameWidth * Math.abs(cosine) + frameHeight * Math.abs(sine)) / visibleWidth,
          (frameWidth * Math.abs(sine) + frameHeight * Math.abs(cosine)) / visibleHeight,
        );
  if (!Number.isFinite(scale) || scale <= 0) return undefined;

  const pivotX = visibleLeft + visibleWidth * anchor.x;
  const pivotY = visibleTop + visibleHeight * anchor.y;
  const corners = [
    { x: visibleLeft, y: visibleTop },
    { x: visibleLeft + visibleWidth, y: visibleTop },
    { x: visibleLeft + visibleWidth, y: visibleTop + visibleHeight },
    { x: visibleLeft, y: visibleTop + visibleHeight },
  ].map(({ x, y }) => {
    const offsetX = (x - pivotX) * scale;
    const offsetY = (y - pivotY) * scale;
    return {
      x: pivotX * scale + offsetX * cosine - offsetY * sine,
      y: pivotY * scale + offsetX * sine + offsetY * cosine,
    };
  });
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));
  const x = frameWidth / 2 - (minX + maxX) / 2;
  const y = frameHeight / 2 - (minY + maxY) / 2;
  if (![x, y].every(Number.isFinite)) return undefined;
  return {
    x: cleanNearInteger(x),
    y: cleanNearInteger(y),
    scaleX: cleanNearInteger(scale),
    scaleY: cleanNearInteger(scale),
  };
}
