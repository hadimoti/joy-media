/**
 * A prepared export record can be rendered from a detached video, a decoded
 * still image, or a decoded animated-image source. Keep this predicate shared
 * so image media is not accidentally filtered out before captureExportClip().
 */
export interface PreparedExportMediaLike {
  readonly [key: string]: unknown;
  readonly video?: unknown;
  readonly stillFrame?: unknown;
  readonly animatedFrameSource?: unknown;
}

export function hasRenderableExportMedia(media: PreparedExportMediaLike): boolean {
  return (
    media.video !== undefined ||
    media.stillFrame !== undefined ||
    media.animatedFrameSource !== undefined
  );
}
