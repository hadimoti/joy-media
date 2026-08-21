/** P00.5 Worker protocol spike: outbound pairing, capability snapshots, and local-only thumbnails. */

import type { RenderJob, RenderReceipt } from './render-jobs.js';
import type {
  MediaAnalysisJob,
  ReferenceAnalysisEvidence,
  ReferenceAnalysisFinding,
  VideoReferenceAnalyzeJob,
  VideoReferenceAnalyzeReceipt,
} from './media-analysis-jobs.js';
import {
  assertValidVideoReferenceAnalyzePayload,
  assertValidVideoReferenceAnalyzeReceipt,
} from './media-analysis-jobs.js';

export const WORKER_PROTOCOL_VERSION = 1 as const;

export type WorkerCapability =
  | 'asset.thumbnail'
  | 'render.export'
  | 'render.inspect'
  | 'video.reference-analyze'
  | 'image.comfy'
  | 'audio.ml-denoise'
  | 'text.lm-studio'
  | 'text.openrouter'
  | 'video.runway'
  | 'edit.higgsfield';

export type SpecializedJobType =
  | 'image.comfy'
  | 'audio.ml-denoise'
  | 'text.lm-studio'
  | 'text.openrouter'
  | 'video.runway'
  | 'edit.higgsfield';
export const SPECIALIZED_JOB_TYPES: readonly WorkerCapability[] = [
  'image.comfy',
  'audio.ml-denoise',
  'text.lm-studio',
  'text.openrouter',
  'video.runway',
  'edit.higgsfield',
] as const;
export type WorkerJobType =
  'asset.thumbnail' | SpecializedJobType | MediaAnalysisJob['type'] | RenderJob['type'];
export const WORKER_JOB_TYPES: readonly WorkerJobType[] = [
  'asset.thumbnail',
  'render.export',
  'render.inspect',
  'video.reference-analyze',
  ...SPECIALIZED_JOB_TYPES,
] as const;

/** @deprecated Use SpecializedJobType */
export type LocalGpuWorkerJobType = SpecializedJobType;
/** @deprecated Use SPECIALIZED_JOB_TYPES */
export const LOCAL_GPU_WORKER_CAPABILITIES: readonly WorkerCapability[] = SPECIALIZED_JOB_TYPES;
export type ThumbnailJobState =
  'queued' | 'assigned' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface WorkerHello {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly workerId: string;
  readonly workerVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly capabilities: readonly WorkerCapability[];
  /** Opaque content identities already available to this worker; never filesystem paths. */
  readonly localAssetIds: readonly string[];
  readonly maxConcurrentJobs: number;
}

export interface PairingOffer {
  readonly pairingCode: string;
  readonly expiresAtMs: number;
}

export interface PairingRequest {
  readonly workerId: string;
  readonly pairingCode: string;
  /** Public-key fingerprint, not a private key or machine path. */
  readonly publicKeyFingerprint: string;
}

export interface PairingGrant {
  readonly workerId: string;
  readonly sessionToken: string;
}

