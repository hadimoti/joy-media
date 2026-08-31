import {
  freezeManifest,
  remuxBrowserMp4,
  verifyExportAgainstManifest,
} from '@joy-media/export-core';
import type { RenderManifest } from '@joy-media/export-core';
import { existsSync, rmSync } from 'node:fs';

export interface ExportJobPayload {
  readonly schemaVersion: 1;
  readonly manifest: RenderManifest;
  readonly frameCount: number;
  readonly producer: 'browser-staged-preview-export';
}

export interface ExportLeaseCoordinator {
  complete(
    workerId: string,
    jobId: string,
    now?: number,
    receipt?: unknown,
    leaseToken?: string,
  ): unknown;
}
export interface ExportJobResult {
  readonly outputPath: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
}

export interface LeasedExportInput {
  readonly sourcePath: string;
  readonly payload: ExportJobPayload;
}
/** Completion is withheld until FFmpeg output passes ffprobe verification. */
export function executeLeasedExport(
  coordinator: ExportLeaseCoordinator,
  workerId: string,
  jobId: string,
  input: LeasedExportInput,
  outputPath: string,
  leaseToken?: string,
): ExportJobResult {
  try {
    remuxBrowserMp4(
      input.sourcePath,
      outputPath,
      input.payload.manifest.frameRate,
      input.payload.frameCount,
    );
    const probe = verifyExportAgainstManifest(outputPath, input.payload.manifest);
    coordinator.complete(workerId, jobId, undefined, undefined, leaseToken);
    return { outputPath, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec };
  } catch (error) {
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    throw error;
  }
}

export function exportJobPayload(value: unknown): ExportJobPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('render.export payload must be an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1)
    throw new Error('render.export payload schemaVersion is invalid');
  if (candidate.producer !== 'browser-staged-preview-export')
    throw new Error('render.export payload producer is invalid');
  if (!Number.isSafeInteger(candidate.frameCount) || (candidate.frameCount as number) <= 0)
    throw new Error('render.export payload frameCount is invalid');
  const manifest = candidate.manifest;
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('render.export payload manifest is invalid');
  const manifestRecord = manifest as Record<string, unknown>;
  if (typeof manifestRecord.projectId !== 'string' || manifestRecord.projectId.length === 0)
    throw new Error('render.export payload projectId is invalid');
  if (
    manifestRecord.preset !== 'social-h264-aac' &&
    manifestRecord.preset !== 'reels-1080' &&
    manifestRecord.preset !== 'shorts-1080' &&
    manifestRecord.preset !== 'youtube-1080' &&
    manifestRecord.preset !== 'high-bitrate'
  )
    throw new Error('render.export payload preset is invalid');
  let frozenManifest: RenderManifest;
  try {
    frozenManifest = freezeManifest(manifest as RenderManifest);
  } catch (error) {
    throw new Error(
      `render.export payload manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (frozenManifest.durationUs > 86_400_000_000)
    throw new Error('render.export payload duration exceeds the 24 hour limit');
  const expectedFrameCount = Math.max(
    1,
    Math.round((frozenManifest.durationUs / 1_000_000) * frozenManifest.frameRate),
  );
  if (candidate.frameCount !== expectedFrameCount)
    throw new Error('render.export payload frameCount does not match the manifest');
  return {
    schemaVersion: 1,
    producer: 'browser-staged-preview-export',
    frameCount: candidate.frameCount as number,
    manifest: frozenManifest,
  };
}
