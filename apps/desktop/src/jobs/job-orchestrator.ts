import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  parseSpeechSynthesizeV1,
  parseSpeechSynthesisTiming,
  parseSpeechTranscribeV1,
} from '@joy-media/job-protocol';
import type { DerivativeReceipt, DispatchJob, JobDispatchStore } from './job-dispatch.js';

/** Worker leases last this long unless the Worker asks for less; each heartbeat renews it. */
export const DEFAULT_LEASE_MS = 30_000;
export const MAX_LEASE_MS = 120_000;
export const EXPIRED_LEASE_ERROR = 'worker lease expired';
export const CANCELLED_BY_USER = 'cancelled by user';
const MAX_ERROR_LENGTH = 240;
export const BUILTIN_SPEECH_OUTPUT_REF_ID = 'speech-output';

interface SpeechDerivativeCleanup {
  readonly jobId: string;
  readonly fileName: string;
}

const pendingSpeechDerivativeCleanup = new Map<string, SpeechDerivativeCleanup>();
const PENDING_CLEANUP_FILE = 'pending-cleanup.json';
let derivativeDirectory: string | undefined;
let warnCleanup: (message: string) => void = (message) => console.warn(message);
let pendingCleanupNeedsWrite = false;

type CleanupPathResult =
  | { readonly kind: 'safe'; readonly path: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'directory-missing' }
  | { readonly kind: 'unsafe' }
  | { readonly kind: 'transient' };

function isSpeechDerivativeFileName(jobId: string, fileName: string): boolean {
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedJobId}-[a-f0-9]{16}\\.(?:wav|json)$`).test(fileName);
}

let realpathForCleanup: typeof realpathSync = realpathSync;

function cleanupPath(fileName: string): CleanupPathResult {
  const configured = derivativeDirectory;
  if (configured === undefined || basename(fileName) !== fileName || fileName.includes('..'))
    return { kind: 'unsafe' };
  const target = join(configured, fileName);
  let realDirectory: string;
  try {
    realDirectory = realpathForCleanup(configured);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'directory-missing' };
    return { kind: 'transient' };
  }
  try {
    const realFile = realpathForCleanup(target);
    const inside = relative(realDirectory, realFile);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      return { kind: 'unsafe' };
    if (realpathForCleanup(dirname(target)) !== realDirectory || !lstatSync(target).isFile())
      return { kind: 'unsafe' };
    return { kind: 'safe', path: target };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing', path: target };
    return { kind: 'transient' };
  }
}

function writePendingCleanup(): void {
  if (derivativeDirectory === undefined) return;
  const path = join(derivativeDirectory, PENDING_CLEANUP_FILE);
  if (pendingSpeechDerivativeCleanup.size === 0) {
    rmSync(path, { force: true });
    pendingCleanupNeedsWrite = false;
    return;
  }
  const temporary = join(derivativeDirectory, `${PENDING_CLEANUP_FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify([...pendingSpeechDerivativeCleanup.values()]), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, path);
  pendingCleanupNeedsWrite = false;
}

function loadPendingCleanup(): void {
  if (derivativeDirectory === undefined) return;
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(derivativeDirectory, PENDING_CLEANUP_FILE), 'utf8'),
    );
    if (!Array.isArray(value)) {
      warnCleanup('Speech derivative cleanup record was refused');
      writePendingCleanup();
      return;
    }
    let discarded = false;
    for (const entry of value) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'jobId' in entry &&
        typeof entry.jobId === 'string' &&
        'fileName' in entry &&
        typeof entry.fileName === 'string' &&
        isSpeechDerivativeFileName(entry.jobId, entry.fileName)
      ) {
        pendingSpeechDerivativeCleanup.set(`${entry.jobId}\0${entry.fileName}`, {
          jobId: entry.jobId,
          fileName: entry.fileName,
        });
      } else {
        discarded = true;
      }
    }
    if (discarded) {
      warnCleanup('Speech derivative cleanup record was refused');
      writePendingCleanup();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT')
      warnCleanup('Speech derivative cleanup record could not be read');
  }
}

function retrySpeechDerivativeCleanup(): void {
  let changed = false;
  for (const [key, cleanup] of pendingSpeechDerivativeCleanup) {
    if (!isSpeechDerivativeFileName(cleanup.jobId, cleanup.fileName)) {
      pendingSpeechDerivativeCleanup.delete(key);
      changed = true;
      warnCleanup('Speech derivative cleanup record was refused');
      continue;
    }
    const checked = cleanupPath(cleanup.fileName);
    if (checked.kind === 'unsafe') {
      pendingSpeechDerivativeCleanup.delete(key);
      changed = true;
      warnCleanup('Speech derivative cleanup was refused');
      continue;
    }
    if (checked.kind === 'transient') {
      warnCleanup('Speech derivative cleanup check will be retried');
      continue;
    }
    if (checked.kind === 'directory-missing') {
      warnCleanup('Speech derivative cleanup check will be retried');
      continue;
    }
    if (checked.kind === 'missing') {
      pendingSpeechDerivativeCleanup.delete(key);
      changed = true;
      continue;
    }
    try {
      if (existsSync(checked.path)) removeSpeechDerivative(checked.path);
      lstatSync(checked.path);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        pendingSpeechDerivativeCleanup.delete(key);
        changed = true;
      } else warnCleanup('Speech derivative cleanup will be retried');
    }
  }
  if (changed) pendingCleanupNeedsWrite = true;
  if (changed || pendingCleanupNeedsWrite) {
    try {
      writePendingCleanup();
    } catch {
      warnCleanup('Speech derivative cleanup record could not be updated');
    }
  }
}

