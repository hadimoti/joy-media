import { randomBytes } from 'node:crypto';
import type { DerivativeReceipt, DispatchJob, JobDispatchStore } from './job-dispatch.js';

/** Worker leases last this long unless the Worker asks for less; each heartbeat renews it. */
export const DEFAULT_LEASE_MS = 30_000;
export const MAX_LEASE_MS = 120_000;
export const EXPIRED_LEASE_ERROR = 'worker lease expired';
export const CANCELLED_BY_USER = 'cancelled by user';
const MAX_ERROR_LENGTH = 240;

/** Protocol refusal that the loopback API maps onto an HTTP status. */
export class JobProtocolError extends Error {
  constructor(
    readonly status: 404 | 409 | 413 | 422,
    message: string,
  ) {
    super(message);
    this.name = 'JobProtocolError';
  }
}

interface JobRequirement {
  readonly capability: string;
  readonly missing: string;
}

/**
 * Worker capability each job type needs. A job whose capability the Worker has not advertised is
 * refused with SETUP_REQUIRED instead of being queued, so nothing reports success it cannot do.
 */
const JOB_REQUIREMENTS: Readonly<Record<string, JobRequirement>> = {
  'asset.thumbnail': {
    capability: 'asset.thumbnail',
    missing: 'FFmpeg and FFprobe on the local Worker',
  },
  'render.export': {
    capability: 'render.export',
    missing: 'FFmpeg, FFprobe and the export source downloader on the local Worker',
  },
  'mask.image': { capability: 'mask.image', missing: 'local masking models for mask.image' },
  'mask.video': { capability: 'mask.video', missing: 'local masking models for mask.video' },
  'upscale.image': { capability: 'upscale.image', missing: 'the installed upscaling model' },
  'upscale.video': { capability: 'upscale.video', missing: 'the installed upscaling model' },
};

/** Job types the desktop submits and the Worker can lease. */
const DISPATCHABLE_JOB_TYPES = ['asset.thumbnail', 'render.export', 'upscale.image'] as const;
/** Job types whose Worker needs a payload. The desktop stores it at submit and sends it with the lease. */
const PAYLOAD_JOB_TYPES: ReadonlySet<string> = new Set(['render.export', 'upscale.image']);
/** A payload is stored as JSON in the local database and handed to the Worker whole, so it is capped. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Encodes the payload a job type takes, or refuses it. A payload-carrying type needs a JSON object within the size cap;
 * every other type refuses a payload, so no job is queued with data its Worker would ignore.
 */
function encodePayload(
  jobType: string,
  payload: unknown,
):
  | { readonly ok: true; readonly json: string | undefined }
  | { readonly ok: false; readonly message: string } {
  if (!PAYLOAD_JOB_TYPES.has(jobType)) {
    return payload === undefined
      ? { ok: true, json: undefined }
      : { ok: false, message: `${jobType} does not take a payload` };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: `${jobType} needs a JSON object payload` };
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, message: `${jobType} payload is larger than ${MAX_PAYLOAD_BYTES} bytes` };
  }
  return { ok: true, json };
}

export type SubmitResult =
  | { readonly ok: true; readonly jobId: string }
  | {
      readonly ok: false;
      readonly code: 'SETUP_REQUIRED' | 'UNSUPPORTED_JOB' | 'PAYLOAD_INVALID';
      readonly jobType: string;
      readonly message: string;
    };