export interface ThumbnailJob {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly type: 'asset.thumbnail';
  readonly payload: {
    readonly assetId: string;
    readonly maxEdgePx: number;
  };
  readonly requirements: {
    readonly capabilities: readonly WorkerCapability[];
    readonly privacy: 'local-only';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export interface AiJob {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly jobId: string;
  readonly type: SpecializedJobType;
  readonly payload: {
    readonly prompt: string;
    readonly negativePrompt?: string;
    readonly imageAssetId?: string;
    readonly model?: string;
    readonly params?: Record<string, unknown>;
  };
  readonly requirements: {
    readonly capabilities: readonly WorkerCapability[];
    readonly privacy: 'local-only' | 'remote-api';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export type WorkerJobV1 = ThumbnailJob | AiJob | MediaAnalysisJob | RenderJob;

export interface ThumbnailAssignment {
  readonly job: ThumbnailJob;
  readonly attempt: number;
}

export interface ThumbnailJobSnapshot {
  readonly job: ThumbnailJob;
  readonly state: ThumbnailJobState;
  readonly attempts: number;
  readonly assignedWorkerId?: string;
  readonly progress?: {
    readonly completed: number;
    readonly total: number;
    readonly message: string;
  };
  readonly cancellationRequested: boolean;
  readonly outputAssetId?: string;
  readonly failureCode?: string;
}

export interface WorkerCapabilitySnapshot {
  readonly hello: WorkerHello;
  readonly observedAtMs: number;
}

export interface JobEvent {
  readonly jobId: string;
  readonly type:
    | 'job.queued'
    | 'job.assigned'
    | 'job.progress'
    | 'job.cancelRequested'
    | 'job.canceled'
    | 'job.failed'
    | 'job.retried'
    | 'job.succeeded';
}

export class WorkerProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerProtocolError';
    this.code = code;
  }
}

export function isWorkerJobType(value: string): value is WorkerJobType {
  return (WORKER_JOB_TYPES as readonly string[]).includes(value);
}

export function requiredCapabilityForJobType(type: WorkerJobType): WorkerCapability {
  return type;
}

export function workerCanRunJob(
  capabilities: readonly string[],
  jobType: string,
): jobType is WorkerJobType {
  return isWorkerJobType(jobType) && capabilities.includes(requiredCapabilityForJobType(jobType));
}

export function validateWorkerJobV1(job: WorkerJobV1): WorkerJobV1 {
  if (job.protocolVersion !== WORKER_PROTOCOL_VERSION || !isWorkerJobType(job.type)) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'unsupported Worker job');
  }
  assertObjectKeys(
    job,
    [
      'protocolVersion',
      'jobId',
      'type',
      'payload',
      'requirements',
      'idempotencyKey',
      'maxAttempts',
    ],
    [],
    'job',
  );
  assertOpaqueIds([job.jobId, job.idempotencyKey], 'job identifiers');
  if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 20) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'invalid retry policy');
  }
  validateWorkerJobPayload(job);
  validateWorkerJobRequirements(job.type, job.requirements);
  if (!job.requirements.capabilities.includes(requiredCapabilityForJobType(job.type))) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'job capability requirement mismatch');
  }
  validateJsonBudget(
    job.payload,
    'payload',
    job.type === 'render.export' && 'bundle' in job.payload ? 1_000_000 : undefined,
  );
  validateJsonBudget(job.requirements, 'requirements');
  assertJsonHasNoPaths(job.payload, 'payload');
  return job;
}

export function validateWorkerReceiptForJob(
  jobType: WorkerJobType,
  receipt: WorkerResultReceiptV1 | undefined,
): WorkerResultReceiptV1 {
  if (receipt === undefined) {
    throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt is required');
  }
  validateJsonBudget(
    receipt,
    'receipt',
    jobType === 'render.export' && 'qualityReport' in receipt ? 65_536 : undefined,
  );
  assertJsonHasNoPaths(receipt, 'receipt');
  if (receipt.kind !== jobType) {
    throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt kind does not match job type');
  }
  validateWorkerReceiptShape(jobType, receipt);
  if ('sha256' in receipt && !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt hash is invalid');
  }
  if ('bytes' in receipt && (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1)) {
    throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt byte length is invalid');
  }
  return receipt;
}

export type WorkerResultReceiptV1 =
  | {
      readonly kind: 'fixture.thumbnail';
      readonly sha256: string;
      readonly bytes: number;
    }
  | {
      readonly kind: 'asset.thumbnail';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: 'image/jpeg';
        readonly width: number;
        readonly height: number;
      };
    }
  | {
      readonly kind: 'image.comfy' | 'audio.ml-denoise';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: string;
        readonly width?: number;
        readonly height?: number;
      };
    }
  | {
      readonly kind: 'text.lm-studio' | 'text.openrouter';
      readonly resultRef: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly model?: string;
    }
  | {
      readonly kind: 'video.runway' | 'edit.higgsfield';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: string;
        readonly width?: number;
        readonly height?: number;
      };
      readonly model?: string;
    }
  | {
      readonly kind: 'video.reference-analyze';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly descriptor: {
        readonly mimeType: string;
        readonly width: number;
        readonly height: number;
        readonly durationUs: number;
      };
      readonly summary: {
        readonly shotCount: number;
        readonly cutCount: number;
        readonly averageShotDurationUs: number;
        readonly fastestShotDurationUs: number;
        readonly sampleCount: number;
        readonly transcriptSegmentCount: number;
        readonly audioBeatCount: number;
      };
      readonly evidence: readonly ReferenceAnalysisEvidence[];
      readonly evidenceIds: readonly string[];
      readonly findings?: readonly ReferenceAnalysisFinding[];
      readonly model?: string;
    }
  | RenderReceipt;

