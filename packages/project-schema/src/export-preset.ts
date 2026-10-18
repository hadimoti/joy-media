import type { ExportPresetId } from './v1.js';

export interface ExportDimensions {
  readonly width: number;
  readonly height: number;
}

/** Resolve a preset without changing the composition's authored aspect ratio. */
export function dimensionsForExportPreset(
  preset: ExportPresetId,
  fallback: ExportDimensions,
): ExportDimensions {
  switch (preset) {
    case 'reels-1080':
    case 'shorts-1080':
      return { width: 1080, height: 1920 };
    case 'youtube-1080':
      return { width: 1920, height: 1080 };
    case 'high-bitrate': {
      const scale = Math.max(1, 1920 / Math.max(fallback.width, fallback.height));
      return {
        width: Math.round(fallback.width * scale),
        height: Math.round(fallback.height * scale),
      };
    }
    default:
      return fallback;
  }
}
