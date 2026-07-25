/** True when both junction clip bitmaps are present for a real A↔B gl blend. */
export function dualTextureBitmapsReady(
  leftClipId: string,
  rightClipId: string,
  videoBitmaps: ReadonlyMap<string, unknown>,
): boolean {
  return videoBitmaps.has(leftClipId) && videoBitmaps.has(rightClipId);
}