interface WorkerSession {
  readonly workerId: string;
  readonly token: string;
  hello?: WorkerCapabilitySnapshot;
}

interface MutableJob {
  readonly job: ThumbnailJob;
  state: ThumbnailJobState;
  attempts: number;
  assignedWorkerId?: string;
  progress?: { completed: number; total: number; message: string };
  cancellationRequested: boolean;
  outputAssetId?: string;
  failureCode?: string;
}

/**
 * Deterministic stand-in for the control plane. All pairing/hello calls are
 * Worker-initiated; the coordinator has no path to open a connection to it.
 */
export class InMemoryWorkerCoordinator {
  readonly #offers = new Map<string, PairingOffer>();
  readonly #sessions = new Map<string, WorkerSession>();
  readonly #jobs = new Map<string, MutableJob>();
  readonly #events: JobEvent[] = [];
  #nextToken = 1;

  createPairingOffer(pairingCode: string, expiresAtMs: number): PairingOffer {
    if (pairingCode.length < 6 || !Number.isSafeInteger(expiresAtMs)) {
      throw new WorkerProtocolError('WORKER_PAIRING_OFFER_INVALID', 'invalid pairing offer');
    }
    const offer = { pairingCode, expiresAtMs };
    this.#offers.set(pairingCode, offer);
    return offer;
  }

  /** Called by the Worker over its outbound connection. */
  acceptOutboundPair(request: PairingRequest, nowMs: number): PairingGrant {
    const offer = this.#offers.get(request.pairingCode);
    if (offer === undefined || nowMs > offer.expiresAtMs) {
      throw new WorkerProtocolError('WORKER_PAIRING_DENIED', 'pairing code is missing or expired');
    }
    if (request.workerId.length === 0 || request.publicKeyFingerprint.length === 0) {
      throw new WorkerProtocolError('WORKER_PAIRING_DENIED', 'worker identity is incomplete');
    }
    this.#offers.delete(request.pairingCode);
    const token = `worker-session-${this.#nextToken++}`;
    this.#sessions.set(token, { workerId: request.workerId, token });
    return { workerId: request.workerId, sessionToken: token };
  }

  /** Receives a fresh capability report on the existing Worker-initiated session. */
  receiveHello(sessionToken: string, hello: WorkerHello, nowMs: number): WorkerCapabilitySnapshot {
    const session = this.requireSession(sessionToken);
    if (session.workerId !== hello.workerId || hello.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw new WorkerProtocolError(
        'WORKER_HELLO_REJECTED',
        'worker identity or protocol version mismatch',
      );
    }
    if (hello.maxConcurrentJobs < 1 || !Number.isSafeInteger(hello.maxConcurrentJobs)) {
      throw new WorkerProtocolError(
        'WORKER_HELLO_REJECTED',
        'maxConcurrentJobs must be a positive integer',
      );
    }
    assertOpaqueIds(hello.localAssetIds, 'localAssetIds');
    const snapshot = {
      hello: {
        ...hello,
        capabilities: [...hello.capabilities],
        localAssetIds: [...hello.localAssetIds],
      },
      observedAtMs: nowMs,
    };
    session.hello = snapshot;
    return snapshot;
  }

  capabilitySnapshot(workerId: string): WorkerCapabilitySnapshot | undefined {
    for (const session of this.#sessions.values()) {
      if (session.workerId === workerId) return session.hello;
    }
    return undefined;
  }

