export type PreviewQuality = 'quarter' | 'half' | 'full';

export const DEFAULT_PREVIEW_QUALITY: PreviewQuality = 'quarter';

export function previewQualityScale(quality: PreviewQuality): number {
  switch (quality) {
    case 'quarter':
      return 0.25;
    case 'half':
      return 0.5;
    case 'full':
      return 1;
  }
}

/** Internal GPU pixel density. The authored viewport/CSS size is unchanged. */
export function previewQualityResolution(quality: PreviewQuality): number {
  return previewQualityScale(quality);
}

export function previewQualityLabel(quality: PreviewQuality): string {
  switch (quality) {
    case 'quarter':
      return 'Quarter';
    case 'half':
      return 'Half';
    case 'full':
      return 'Full';
  }
}

export function previewDimensions(
  width: number,
  height: number,
  quality: PreviewQuality,
): { readonly width: number; readonly height: number } {
  const scale = previewQualityScale(quality);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
