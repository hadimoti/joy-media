export interface Actor {
  readonly id: string;
}
export interface ProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
}
export interface WorkerRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: number;
}
export interface WorkerPairingOffer {
  readonly workerId: string;
  readonly expiresAt: number;
}
export interface WorkerSession {
  readonly workerId: string;
  readonly expiresAt: number;
}
export interface Job {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly progress: number;
  readonly cancelRequested: boolean;
  readonly result?: JobResult;
  readonly error?: string;
}
export interface JobResult {
  /** A receipt only: local paths and media bytes never leave the Worker. */
  readonly kind: 'fixture.thumbnail';
  readonly sha256: string;
  readonly bytes: number;
}
const FIXTURE_THUMBNAIL_SHA256 = '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735';
const FIXTURE_THUMBNAIL_BYTES = 14;
export interface JobEvent {
  readonly cursor: number;
  readonly jobId: string;
  readonly type: string;
  readonly at: number;
}

/** The API transport can use the synchronous local spike or durable PostgreSQL. */
export interface ControlPlane {
  createProject(
    actor: Actor,
    id: string,
    title: string,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  updateProject(
    actor: Actor,
    id: string,
    title: string,
    baseRevision: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  pairWorker(actor: Actor, workerId: string): WorkerRecord | Promise<WorkerRecord>;
  createPairingOffer(
    workerId: string,
    pairingCodeHash: string,
    expiresAt: number,
  ): WorkerPairingOffer | Promise<WorkerPairingOffer>;
  approvePairing(
    actor: Actor,
    workerId: string,
    pairingCodeHash: string,
    now?: number,
  ): WorkerRecord | Promise<WorkerRecord>;
  claimWorkerSession(
    workerId: string,
    pairingCodeHash: string,
    sessionTokenHash: string,
    expiresAt: number,
    now?: number,
  ): WorkerSession | Promise<WorkerSession | undefined> | undefined;
  authenticateWorker(
    sessionTokenHash: string,
    now?: number,
  ): string | Promise<string | undefined> | undefined;
  helloWorker(
    workerId: string,
    capabilities: readonly string[],
    now?: number,
  ): WorkerRecord | Promise<WorkerRecord>;
  revokeWorker(actor: Actor, workerId: string): WorkerRecord | Promise<WorkerRecord>;
  enqueue(
    actor: Actor,
    id: string,
    projectId: string,
    type: string,
    now?: number,
  ): Job | Promise<Job>;
  lease(
    workerId: string,
    now?: number,
    durationMs?: number,
  ): Job | Promise<Job | undefined> | undefined;
  heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now?: number,
    durationMs?: number,
  ):
    | { readonly job: Job; readonly cancelRequested: boolean }
    | Promise<{
        readonly job: Job;
        readonly cancelRequested: boolean;
      }>;
  complete(workerId: string, jobId: string, now?: number, result?: JobResult): Job | Promise<Job>;
  fail(workerId: string, jobId: string, error: string, now?: number): Job | Promise<Job>;
  cancel(actor: Actor, projectId: string, jobId: string, now?: number): Job | Promise<Job>;
  retry(actor: Actor, projectId: string, jobId: string, now?: number): Job | Promise<Job>;
  jobsForProject(actor: Actor, projectId: string): readonly Job[] | Promise<readonly Job[]>;
  workersForOwner(
    actor: Actor,
    now?: number,
  ): readonly WorkerRecord[] | Promise<readonly WorkerRecord[]>;
  eventsAfter(
    actor: Actor,
    projectId: string,
    cursor: number,
  ): readonly JobEvent[] | Promise<readonly JobEvent[]>;
}
export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/** In-memory adapter with the same revision/lease semantics as the PostgreSQL implementation. */
export class LocalControlPlane implements ControlPlane {
  readonly #projects = new Map<string, ProjectMetadata>();
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #jobs = new Map<string, Job>();
  readonly #events: JobEvent[] = [];
  readonly #pairingOffers = new Map<
    string,
    { readonly pairingCodeHash: string; readonly expiresAt: number; ownerId?: string }
  >();
  readonly #workerSessions = new Map<
    string,
    { readonly workerId: string; readonly expiresAt: number }
  >();
  createProject(actor: Actor, id: string, title: string): ProjectMetadata {
    this.auth(actor);
    if (this.#projects.has(id)) throw new ControlPlaneError('PROJECT_EXISTS', id);
    const result = { id, title, revision: 0, ownerId: actor.id };
    this.#projects.set(id, result);
    return result;
  }
  updateProject(actor: Actor, id: string, title: string, baseRevision: number): ProjectMetadata {
    const current = this.project(actor, id);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    const next = { ...current, title, revision: current.revision + 1 };
    this.#projects.set(id, next);
    return next;
  }
  pairWorker(actor: Actor, workerId: string): WorkerRecord {
    this.auth(actor);
    const worker = {
      id: workerId,
      ownerId: actor.id,
      paired: true,
      revoked: false,
      capabilities: [],
    };
    this.#workers.set(workerId, worker);
    return worker;
  }
  createPairingOffer(
    workerId: string,
    pairingCodeHash: string,
    expiresAt: number,
  ): WorkerPairingOffer {
    if (workerId.length === 0 || pairingCodeHash.length === 0 || expiresAt <= 0)
      throw new ControlPlaneError('PAIRING_OFFER_INVALID', 'worker pairing offer is invalid');
    this.#pairingOffers.set(workerId, { pairingCodeHash, expiresAt });
    return { workerId, expiresAt };
  }
  approvePairing(
    actor: Actor,
    workerId: string,
    pairingCodeHash: string,
    now = Date.now(),
  ): WorkerRecord {
    this.auth(actor);
    const offer = this.#pairingOffers.get(workerId);
    if (offer === undefined || offer.expiresAt <= now || offer.pairingCodeHash !== pairingCodeHash)
      throw new ControlPlaneError('PAIRING_CODE_INVALID', workerId);
    this.#pairingOffers.set(workerId, { ...offer, ownerId: actor.id });
    return { id: workerId, ownerId: actor.id, paired: false, revoked: false, capabilities: [] };
  }
  claimWorkerSession(
    workerId: string,
    pairingCodeHash: string,
    sessionTokenHash: string,
    expiresAt: number,
    now = Date.now(),
  ): WorkerSession | undefined {
    const offer = this.#pairingOffers.get(workerId);
    if (
      offer === undefined ||
      offer.ownerId === undefined ||
      offer.expiresAt <= now ||
      offer.pairingCodeHash !== pairingCodeHash
    )
      return undefined;
    this.#pairingOffers.delete(workerId);
    this.#workers.set(workerId, {
      id: workerId,
      ownerId: offer.ownerId,
      paired: true,
      revoked: false,
      capabilities: [],
    });
    this.#workerSessions.set(sessionTokenHash, { workerId, expiresAt });
    return { workerId, expiresAt };
  }
  authenticateWorker(sessionTokenHash: string, now = Date.now()): string | undefined {
    const session = this.#workerSessions.get(sessionTokenHash);
    if (session === undefined || session.expiresAt <= now) return undefined;
    const worker = this.#workers.get(session.workerId);
    return worker === undefined || worker.revoked ? undefined : worker.id;
  }
  helloWorker(workerId: string, capabilities: readonly string[], now = Date.now()): WorkerRecord {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.revoked)
      throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    const next = { ...worker, capabilities: [...new Set(capabilities)].sort(), lastSeenAt: now };
    this.#workers.set(workerId, next);
    return next;
  }
  revokeWorker(actor: Actor, workerId: string): WorkerRecord {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.ownerId !== actor.id)
      throw new ControlPlaneError('WORKER_NOT_FOUND', workerId);
    const revoked = { ...worker, revoked: true };
    this.#workers.set(workerId, revoked);
    return revoked;
  }
  enqueue(actor: Actor, id: string, projectId: string, type: string, now = Date.now()): Job {
    this.project(actor, projectId);
    const job: Job = { id, projectId, type, state: 'queued', progress: 0, cancelRequested: false };
    this.#jobs.set(id, job);
    this.event(id, 'queued', now);
    return job;
  }
  lease(workerId: string, now = Date.now(), durationMs = 30_000): Job | undefined {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.revoked || !worker.paired)
      throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    const job = [...this.#jobs.values()].find(
      (item) =>
        item.state === 'queued' ||
        (item.state === 'leased' &&
          item.leaseExpiresAt !== undefined &&
          item.leaseExpiresAt <= now),
    );
    if (job === undefined) return undefined;
    const leased: Job = {
      ...job,
      state: 'leased',
      leaseOwner: workerId,
      leaseExpiresAt: now + durationMs,
    };
    this.#jobs.set(job.id, leased);
    this.event(job.id, 'leased', now);
    return leased;
  }
  heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now = Date.now(),
    durationMs = 30_000,
  ): { readonly job: Job; readonly cancelRequested: boolean } {
    const job = this.ownedLease(workerId, jobId, now);
    if (!Number.isSafeInteger(progress) || progress < job.progress || progress > 100)
      throw new ControlPlaneError('PROGRESS_INVALID', jobId);
    const updated = { ...job, progress, leaseExpiresAt: now + durationMs };
    this.#jobs.set(jobId, updated);
    const worker = this.#workers.get(workerId);
    if (worker !== undefined) this.#workers.set(workerId, { ...worker, lastSeenAt: now });
    this.event(jobId, `progress:${progress}`, now);
    return { job: updated, cancelRequested: updated.cancelRequested };
  }
  complete(workerId: string, jobId: string, now = Date.now(), result?: JobResult): Job {
    const job = this.ownedLease(workerId, jobId, now);
    if (job.type === 'fixture.thumbnail' && !isFixtureReceipt(result))
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    const done: Job = {
      ...job,
      state: 'completed',
      progress: 100,
      cancelRequested: false,
      ...(result === undefined ? {} : { result }),
    };
    this.#jobs.set(jobId, done);
    this.event(jobId, 'completed', now);
    return done;
  }
  fail(workerId: string, jobId: string, error: string, now = Date.now()): Job {
    const job = this.ownedLease(workerId, jobId, now);
    const canceled = error === 'canceled';
    const failed = {
      ...job,
      state: canceled ? ('canceled' as const) : ('failed' as const),
      ...(canceled ? {} : { error: error.slice(0, 500) }),
      cancelRequested: false,
    };
    this.#jobs.set(jobId, failed);
    this.event(jobId, canceled ? 'canceled' : 'failed', now);
    return failed;
  }
  cancel(actor: Actor, projectId: string, jobId: string, now = Date.now()): Job {
    this.project(actor, projectId);
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.projectId !== projectId)
      throw new ControlPlaneError('JOB_NOT_FOUND', jobId);
    if (job.state === 'queued') {
      const canceled = { ...job, state: 'canceled' as const };
      this.#jobs.set(jobId, canceled);
      this.event(jobId, 'canceled', now);
      return canceled;
    }
    if (job.state !== 'leased') throw new ControlPlaneError('JOB_NOT_CANCELABLE', jobId);
    const requested = { ...job, cancelRequested: true };
    this.#jobs.set(jobId, requested);
    this.event(jobId, 'cancel-requested', now);
    return requested;
  }
  retry(actor: Actor, projectId: string, jobId: string, now = Date.now()): Job {
    this.project(actor, projectId);
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.projectId !== projectId)
      throw new ControlPlaneError('JOB_NOT_FOUND', jobId);
    if (job.state === 'leased' || job.state === 'queued')
      throw new ControlPlaneError('JOB_NOT_RETRYABLE', jobId);
    const {
      error: _error,
      result: _result,
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      ...rest
    } = job;
    const retried: Job = { ...rest, state: 'queued', progress: 0, cancelRequested: false };
    this.#jobs.set(jobId, retried);
    this.event(jobId, 'retried', now);
    return retried;
  }
  jobsForProject(actor: Actor, projectId: string): readonly Job[] {
    this.project(actor, projectId);
    return [...this.#jobs.values()].filter((job) => job.projectId === projectId);
  }
  workersForOwner(actor: Actor): readonly WorkerRecord[] {
    this.auth(actor);
    return [...this.#workers.values()].filter((worker) => worker.ownerId === actor.id);
  }
  eventsAfter(actor: Actor, projectId: string, cursor: number): readonly JobEvent[] {
    this.project(actor, projectId);
    const ids = new Set(
      [...this.#jobs.values()].filter((job) => job.projectId === projectId).map((job) => job.id),
    );
    return this.#events.filter((event) => event.cursor > cursor && ids.has(event.jobId));
  }
  private project(actor: Actor, id: string): ProjectMetadata {
    this.auth(actor);
    const project = this.#projects.get(id);
    if (project === undefined || project.ownerId !== actor.id)
      throw new ControlPlaneError('PROJECT_NOT_FOUND', id);
    return project;
  }
  private ownedLease(workerId: string, jobId: string, now: number): Job {
    const job = this.#jobs.get(jobId);
    if (
      job === undefined ||
      job.state !== 'leased' ||
      job.leaseOwner !== workerId ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= now
    )
      throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
    return job;
  }
  private auth(actor: Actor): void {
    if (actor.id.length === 0)
      throw new ControlPlaneError('AUTH_REQUIRED', 'actor identity required');
  }
  private event(jobId: string, type: string, at: number): void {
    this.#events.push({ cursor: this.#events.length + 1, jobId, type, at });
  }
}

function isFixtureReceipt(value: JobResult | undefined): value is JobResult {
  return (
    value?.kind === 'fixture.thumbnail' &&
    value.sha256 === FIXTURE_THUMBNAIL_SHA256 &&
    value.bytes === FIXTURE_THUMBNAIL_BYTES
  );
}
