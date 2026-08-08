/** P00.5 Worker protocol spike: outbound pairing, capability snapshots, and local-only thumbnails. */

export const WORKER_PROTOCOL_VERSION = 1 as const;

export type WorkerCapability =
  | 'asset.thumbnail'
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