let removeSpeechDerivative: (path: string) => void = (path) => rmSync(path);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

process.on('beforeExit', retrySpeechDerivativeCleanup);
process.on('exit', retrySpeechDerivativeCleanup);

/** Protocol refusal that the loopback API maps onto an HTTP status. */
export class JobProtocolError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 413 | 422 | 502,
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
  'media.qc': { capability: 'media.qc', missing: 'FFmpeg and FFprobe on the local Worker' },
  'mask.image': { capability: 'mask.image', missing: 'local masking models for mask.image' },
  'mask.video': { capability: 'mask.video', missing: 'local masking models for mask.video' },
  'upscale.image': { capability: 'upscale.image', missing: 'the installed upscaling model' },
  'upscale.video': { capability: 'upscale.video', missing: 'the installed upscaling model' },
  'speech.transcribe': {
    capability: 'speech.transcribe',
    missing: 'the local speech transcription engine',
  },
  'speech.synthesize': {
    capability: 'speech.synthesize',
    missing: 'the local speech synthesis engine',
  },
};

/** Job types the desktop submits and the Worker can lease. */
const DISPATCHABLE_JOB_TYPES = [
  'asset.thumbnail',
  'render.export',
  'upscale.image',
  'media.qc',
  'mask.image',
  'mask.video',
  'speech.transcribe',
  'speech.synthesize',
] as const;
/** Job types whose Worker needs a payload. The desktop stores it at submit and sends it with the lease. */
const PAYLOAD_JOB_TYPES: ReadonlySet<string> = new Set([
  'render.export',
  'upscale.image',
  'media.qc',
  'mask.image',
  'mask.video',
  'speech.transcribe',
  'speech.synthesize',
]);
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
  if (!isPlainObject(payload)) {
    return { ok: false, message: `${jobType} needs a JSON object payload` };
  }
  // A plain object can still serialise to something else through a toJSON hook, so the encoded text is checked too.
  const json = JSON.stringify(payload);
  if (json === undefined || !isPlainObject(JSON.parse(json))) {
    return { ok: false, message: `${jobType} needs a JSON object payload` };
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, message: `${jobType} payload is larger than ${MAX_PAYLOAD_BYTES} bytes` };
  }
  if (jobType === 'speech.transcribe' && parseSpeechTranscribeV1(JSON.parse(json)) === undefined) {
    return { ok: false, message: 'speech.transcribe payload is invalid' };
  }
  if (jobType === 'speech.synthesize' && parseSpeechSynthesizeV1(JSON.parse(json)) === undefined) {
    return { ok: false, message: 'speech.synthesize payload is invalid' };
  }
  return { ok: true, json };
}

/** True for an object literal or a null-prototype object: not an array, a date, a class instance or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  /** Test seam for transient filesystem failures; production uses a non-recursive unlink. */
  readonly removeDerivativeFile?: (path: string) => void;
  /** Test seam for transient realpath failures. */
  readonly realpathSync?: typeof realpathSync;
}

export interface JobOrchestrator {
  /** Binds cleanup to the app-owned directory used by the loopback derivative receiver. */
  configureDerivativeCleanup(directory: string, onWarning?: (message: string) => void): void;
  /** Main-process callers only. A Worker can never name a profile (PLAN-v4 §6b). */
  submit(request: {
    readonly jobType: string;
    readonly refId: string;
    readonly kind: string;
    readonly payload?: unknown;
    readonly profileId?: string;
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
      readonly mimeType?: string;
      readonly speech?: unknown;
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
  realpathForCleanup = options.realpathSync ?? realpathSync;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const newLeaseToken = options.newLeaseToken ?? (() => randomBytes(32).toString('base64url'));
  const leaseCap = Math.min(options.maxLeaseMs ?? MAX_LEASE_MS, MAX_LEASE_MS);
  removeSpeechDerivative = options.removeDerivativeFile ?? ((path) => rmSync(path));

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
      const patch = job.jobType.startsWith('speech.') ? { derivative: undefined } : {};
      if (job.cancelRequested) finish(job, 'cancelled', CANCELLED_BY_USER, patch);
      else finish(job, 'failed', EXPIRED_LEASE_ERROR, patch);
    }
    return expired.length;
  }

