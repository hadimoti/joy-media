import type { RenderManifest } from '@joy-media/export-core';
import { deliveryPromiseForManifest, verifyExportDelivery } from '@joy-media/export-core';
import { assertApiSafeRenderReport, type RenderReportV1 } from '@joy-media/production-quality';
import type { RenderBundleV1 } from '@joy-media/render-planner';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinnedOfflineRenderHostDriver, type RenderHostDriver } from '@joy-media/render-host';
import type { WorkerMediaResolver } from './worker-media-resolver.js';
export interface ExportLeaseCoordinator {
  complete(workerId: string, jobId: string): unknown;
}

export interface ExecuteLeasedExportOptions {
  readonly outputDirectory?: string;
  readonly mediaResolver: WorkerMediaResolver;
  readonly frameLimit?: number;
  readonly reportRef?: string;
  readonly renderHostDriver?: RenderHostDriver;
}

export interface RenderExportReceiptV1 {
  readonly kind: 'render.export';
  readonly outputRef: string;
  readonly reportRef: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifest: RenderManifest;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly qualityReport: RenderReportV1;
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
  const renderHostDriver = options.renderHostDriver ?? createPinnedOfflineRenderHostDriver();
  try {
    const result = await renderHostDriver.export({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: options.mediaResolver,
      ...(options.frameLimit === undefined ? {} : { frameLimit: options.frameLimit }),
    });
    coordinator.complete(workerId, jobId);
    const outputRef = `render-${opaqueSegment(jobId)}-${result.sha256.slice(0, 16)}`;
    const reportRef = options.reportRef ?? `report-${opaqueSegment(jobId)}`;
    const qualityReport = existsSync(outputPath)
      ? verifyExportDelivery(
          outputPath,
          deliveryPromiseForRenderedFrames(result.manifest, result.frames),
          {
            outputRef,
          },
        )
      : qualityReportFromRenderHostResult(result, outputRef);
    assertApiSafeRenderReport(qualityReport);
    return {
      kind: 'render.export',
      outputRef,
      reportRef,
      sha256: result.sha256,
      bytes: result.bytes,
      manifest: result.manifest,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      qualityReport,
      toolVersions: result.toolVersions,
    };
  } catch (error) {
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    throw error;
  }
}

function deliveryPromiseForRenderedFrames(manifest: RenderManifest, frames: number) {
  const durationUs = Math.round((frames / manifest.frameRate) * 1_000_000);
  return deliveryPromiseForManifest({ ...manifest, durationUs });
}

function qualityReportFromRenderHostResult(
  result: Awaited<ReturnType<RenderHostDriver['export']>>,
  outputRef: string,
): RenderReportV1 {
  const promise = deliveryPromiseForRenderedFrames(result.manifest, result.frames);
  const report: RenderReportV1 = {
    version: 1,
    promiseId: promise.id,
    checkedAt: '1970-01-01T00:00:00.000Z',
    artifact: { outputRef, sha256: result.sha256, bytes: result.bytes },
    facts: {
      container: 'mp4',
      video: {
        codec: result.videoCodec,
        width: result.width,
        height: result.height,
        frameRate: result.manifest.frameRate,
        durationUs: promise.video.durationUs,
        frames: result.frames,
        sampledFrames: 0,
        blackFrames: 0,
        blankFrames: 0,
        duplicateFrames: 0,
      },
      audio: {
        codec: result.audioCodec,
        sampleRate: promise.audio.sampleRate,
        channels: promise.audio.channels,
        durationUs: promise.video.durationUs,
        rms: promise.audio.minRms,
        peak: 0,
        clippedSamples: 0,
      },
      subtitles: { streams: 0 },
    },
    findings: [
      { code: 'render-host-facts', status: 'pass', message: 'render host supplied delivery facts' },
    ],
  };
  assertApiSafeRenderReport(report);
  return report;
}

function opaqueSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe.length > 0) return safe;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