  enqueueThumbnail(job: ThumbnailJob): ThumbnailJobSnapshot {
    validateThumbnailJob(job);
    if (this.#jobs.has(job.jobId)) {
      throw new WorkerProtocolError('WORKER_JOB_DUPLICATE', `job "${job.jobId}" already exists`);
    }
    const state: MutableJob = { job, state: 'queued', attempts: 0, cancellationRequested: false };
    this.#jobs.set(job.jobId, state);
    this.emit(job.jobId, 'job.queued');
    return snapshotOf(state);
  }

  /** Called by a Worker polling over its outbound session; never pushes bytes to a Worker. */
  claimNextThumbnail(sessionToken: string): ThumbnailAssignment | undefined {
    const session = this.requireSession(sessionToken);
    const hello = session.hello?.hello;
    if (hello === undefined || !hello.capabilities.includes('asset.thumbnail')) return undefined;
    for (const job of this.#jobs.values()) {
      if (
        job.state === 'queued' &&
        hello.localAssetIds.includes(job.job.payload.assetId) &&
        job.attempts < job.job.maxAttempts
      ) {
        job.state = 'assigned';
        job.assignedWorkerId = session.workerId;
        job.attempts++;
        this.emit(job.job.jobId, 'job.assigned');
        return { job: job.job, attempt: job.attempts };
      }
    }
    return undefined;
  }

  beginThumbnail(sessionToken: string, jobId: string): void {
    const job = this.requireAssignment(sessionToken, jobId, 'assigned');
    job.state = 'preparing';
    job.state = 'running';
  }

  reportThumbnailProgress(
    sessionToken: string,
    jobId: string,
    completed: number,
    total: number,
    message: string,
  ): void {
    const job = this.requireAssignment(sessionToken, jobId, 'running');
    if (
      !Number.isSafeInteger(completed) ||
      !Number.isSafeInteger(total) ||
      completed < 0 ||
      total <= 0 ||
      completed > total
    ) {
      throw new WorkerProtocolError(
        'WORKER_PROGRESS_INVALID',
        'progress must be a valid bounded integer range',
      );
    }
    job.progress = { completed, total, message };
    this.emit(jobId, 'job.progress');
  }

  requestCancellation(jobId: string): void {
    const job = this.requireJob(jobId);
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
      throw new WorkerProtocolError(
        'WORKER_CANCEL_INVALID_STATE',
        `cannot cancel ${job.state} job`,
      );
    }
    job.cancellationRequested = true;
    this.emit(jobId, 'job.cancelRequested');
  }

  isCancellationRequested(sessionToken: string, jobId: string): boolean {
    return this.requireAssignment(sessionToken, jobId, 'running').cancellationRequested;
  }

  finishCanceled(sessionToken: string, jobId: string): void {
    const job = this.requireAssignment(sessionToken, jobId, 'running');
    if (!job.cancellationRequested) {
      throw new WorkerProtocolError(
        'WORKER_CANCEL_INVALID_STATE',
        'cancellation was not requested',
      );
    }
    job.state = 'canceled';
    this.emit(jobId, 'job.canceled');
  }

  failThumbnail(sessionToken: string, jobId: string, failureCode: string): void {
    const job = this.requireAssignment(sessionToken, jobId, 'running');
    job.state = 'failed';
    job.failureCode = failureCode;
    this.emit(jobId, 'job.failed');
  }

  retryThumbnail(jobId: string): void {
    const job = this.requireJob(jobId);
    if (job.state !== 'failed' || job.attempts >= job.job.maxAttempts) {
      throw new WorkerProtocolError('WORKER_RETRY_DENIED', 'job is not retryable');
    }
    job.state = 'queued';
    delete job.assignedWorkerId;
    delete job.progress;
    delete job.failureCode;
    job.cancellationRequested = false;
    this.emit(jobId, 'job.retried');
  }

  succeedThumbnail(sessionToken: string, jobId: string, outputAssetId: string): void {
    const job = this.requireAssignment(sessionToken, jobId, 'running');
    if (job.cancellationRequested) {
      throw new WorkerProtocolError(
        'WORKER_CANCEL_INVALID_STATE',
        'cannot succeed after cancellation request',
      );
    }
    assertOpaqueIds([outputAssetId], 'outputAssetId');
    job.state = 'succeeded';
    job.outputAssetId = outputAssetId;
    this.emit(jobId, 'job.succeeded');
  }

  jobSnapshot(jobId: string): ThumbnailJobSnapshot {
    return snapshotOf(this.requireJob(jobId));
  }

  events(): readonly JobEvent[] {
    return [...this.#events];
  }

  private requireSession(token: string): WorkerSession {
    const session = this.#sessions.get(token);
    if (session === undefined)
      throw new WorkerProtocolError('WORKER_SESSION_UNKNOWN', 'unknown Worker session');
    return session;
  }

  private requireJob(jobId: string): MutableJob {
    const job = this.#jobs.get(jobId);
    if (job === undefined)
      throw new WorkerProtocolError('WORKER_JOB_UNKNOWN', `unknown job "${jobId}"`);
    return job;
  }

  private requireAssignment(
    sessionToken: string,
    jobId: string,
    state: ThumbnailJobState,
  ): MutableJob {
    const session = this.requireSession(sessionToken);
    const job = this.requireJob(jobId);
    if (job.assignedWorkerId !== session.workerId || job.state !== state) {
      throw new WorkerProtocolError(
        'WORKER_JOB_NOT_OWNED',
        `Worker does not own ${jobId} in ${state}`,
      );
    }
    return job;
  }

  private emit(jobId: string, type: JobEvent['type']): void {
    this.#events.push({ jobId, type });
  }
}