  function finish(
    job: DispatchJob,
    status: 'done' | 'failed' | 'cancelled',
    error: string | undefined,
    patch: Partial<DispatchJob> = {},
  ): void {
    if (job.jobType.startsWith('speech.') && status !== 'done' && job.derivative !== undefined) {
      const rawPath = job.derivative.path;
      const fileName = basename(resolve(rawPath));
      const candidateIsSafe =
        derivativeDirectory !== undefined &&
        isAbsolute(rawPath) &&
        !rawPath.split(/[\\/]/).includes('..') &&
        isSpeechDerivativeFileName(job.id, fileName) &&
        resolve(dirname(rawPath)) === derivativeDirectory;
      const checked = candidateIsSafe ? cleanupPath(fileName) : { kind: 'unsafe' as const };
      if (candidateIsSafe && checked.kind !== 'unsafe' && checked.kind !== 'missing') {
        const key = `${job.id}\0${fileName}`;
        pendingSpeechDerivativeCleanup.set(key, {
          jobId: job.id,
          fileName,
        });
        pendingCleanupNeedsWrite = true;
        try {
          writePendingCleanup();
        } catch {
          warnCleanup('Speech derivative cleanup record could not be saved');
        }
        retrySpeechDerivativeCleanup();
      } else {
        warnCleanup('Speech derivative cleanup was refused');
      }
    }
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
    configureDerivativeCleanup(directory, onWarning) {
      derivativeDirectory = resolve(directory);
      warnCleanup = onWarning ?? ((message) => console.warn(message));
      pendingSpeechDerivativeCleanup.clear();
      mkdirSync(derivativeDirectory, { recursive: true });
      loadPendingCleanup();
      retrySpeechDerivativeCleanup();
    },
    submit({ jobType, refId, kind, payload, profileId }) {
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
      if (jobType === 'speech.transcribe' || jobType === 'speech.synthesize') {
        const speechPayload = JSON.parse(payloadResult.json ?? '{}') as Record<string, unknown>;
        const engineFlag = `speech.model.${String(speechPayload.modelId)}`;
        // Only synthesis engines carry a per-model worker flag. The worker advertises speech.transcribe after it
        // verified Whisper, and the dispatch requirement for the job type checks that capability.
        if (jobType === 'speech.synthesize' && !presence?.capabilities.includes(engineFlag)) {
          return {
            ok: false,
            code: 'SETUP_REQUIRED',
            jobType,
            message: `Worker has not reported ${engineFlag} as ready`,
          };
        }
        if (
          jobType === 'speech.transcribe' &&
          (!refId.trim() || refId === BUILTIN_SPEECH_OUTPUT_REF_ID)
        ) {
          return {
            ok: false,
            code: 'PAYLOAD_INVALID',
            jobType,
            message: 'speech.transcribe needs an audio source',
          };
        }
        if (jobType === 'speech.synthesize' && !refId.trim()) {
          return {
            ok: false,
            code: 'PAYLOAD_INVALID',
            jobType,
            message: 'speech.synthesize needs an output or reference asset',
          };
        }
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
        ...(profileId === undefined ? {} : { profileId }),
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
          // A long export moves large files through this process, and that can delay the next
          // heartbeat well past 30 s. Each heartbeat renews the lease for the longest allowed window.
          leaseExpiresAt: leaseExpiry(MAX_LEASE_MS),
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
        if (job.jobType.startsWith('speech.') && job.cancelRequested)
          throw new JobProtocolError(409, 'the speech job was cancelled');
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
        if (job.jobType === 'speech.transcribe' || job.jobType === 'speech.synthesize') {
          if (job.cancelRequested) throw new JobProtocolError(409, 'the speech job was cancelled');
          const derivative = job.derivative;
          const expectedMime =
            job.jobType === 'speech.transcribe' ? 'application/json' : 'audio/wav';
          if (
            completion.kind !== job.jobType ||
            derivative === undefined ||
            completion.sha256 !== derivative.sha256 ||
            completion.bytes !== derivative.bytes ||
            completion.mimeType !== expectedMime ||
            derivative.mimeType !== expectedMime
          ) {
            throw new JobProtocolError(
              422,
              'speech derivative is missing or does not match the result',
            );
          }
          if (job.jobType === 'speech.synthesize') {
            if (parseSpeechSynthesisTiming(completion.speech) === undefined)
              throw new JobProtocolError(422, 'speech synthesis timing is invalid');
          } else if (completion.speech !== undefined) {
            throw new JobProtocolError(
              422,
              'transcription results cannot include synthesis timing',
            );
          }
        }
        finish(job, 'done', undefined, { progress: 100, resultJson: completion.resultJson });
      });
    },

    fail(workerId, jobId, leaseToken, error) {
      store.transaction(() => {
        const job = assertHolder(workerId, jobId, leaseToken);
        if (job.cancelRequested || error === 'canceled') {
          finish(
            job,
            'cancelled',
            CANCELLED_BY_USER,
            job.jobType.startsWith('speech.') ? { derivative: undefined } : {},
          );
          return;
        }
        finish(
          job,
          'failed',
          error.slice(0, MAX_ERROR_LENGTH),
          job.jobType.startsWith('speech.') ? { derivative: undefined } : {},
        );
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
            ...(job.jobType.startsWith('speech.') ? { derivative: undefined } : {}),
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
      const expiredCount = store.transaction(expireLeasesWithin);
      retrySpeechDerivativeCleanup();
      return expiredCount;
    },

    get(jobId) {
      return store.get(jobId);
    },
  };
}
