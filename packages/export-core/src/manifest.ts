export interface RenderManifest {
  readonly projectId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly preset: ExportPresetId;
}

export type ExportPresetId =
  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';

export function dimensionsForPreset(
  preset: ExportPresetId,
  fallback: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  switch (preset) {
    case 'reels-1080':
    case 'shorts-1080':
      return { width: 1080, height: 1920 };
    case 'youtube-1080':
      return { width: 1920, height: 1080 };
    case 'high-bitrate':
      return { width: Math.max(fallback.width, 1920), height: Math.max(fallback.height, 1080) };
    default:
      return fallback;
  }
}

/** Validate and freeze the manifest shared by Node and browser projections. */
export function freezeManifest(manifest: RenderManifest): RenderManifest {
  if (
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Number.isSafeInteger(manifest.width) ||
    !Number.isSafeInteger(manifest.height) ||
    manifest.width < 1 ||
    manifest.height < 1 ||
    !Number.isFinite(manifest.frameRate) ||
    manifest.frameRate <= 0 ||
    !Number.isSafeInteger(manifest.durationUs) ||
    manifest.durationUs < 1
  )
    throw new RangeError('render manifest is invalid');
  return Object.freeze({ ...manifest });
}
