/**
 * Compute mean and max absolute channel difference between two equal-length
 * RGBA buffers (measuring RGB channels only so alpha padding cannot skew scores).
 */
export function computeRgbaDiffMetrics(rgbaA, rgbaB) {
  if (rgbaA.length !== rgbaB.length || rgbaA.length % 4 !== 0) {
    throw new Error(`RGBA buffer mismatch: ${rgbaA.length} vs ${rgbaB.length}`);
  }
  const pixelCount = rgbaA.length / 4;
  let totalAbs = 0;
  let maxDiff = 0;
  let changedPixels = 0;

  for (let i = 0; i < rgbaA.length; i += 4) {
    const dr = Math.abs(rgbaA[i] - rgbaB[i]);
    const dg = Math.abs(rgbaA[i + 1] - rgbaB[i + 1]);
    const db = Math.abs(rgbaA[i + 2] - rgbaB[i + 2]);
    const pixelMax = Math.max(dr, dg, db);
    if (pixelMax > 0) changedPixels += 1;
    if (pixelMax > maxDiff) maxDiff = pixelMax;
    totalAbs += dr + dg + db;
  }

  return {
    meanAbsDiff: pixelCount === 0 ? 0 : totalAbs / (pixelCount * 3),
    maxDiff,
    changedPixels,
    totalPixels: pixelCount,
  };
}

/**
 * Measure RGB color spread across a rendered RGBA frame to catch solid-color or
 * completely blank renders.
 */
export function computeRgbaSpread(rgba) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error(`Invalid RGBA buffer length: ${rgba.length}`);
  }
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return {
    rangeR: maxR - minR,
    rangeG: maxG - minG,
    rangeB: maxB - minB,
    maxChannelRange: Math.max(maxR - minR, maxG - minG, maxB - minB),
  };
}
