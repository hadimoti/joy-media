import type { WORKER_PROTOCOL_VERSION } from './protocol.js';
import { type WorkerCapability } from './protocol.js';
import type { DeliveryPromiseV1, RenderReportV1 } from '@joy-media/production-quality';

export type RenderJobType = 'render.export' | 'render.inspect';
export type RenderCapability = RenderJobType;

export interface RenderJobPayload {
  readonly projectRef: string;
  readonly compositionId: string;
  readonly presetId: string;
  readonly reportRef: string;
  /** V1 remains accepted; V2 is validated as a typed immutable bundle. */
  readonly bundle?: unknown;
  readonly frameLimit?: number;
}

export interface RenderExportJob {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly type: 'render.export';
  readonly payload: RenderJobPayload;
  readonly requirements: {
    readonly capabilities: readonly WorkerCapability[];
    readonly privacy: 'local-only';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export interface RenderInspectJob {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly type: 'render.inspect';
  readonly payload: RenderInspectPayload | LegacyRenderInspectPayload;
  readonly requirements: {
    readonly capabilities: readonly WorkerCapability[];
    readonly privacy: 'local-only';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

/** Standalone inspection must name the already-uploaded export it reads. */
export interface RenderInspectPayload {
  readonly projectRef: string;
  readonly compositionId: string;
  readonly presetId: string;
  readonly reportRef: string;
  readonly artifactId: string;
  readonly outputRef: string;
  readonly promise: DeliveryPromiseV1;
  readonly mode?: 'sampled';
}

/** Explicit compatibility envelope for pre-artifact inspect jobs. */
export interface LegacyRenderInspectPayload {
  readonly projectRef: string;
  readonly compositionId: string;
  readonly presetId: string;
  readonly reportRef: string;
  readonly legacyVersion: 0;
}

export type RenderJob = RenderExportJob | RenderInspectJob;

export interface RenderExportReceipt {
  readonly kind: 'render.export';
  readonly reportRef: string;
  readonly outputRef: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly qualityReport?: RenderReportV1;
}

export interface RenderInspectReceipt {
  readonly kind: 'render.inspect';
  readonly reportRef: string;
  /** Required for v1 standalone inspection; optional only for legacy receipts. */
  readonly outputRef?: string;
  readonly report?: RenderReportV1;
  /** Legacy count retained for wire compatibility; never drives editor verification. */
  readonly findings?: number;
  /** Optional compatibility fields keep older generic Worker result consumers typed. */
  readonly sha256?: string;
  readonly bytes?: number;
}

export type RenderReceipt = RenderExportReceipt | RenderInspectReceipt;