function validateThumbnailJob(job: ThumbnailJob): void {
  if (job.protocolVersion !== WORKER_PROTOCOL_VERSION || job.type !== 'asset.thumbnail') {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'unsupported Worker job');
  }
  assertOpaqueIds([job.payload.assetId], 'assetId');
  if (
    !Number.isSafeInteger(job.payload.maxEdgePx) ||
    job.payload.maxEdgePx < 1 ||
    job.maxAttempts < 1
  ) {
    throw new WorkerProtocolError(
      'WORKER_JOB_INVALID',
      'invalid thumbnail dimensions or retry policy',
    );
  }
  if (
    job.requirements.privacy !== 'local-only' ||
    !job.requirements.capabilities.includes('asset.thumbnail')
  ) {
    throw new WorkerProtocolError(
      'WORKER_JOB_INVALID',
      'thumbnail jobs require local thumbnail capability',
    );
  }
}

function validateWorkerJobPayload(job: WorkerJobV1): void {
  switch (job.type) {
    case 'asset.thumbnail':
      assertObjectKeys(job.payload, ['assetId', 'maxEdgePx'], [], 'payload');
      assertOpaqueIds([job.payload.assetId], 'payload asset IDs');
      if (!Number.isSafeInteger(job.payload.maxEdgePx) || job.payload.maxEdgePx < 1) {
        throw new WorkerProtocolError('WORKER_JOB_INVALID', 'payload maxEdgePx is invalid');
      }
      return;
    case 'render.export':
      assertObjectKeys(
        job.payload,
        ['projectRef', 'compositionId', 'presetId', 'reportRef'],
        ['bundle', 'frameLimit'],
        'payload',
      );
      assertOpaqueIds(
        [
          job.payload.projectRef,
          job.payload.compositionId,
          job.payload.presetId,
          job.payload.reportRef,
        ],
        'payload references',
      );
      if (
        'frameLimit' in job.payload &&
        job.payload.frameLimit !== undefined &&
        (!Number.isSafeInteger(job.payload.frameLimit) || job.payload.frameLimit < 1)
      ) {
        throw new WorkerProtocolError('WORKER_JOB_INVALID', 'payload frameLimit is invalid');
      }
      return;
    case 'render.inspect':
      assertObjectKeys(
        job.payload,
        ['projectRef', 'compositionId', 'presetId', 'reportRef'],
        [],
        'payload',
      );
      assertOpaqueIds(
        [
          job.payload.projectRef,
          job.payload.compositionId,
          job.payload.presetId,
          job.payload.reportRef,
        ],
        'payload references',
      );
      return;
    case 'video.reference-analyze':
      try {
        assertValidVideoReferenceAnalyzePayload(job.payload, 'payload');
      } catch (error) {
        throw new WorkerProtocolError(
          'WORKER_JOB_INVALID',
          error instanceof Error ? error.message : 'payload is invalid',
        );
      }
      return;
    default:
      assertObjectKeys(
        job.payload,
        ['prompt'],
        ['negativePrompt', 'imageAssetId', 'model', 'params'],
        'payload',
      );
      if (typeof job.payload.prompt !== 'string') {
        throw new WorkerProtocolError('WORKER_JOB_INVALID', 'payload prompt is invalid');
      }
      if (
        ('negativePrompt' in job.payload &&
          job.payload.negativePrompt !== undefined &&
          typeof job.payload.negativePrompt !== 'string') ||
        ('model' in job.payload &&
          job.payload.model !== undefined &&
          typeof job.payload.model !== 'string')
      ) {
        throw new WorkerProtocolError('WORKER_JOB_INVALID', 'payload text fields are invalid');
      }
      if ('imageAssetId' in job.payload && job.payload.imageAssetId !== undefined) {
        assertOpaqueIds([job.payload.imageAssetId], 'payload asset IDs');
      }
      if ('params' in job.payload && job.payload.params !== undefined) {
        assertPlainObject(job.payload.params, 'payload params');
      }
  }
}