export interface LeasedWorkerJob {
  readonly id: string;
  readonly jobType: string;
  readonly refId: string;
  readonly leaseToken: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type CancelResult =
  { readonly ok: true; readonly job: DispatchJob } | { readonly ok: false; readonly error: string };

export interface JobOrchestratorOptions {
  readonly store: JobDispatchStore;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly newLeaseToken?: () => string;
  /** Upper bound on any lease window. Defaults to MAX_LEASE_MS; tests lower it to exercise expiry quickly. */
  readonly maxLeaseMs?: number;
}

export interface JobOrchestrator {
  submit(request: {
    readonly jobType: string;
    readonly refId: string;
    readonly kind: string;
    readonly payload?: unknown;
  }): SubmitResult;
  hello(workerId: string, capabilities: readonly string[]): void;
  lease(workerId: string, durationMs?: number): LeasedWorkerJob | undefined;
  heartbeat(
    workerId: string,
    jobId: string,
    leaseToken: string,
    progress: number,
  ): { readonly cancelRequested: boolean };
  assertLeaseHolder(workerId: string, jobId: string, leaseToken: string): DispatchJob;
  recordDerivative(
    workerId: string,
    jobId: string,
    leaseToken: string,
    receipt: DerivativeReceipt,
  ): void;
  complete(
    workerId: string,
    jobId: string,
    leaseToken: string,
    completion: {
      readonly kind: string;
      readonly sha256?: string;
      readonly bytes?: number;
      readonly resultJson: string;
    },
  ): void;
  fail(workerId: string, jobId: string, leaseToken: string, error: string): void;
  requestCancel(jobId: string): CancelResult;
  expireLeases(): number;
  get(jobId: string): DispatchJob | undefined;
}

export function createJobOrchestrator(options: JobOrchestratorOptions): JobOrchestrator {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const newLeaseToken = options.newLeaseToken ?? (() => randomBytes(32).toString('base64url'));
  const leaseCap = Math.min(options.maxLeaseMs ?? MAX_LEASE_MS, MAX_LEASE_MS);

  function leaseExpiry(durationMs: number): string {
    return new Date(Date.parse(now()) + Math.min(durationMs, leaseCap)).toISOString();
  }

  function requireJob(jobId: string): DispatchJob {
    const job = store.get(jobId);
    if (job === undefined) throw new JobProtocolError(404, 'unknown job');
    return job;
  }

  function assertHolder(workerId: string, jobId: string, leaseToken: string): DispatchJob {
    const job = requireJob(jobId);
    const holds =
      job.status === 'running' &&
      job.workerId === workerId &&
      job.leaseToken !== undefined &&
      job.leaseToken === leaseToken &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt >= now();
    if (!holds) throw new JobProtocolError(409, 'lease is not held by this worker');
    return job;
  }

  /** Runs inside the caller's transaction; SQLite does not allow nesting one. */
  function expireLeasesWithin(): number {
    const expired = store.expiredRunning(now());
    for (const job of expired) {
      if (job.cancelRequested) finish(job, 'cancelled', CANCELLED_BY_USER);
      else finish(job, 'failed', EXPIRED_LEASE_ERROR);
    }
    return expired.length;
  }

  function finish(
    job: DispatchJob,
    status: 'done' | 'failed' | 'cancelled',
    error: string | undefined,
    patch: Partial<DispatchJob> = {},
  ): void {
    store.save({
      ...job,
      ...patch,
      status,
      error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now(),
    });
  }

  return {
    submit({ jobType, refId, kind, payload }) {
      const requirement = JOB_REQUIREMENTS[jobType];
      if (requirement === undefined) {
        return {
          ok: false,
          code: 'UNSUPPORTED_JOB',
          jobType,
          message: `unknown job type ${jobType}`,
        };
      }
      const presence = store.presence();
      if (presence === undefined) {
        // Before the Worker's first hello the thumbnail queues and runs once the Worker reports in.
        // Every other type needs proof of capability first, so it is refused.
        if (jobType !== 'asset.thumbnail') {
          return {
            ok: false,
            code: 'SETUP_REQUIRED',
            jobType,
            message: `Worker has not reported its capabilities; ${requirement.missing} is required`,
          };
        }
      } else if (!presence.capabilities.includes(requirement.capability)) {
        return {
          ok: false,
          code: 'SETUP_REQUIRED',
          jobType,
          message: `${requirement.missing} is required`,
        };
      }
      if (!(DISPATCHABLE_JOB_TYPES as readonly string[]).includes(jobType)) {
        return {
          ok: false,
          code: 'UNSUPPORTED_JOB',
          jobType,
          message: `the desktop does not submit ${jobType} jobs yet`,
        };
      }
      const payloadResult = encodePayload(jobType, payload);
      if (!payloadResult.ok) {
        return { ok: false, code: 'PAYLOAD_INVALID', jobType, message: payloadResult.message };
      }
      const timestamp = now();
      const job: DispatchJob = {
        id: newId(),
        kind,
        jobType,
        refId,
        status: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        error: undefined,
        progress: 0,
        attempts: 0,
        workerId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        cancelRequested: false,
        derivative: undefined,
        resultJson: undefined,
        payloadJson: payloadResult.json,
      };
      store.transaction(() => store.insert(job));
      return { ok: true, jobId: job.id };
    },

    hello(workerId, capabilities) {
      store.transaction(() =>
        store.savePresence({
          workerId,
          capabilities: [...new Set(capabilities)].sort(),
          lastHelloAt: now(),
        }),
      );
    },

    lease(workerId, durationMs = DEFAULT_LEASE_MS) {
      return store.transaction(() => {
        expireLeasesWithin();
        const presence = store.presence();
        if (presence === undefined || presence.workerId !== workerId)
          throw new JobProtocolError(409, 'worker has not said hello');
        const types = DISPATCHABLE_JOB_TYPES.filter((type) =>
          presence.capabilities.includes(JOB_REQUIREMENTS[type]?.capability ?? ''),
        );
        const next = store.nextQueued(types);
        if (next === undefined) return undefined;
        const leaseToken = newLeaseToken();
        const timestamp = now();
        const running: DispatchJob = {
          ...next,
          status: 'running',
          updatedAt: timestamp,
          attempts: next.attempts + 1,
          workerId,
          leaseToken,
          leaseExpiresAt: leaseExpiry(Math.min(Math.max(durationMs, 1_000), MAX_LEASE_MS)),
          progress: 0,
        };
        store.save(running);
        return {
          id: running.id,
          jobType: running.jobType,
          refId: running.refId,
          leaseToken,
          ...(running.payloadJson === undefined
            ? {}
            : { payload: JSON.parse(running.payloadJson) as Record<string, unknown> }),
        };
      });
    },

    heartbeat(workerId, jobId, leaseToken, progress) {
      return store.transaction(() => {
        const job = assertHolder(workerId, jobId, leaseToken);
        store.save({
          ...job,
          progress: Math.min(100, Math.max(0, Math.round(progress))),
          leaseExpiresAt: leaseExpiry(DEFAULT_LEASE_MS),
          updatedAt: now(),
        });
        return { cancelRequested: job.cancelRequested };
      });
    },

    assertLeaseHolder(workerId, jobId, leaseToken) {
      return assertHolder(workerId, jobId, leaseToken);
    },

    recordDerivative(workerId, jobId, leaseToken, receipt) {
      store.transaction(() => {
        const job = assertHolder(workerId, jobId, leaseToken);
        store.save({ ...job, derivative: receipt, updatedAt: now() });
      });
    },

    complete(workerId, jobId, leaseToken, completion) {
      store.transaction(() => {
        const job = assertHolder(workerId, jobId, leaseToken);
        if (job.jobType === 'asset.thumbnail') {
          const derivative = job.derivative;
          if (
            completion.kind !== 'asset.thumbnail' ||
            derivative === undefined ||
            completion.sha256 !== derivative.sha256 ||
            completion.bytes !== derivative.bytes
          ) {
            throw new JobProtocolError(422, 'derivative is missing or does not match the result');
          }
        }
        finish(job, 'done', undefined, { progress: 100, resultJson: completion.resultJson });
      });
    },

    fail(workerId, jobId, leaseToken, error) {
      store.transaction(() => {
        const job = assertHolder(workerId, jobId, leaseToken);
        if (error === 'canceled') {
          finish(job, 'cancelled', CANCELLED_BY_USER);
          return;
        }
        finish(job, 'failed', error.slice(0, MAX_ERROR_LENGTH));
      });
    },

    requestCancel(jobId) {
      return store.transaction((): CancelResult => {
        const job = store.get(jobId);
        if (job === undefined) return { ok: false, error: 'Unknown job id' };
        if (job.status === 'queued') {
          const cancelled: DispatchJob = {
            ...job,
            status: 'cancelled',
            error: CANCELLED_BY_USER,
            updatedAt: now(),
          };
          store.save(cancelled);
          return { ok: true, job: cancelled };
        }
        if (job.status === 'running') {
          const flagged: DispatchJob = { ...job, cancelRequested: true, updatedAt: now() };
          store.save(flagged);
          return { ok: true, job: flagged };
        }
        return { ok: false, error: `Cannot cancel a job in status "${job.status}"` };
      });
    },

    expireLeases() {
      return store.transaction(expireLeasesWithin);
    },

    get(jobId) {
      return store.get(jobId);
    },
  };
}
