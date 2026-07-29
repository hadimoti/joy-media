const EFFECT_PREVIEW_REVISION = 'pixel-bw-v1';

export function effectPreviewUrl(effectId: string): string {
  return `/effects/preview/${encodeURIComponent(effectId)}.png?v=${EFFECT_PREVIEW_REVISION}`;
}
