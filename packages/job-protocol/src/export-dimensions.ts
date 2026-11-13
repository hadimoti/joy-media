/**
 * H.264 canvases are kept at their authored size. Odd dimensions are refused instead of silently
 * rounded, and the current export budget is 4,096 pixels per side with at most 8,294,400 pixels.
 */
export const MAX_H264_EXPORT_DIMENSION = 4_096;
export const MAX_H264_EXPORT_PIXELS = 8_294_400;

export type H264ExportDimensionsResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Validate H.264 export dimensions shared by the editor, export core, and Worker. */
export function validateH264ExportDimensions(
  width: number,
  height: number,
): H264ExportDimensionsResult {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return { ok: false, reason: 'H.264 export dimensions must be positive whole pixels.' };

  if (
    width > MAX_H264_EXPORT_DIMENSION ||
    height > MAX_H264_EXPORT_DIMENSION ||
    width * height > MAX_H264_EXPORT_PIXELS
  )
    return {
      ok: false,
      reason: `H.264 export supports up to 4,096 pixels per side and 8,294,400 pixels total. This canvas is ${width}x${height}. Choose a smaller canvas size.`,
    };

  if (width % 2 !== 0 || height % 2 !== 0)
    return {
      ok: false,
      reason: `H.264 export needs an even width and height. This canvas is ${width}x${height}. Change the canvas to even pixel sizes and try again.`,
    };

  return { ok: true };
}
