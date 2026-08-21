import type { RenderManifest } from '@joy-media/export-core';
import type { RenderBundleV1 } from '@joy-media/render-planner';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBundleToFile } from '@joy-media/render-host';
import type { WorkerMediaResolver } from './worker-media-resolver.js';
export interface ExportLeaseCoordinator {
  complete(workerId: string, jobId: string): unknown;
}

export interface ExecuteLeasedExportOptions {
  readonly outputDirectory?: string;
  readonly mediaResolver: WorkerMediaResolver;
  readonly frameLimit?: number;
}

export interface RenderExportReceiptV1 {
  readonly kind: 'render.export';
  readonly outputRef: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifest: RenderManifest;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly toolVersions: {
    readonly renderHost: string;
    readonly ffmpeg: string;
    readonly ffprobe: string;
  };
}

/**
 * Completion is withheld until the shared render host streams real project
 * frames to FFmpeg and ffprobe validates the encoded output.
 */
export async function executeLeasedExport(
  coordinator: ExportLeaseCoordinator,
  workerId: string,
  jobId: string,
  bundle: RenderBundleV1,
  options: ExecuteLeasedExportOptions,
): Promise<RenderExportReceiptV1> {
  const outputDirectory = options.outputDirectory ?? join(tmpdir(), 'joy-media-worker-exports');
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, `${opaqueSegment(jobId)}.mp4`);
  try {
    const result = await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: options.mediaResolver,
      ...(options.frameLimit === undefined ? {} : { frameLimit: options.frameLimit }),
    });
    coordinator.complete(workerId, jobId);
    return {
      kind: 'render.export',
      outputRef: `render-${opaqueSegment(jobId)}-${result.sha256.slice(0, 16)}`,
      sha256: result.sha256,
      bytes: result.bytes,
      manifest: result.manifest,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      toolVersions: result.toolVersions,
    };
  } catch (error) {
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    throw error;
  }
}

function opaqueSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe.length > 0) return safe;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
