export type FixedPreviewQuality = 'quarter' | 'half' | 'full';
export type PreviewQuality = 'auto' | FixedPreviewQuality;
export interface PreviewFrameRate {
  readonly num: number;
  readonly den: number;
}

export const DEFAULT_PREVIEW_QUALITY: PreviewQuality = 'auto';

export function previewQualityScale(quality: FixedPreviewQuality): number {
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
export function previewQualityResolution(quality: FixedPreviewQuality): number {
  return previewQualityScale(quality);
}

export function previewQualityLabel(quality: PreviewQuality): string {
  switch (quality) {
    case 'auto':
      return 'Auto';
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
  quality: FixedPreviewQuality,
): { readonly width: number; readonly height: number } {
  const scale = previewQualityScale(quality);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Estimate the highest quality that fits the frame budget from the latest render time. */
export function chooseAutoPreviewQuality(
  measuredQuality: FixedPreviewQuality,
  renderDurationMs: number,
  frameRate: PreviewFrameRate,
): FixedPreviewQuality {
  const fps = frameRate.num / frameRate.den;
  if (!(fps > 0) || !Number.isFinite(fps) || !(renderDurationMs >= 0)) return measuredQuality;
  if (renderDurationMs === 0) return 'full';

  const frameBudgetMs = 1000 / fps;
  const measuredAreaScale = previewQualityScale(measuredQuality) ** 2;
  for (const candidate of ['full', 'half', 'quarter'] as const) {
    const candidateAreaScale = previewQualityScale(candidate) ** 2;
    const estimatedDurationMs = renderDurationMs * (candidateAreaScale / measuredAreaScale);
    if (estimatedDurationMs <= frameBudgetMs) return candidate;
  }
  return 'quarter';
}

/** Resolve a saved mode to the fixed quality the renderer should draw now. */
export function resolvePreviewQuality(
  quality: PreviewQuality,
  autoQuality: FixedPreviewQuality,
  paused: boolean,
): FixedPreviewQuality {
  if (quality !== 'auto') return quality;
  return paused ? 'full' : autoQuality;
}
