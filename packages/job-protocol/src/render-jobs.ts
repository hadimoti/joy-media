import { WORKER_PROTOCOL_VERSION, type WorkerCapability } from './protocol.js';

export type RenderJobType = 'render.export' | 'render.inspect';
export type RenderCapability = RenderJobType;

export interface RenderJobPayload {
  readonly projectRef: string;
  readonly compositionId: string;
  readonly presetId: string;
  readonly reportRef: string;
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
  readonly payload: RenderJobPayload;
  readonly requirements: {
    readonly capabilities: readonly WorkerCapability[];
    readonly privacy: 'local-only';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export type RenderJob = RenderExportJob | RenderInspectJob;

export interface RenderExportReceipt {
  readonly kind: 'render.export';
  readonly reportRef: string;
  readonly outputRef: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly qualityReport?: unknown;
}

export interface RenderInspectReceipt {
  readonly kind: 'render.inspect';
  readonly reportRef: string;
  readonly findings: number;
}

export type RenderReceipt = RenderExportReceipt | RenderInspectReceipt;
