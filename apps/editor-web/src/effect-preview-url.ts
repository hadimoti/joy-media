const EFFECT_PREVIEW_REVISION = 'pixi-webp-v2';

export function effectPreviewUrl(effectId: string): string {
  return `/effects/preview/${encodeURIComponent(effectId)}.webp?v=${EFFECT_PREVIEW_REVISION}`;
}

export function effectBeforePreviewUrl(): string {
  return `/effects/preview/before.webp?v=${EFFECT_PREVIEW_REVISION}`;
}