function validateWorkerJobRequirements(
  jobType: WorkerJobType,
  requirements: WorkerJobV1['requirements'],
): void {
  assertObjectKeys(requirements, ['capabilities', 'privacy'], [], 'requirements');
  if (
    !Array.isArray(requirements.capabilities) ||
    requirements.capabilities.some((capability) => !isWorkerCapability(capability))
  ) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements capabilities are invalid');
  }
  if (requirements.privacy !== 'local-only' && requirements.privacy !== 'remote-api') {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'requirements privacy is invalid');
  }
  if (
    (jobType === 'asset.thumbnail' ||
      jobType === 'video.reference-analyze' ||
      jobType === 'render.export' ||
      jobType === 'render.inspect') &&
    requirements.privacy !== 'local-only'
  ) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', 'job privacy requirement mismatch');
  }
}

function validateWorkerReceiptShape(jobType: WorkerJobType, receipt: WorkerResultReceiptV1): void {
  switch (jobType) {
    case 'asset.thumbnail': {
      const value = receipt as Extract<WorkerResultReceiptV1, { readonly kind: 'asset.thumbnail' }>;
      assertObjectKeys(
        value,
        ['kind', 'assetId', 'sha256', 'bytes', 'localRef', 'descriptor'],
        [],
        'receipt',
      );
      assertOpaqueIds([value.assetId, value.localRef], 'receipt references');
      assertObjectKeys(value.descriptor, ['mimeType', 'width', 'height'], [], 'receipt descriptor');
      if (
        value.descriptor.mimeType !== 'image/jpeg' ||
        !Number.isSafeInteger(value.descriptor.width) ||
        value.descriptor.width < 1 ||
        !Number.isSafeInteger(value.descriptor.height) ||
        value.descriptor.height < 1
      ) {
        throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt descriptor is invalid');
      }
      return;
    }
    case 'render.export': {
      const value = receipt as Extract<WorkerResultReceiptV1, { readonly kind: 'render.export' }>;
      assertObjectKeys(
        value,
        ['kind', 'reportRef', 'outputRef', 'sha256', 'bytes'],
        ['qualityReport'],
        'receipt',
      );
      assertOpaqueIds([value.reportRef, value.outputRef], 'receipt references');
      return;
    }
    case 'render.inspect': {
      const value = receipt as Extract<WorkerResultReceiptV1, { readonly kind: 'render.inspect' }>;
      assertObjectKeys(value, ['kind', 'reportRef', 'findings'], [], 'receipt');
      assertOpaqueIds([value.reportRef], 'receipt references');
      if (!Number.isSafeInteger(value.findings) || value.findings < 0) {
        throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt findings are invalid');
      }
      return;
    }
    case 'video.reference-analyze': {
      try {
        assertValidVideoReferenceAnalyzeReceipt(receipt, 'receipt');
      } catch (error) {
        throw new WorkerProtocolError(
          'WORKER_RECEIPT_INVALID',
          error instanceof Error ? error.message : 'receipt is invalid',
        );
      }
      return;
    }
    default: {
      if (jobType === 'text.lm-studio' || jobType === 'text.openrouter') {
        const value = receipt as Extract<
          WorkerResultReceiptV1,
          { readonly kind: 'text.lm-studio' | 'text.openrouter' }
        >;
        assertObjectKeys(value, ['kind', 'resultRef', 'sha256', 'bytes'], ['model'], 'receipt');
        assertOpaqueIds([value.resultRef], 'receipt references');
        if ('model' in value && value.model !== undefined && typeof value.model !== 'string') {
          throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt model is invalid');
        }
        return;
      }
      const value = receipt as Extract<
        WorkerResultReceiptV1,
        {
          readonly kind: 'image.comfy' | 'audio.ml-denoise' | 'video.runway' | 'edit.higgsfield';
        }
      >;
      assertObjectKeys(
        value,
        ['kind', 'assetId', 'sha256', 'bytes', 'localRef', 'descriptor'],
        ['model'],
        'receipt',
      );
      assertOpaqueIds([value.assetId, value.localRef], 'receipt references');
      assertObjectKeys(value.descriptor, ['mimeType'], ['width', 'height'], 'receipt descriptor');
      if (typeof value.descriptor.mimeType !== 'string' || value.descriptor.mimeType.length === 0) {
        throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt descriptor is invalid');
      }
      if ('model' in value && value.model !== undefined && typeof value.model !== 'string') {
        throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt model is invalid');
      }
      if (
        ('width' in value.descriptor &&
          value.descriptor.width !== undefined &&
          (!Number.isSafeInteger(value.descriptor.width) || value.descriptor.width < 1)) ||
        ('height' in value.descriptor &&
          value.descriptor.height !== undefined &&
          (!Number.isSafeInteger(value.descriptor.height) || value.descriptor.height < 1))
      ) {
        throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt descriptor is invalid');
      }
    }
  }
}

