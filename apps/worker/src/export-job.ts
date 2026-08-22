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
  complete(workerId: string, jobId: string, receipt: RenderExportCompletionReceipt): unknown;
}

/** Exact control-plane shape; render-local diagnostics stay on RenderExportReceiptV1. */
export type RenderExportCompletionReceipt = Pick<
  RenderExportReceiptV1,
  'kind' | 'reportRef' | 'outputRef' | 'sha256' | 'bytes'
> & { readonly qualityReport?: RenderReportV1 };

export function renderExportCompletionReceipt(
  receipt: RenderExportReceiptV1,
): RenderExportCompletionReceipt {
  return {
    kind: receipt.kind,
    reportRef: receipt.reportRef,
    outputRef: receipt.outputRef,
    sha256: receipt.sha256,
    bytes: receipt.bytes,
    ...(receipt.qualityReport === undefined ? {} : { qualityReport: receipt.qualityReport }),
  };
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
    const outputRef = `render-${opaqueSegment(jobId)}-${result.sha256.slice(0, 16)}`;
    const reportRef = options.reportRef ?? `report-${opaqueSegment(jobId)}`;
    if (!existsSync(outputPath)) throw new Error('render export artifact is missing');
    const qualityReport = verifyExportDelivery(
      outputPath,
      deliveryPromiseForManifest(result.manifest),
      {
        outputRef,
      },
    );
    assertApiSafeRenderReport(qualityReport);
    rejectFailedDelivery(qualityReport);
    const receipt: RenderExportReceiptV1 = {
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
    coordinator.complete(workerId, jobId, renderExportCompletionReceipt(receipt));
    return receipt;
  } catch (error) {
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    throw error;
  }
}

function rejectFailedDelivery(report: RenderReportV1): void {
  const failed = report.findings.filter((finding) => finding.status === 'fail');
  if (failed.length > 0) {
    throw new Error(
      `render delivery quality failed: ${failed.map((finding) => finding.code).join(', ')}`,
    );
  }
}

function opaqueSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe.length > 0) return safe;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
