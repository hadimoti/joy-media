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
}
export interface Job {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly state: 'queued' | 'leased' | 'completed';
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
}
export interface JobEvent {
  readonly cursor: number;
  readonly jobId: string;
  readonly type: string;
  readonly at: number;
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
export class LocalControlPlane {
  readonly #projects = new Map<string, ProjectMetadata>();
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #jobs = new Map<string, Job>();
  readonly #events: JobEvent[] = [];
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
    const worker = { id: workerId, ownerId: actor.id, paired: true, revoked: false };
    this.#workers.set(workerId, worker);
    return worker;
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
    const job: Job = { id, projectId, type, state: 'queued' };
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
  complete(workerId: string, jobId: string, now = Date.now()): Job {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.leaseOwner !== workerId)
      throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
    const done: Job = { ...job, state: 'completed' };
    this.#jobs.set(jobId, done);
    this.event(jobId, 'completed', now);
    return done;
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
  private auth(actor: Actor): void {
    if (actor.id.length === 0)
      throw new ControlPlaneError('AUTH_REQUIRED', 'actor identity required');
  }
  private event(jobId: string, type: string, at: number): void {
    this.#events.push({ cursor: this.#events.length + 1, jobId, type, at });
  }
}