function assertOpaqueIds(ids: readonly string[], label: string): void {
  for (const id of ids) {
    if (id.length === 0 || /[\\/:]/.test(id)) {
      throw new WorkerProtocolError(
        'WORKER_PROTOCOL_PATH_FORBIDDEN',
        `${label} must contain opaque identifiers, not paths`,
      );
    }
  }
}

function validateJsonBudget(value: unknown, label: string, maxBytes = 16_384): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > maxBytes) {
    throw new WorkerProtocolError('WORKER_PROTOCOL_OVERSIZE', `${label} is too large`);
  }
}

function assertJsonHasNoPaths(value: unknown, label: string): void {
  if (typeof value === 'string') {
    if (looksLikePath(value)) {
      throw new WorkerProtocolError(
        'WORKER_PROTOCOL_PATH_FORBIDDEN',
        `${label} must not contain paths or URLs`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonHasNoPaths(item, label);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new WorkerProtocolError('WORKER_JOB_INVALID', `${label} contains an unsafe key`);
      }
      assertJsonHasNoPaths(item, label);
    }
  }
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith('file:') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

function assertObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new WorkerProtocolError('WORKER_JOB_INVALID', `${label} contains unknown fields`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new WorkerProtocolError('WORKER_JOB_INVALID', `${label} is missing ${key}`);
    }
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerProtocolError('WORKER_JOB_INVALID', `${label} must be an object`);
  }
}

function isWorkerCapability(value: unknown): value is WorkerCapability {
  return typeof value === 'string' && (WORKER_JOB_TYPES as readonly string[]).includes(value);
}

function snapshotOf(job: MutableJob): ThumbnailJobSnapshot {
  return {
    job: job.job,
    state: job.state,
    attempts: job.attempts,
    ...(job.assignedWorkerId === undefined ? {} : { assignedWorkerId: job.assignedWorkerId }),
    ...(job.progress === undefined ? {} : { progress: { ...job.progress } }),
    cancellationRequested: job.cancellationRequested,
    ...(job.outputAssetId === undefined ? {} : { outputAssetId: job.outputAssetId }),
    ...(job.failureCode === undefined ? {} : { failureCode: job.failureCode }),
  };
}
