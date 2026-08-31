export type BrowserExportPresetId =
  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';

export interface BrowserRenderExportJobInput {
  readonly controlPlaneProjectId: string;
  readonly frameCount: number;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly preset: BrowserExportPresetId;
}

/**
 * MediaRecorder exposes codec-qualified MIME values, while the control plane
 * stores canonical media types in asset descriptors.
 */
export function canonicalStagedExportMimeType(mimeType: string): 'video/mp4' {
  const canonical = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  if (canonical !== 'video/mp4')
    throw new Error(`Browser export produced unsupported MIME type: ${mimeType}`);
  return 'video/mp4';
}

/** Builds the exact render.export envelope accepted by the control plane. */
export function createRenderExportJobPayload(
  input: BrowserRenderExportJobInput,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    producer: 'browser-staged-preview-export',
    frameCount: input.frameCount,
    manifest: {
      projectId: input.controlPlaneProjectId,
      revision: input.revision,
      width: input.width,
      height: input.height,
      frameRate: input.frameRate,
      durationUs: input.durationUs,
      preset: input.preset,
    },
  };
}
