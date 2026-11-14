/**
 * Transition preview strips are built by tooling/previews (T-V02): one WebP per
 * catalogue id, 24 frames side by side, held on picture 1, then the transition,
 * then held on picture 2. Frame 0 is the still shown at rest.
 */
const TRANSITION_PREVIEW_REVISION = 'strip-webp-v1';

export const TRANSITION_STRIP_FRAME_COUNT = 24;
export const TRANSITION_STRIP_FRAME_WIDTH = 144;
export const TRANSITION_STRIP_FRAME_HEIGHT = 108;

/** The builder names a file after the catalogue id with ":" replaced by "-". */
export function transitionStripFileId(transitionId: string): string {
  return transitionId.replace(/:/g, '-');
}

export function transitionStripUrl(transitionId: string): string {
  return `/transitions/preview/${encodeURIComponent(transitionStripFileId(transitionId))}.webp?v=${TRANSITION_PREVIEW_REVISION}`;
}
