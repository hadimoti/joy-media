import { renderFixture, verifyExport } from '@joy-media/export-core';
import type { RenderManifest } from '@joy-media/export-core';
import { existsSync, rmSync } from 'node:fs';
export interface ExportLeaseCoordinator {
  complete(workerId: string, jobId: string): unknown;
}
export interface ExportJobResult {
  readonly outputPath: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
}
/** Completion is withheld until FFmpeg output passes ffprobe verification. */
export function executeLeasedExport(
  coordinator: ExportLeaseCoordinator,
  workerId: string,
  jobId: string,
  manifest: RenderManifest,
  outputPath: string,
): ExportJobResult {
  try {
    renderFixture(manifest, outputPath);
    const probe = verifyExport(outputPath);
    coordinator.complete(workerId, jobId);
    return { outputPath, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec };
  } catch (error) {
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    throw error;
  }
}
