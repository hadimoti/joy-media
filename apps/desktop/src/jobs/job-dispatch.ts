import type { DatabaseSync } from 'node:sqlite';
import type { JobStatus } from '../store/local-database.js';

/** Worker-produced derivative, already written to the desktop's own derivative directory. */
export interface DerivativeReceipt {
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly path: string;
}

/** Full dispatch state for one job. `leaseToken` and `path` never leave the main process. */
export interface DispatchJob {
  readonly id: string;
  readonly kind: string;
  readonly jobType: string;
  readonly refId: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | undefined;
  readonly progress: number;
  readonly attempts: number;
  readonly workerId: string | undefined;
  readonly leaseToken: string | undefined;
  readonly leaseExpiresAt: string | undefined;
  readonly cancelRequested: boolean;
  readonly derivative: DerivativeReceipt | undefined;
  readonly resultJson: string | undefined;
  /** The payload a Worker needs for render.export or upscale.image, stored as JSON at submit and sent with the lease. */
  readonly payloadJson?: string | undefined;
}

export interface WorkerPresence {
  readonly workerId: string;
  readonly capabilities: readonly string[];
  readonly lastHelloAt: string;
}

/**
 * Port the job orchestrator depends on. SQLite is the only adapter today; the orchestrator
 * never imports a database type, so another backend can implement this same port.
 */
export interface JobDispatchStore {
  transaction<T>(work: () => T): T;
  insert(job: DispatchJob): void;
  get(id: string): DispatchJob | undefined;
  /** Writes the full mutable state of an existing job. `id`, `kind`, `refId` and `createdAt` are fixed at insert. */
  save(job: DispatchJob): void;
  nextQueued(jobTypes: readonly string[]): DispatchJob | undefined;
  expiredRunning(now: string): readonly DispatchJob[];
  presence(): WorkerPresence | undefined;
  savePresence(presence: WorkerPresence): void;
}

interface DispatchRow {
  readonly id: string;
  readonly kind: string;
  readonly ref_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error: string | null;
  readonly job_type: string;
  readonly progress: number;
  readonly attempts: number;
  readonly worker_id: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
  readonly cancel_requested: number;
  readonly derivative_sha256: string | null;
  readonly derivative_bytes: number | null;
  readonly derivative_mime: string | null;
  readonly derivative_path: string | null;
  readonly result_json: string | null;
  readonly payload_json: string | null;
}

const SELECT_DISPATCH = `SELECT j.id, j.kind, j.ref_id, j.status, j.created_at, j.updated_at, j.error,
  d.job_type, d.progress, d.attempts, d.worker_id, d.lease_token, d.lease_expires_at,
  d.cancel_requested, d.derivative_sha256, d.derivative_bytes, d.derivative_mime,
  d.derivative_path, d.result_json, d.payload_json
FROM jobs j JOIN job_dispatch d ON d.job_id = j.id`;

/**
 * SQLite adapter. The `jobs` table keeps the status every existing caller reads; `job_dispatch`
 * holds the lease, progress and derivative state that only the Worker route needs. Both are
 * written in one transaction, so a crash never leaves a status without its lease.
 */
export class SqliteJobDispatchStore implements JobDispatchStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS job_dispatch (
         job_id TEXT PRIMARY KEY,
         job_type TEXT NOT NULL,
         progress INTEGER NOT NULL DEFAULT 0,
         attempts INTEGER NOT NULL DEFAULT 0,
         worker_id TEXT,
         lease_token TEXT,
         lease_expires_at TEXT,
         cancel_requested INTEGER NOT NULL DEFAULT 0,
         derivative_sha256 TEXT,
         derivative_bytes INTEGER,
         derivative_mime TEXT,
         derivative_path TEXT,
         result_json TEXT,
         payload_json TEXT
       )`,
    );
    addColumnIfMissing(db, 'job_dispatch', 'payload_json', 'TEXT');
    db.exec(
      `CREATE TABLE IF NOT EXISTS worker_presence (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         worker_id TEXT NOT NULL,
         capabilities_json TEXT NOT NULL,
         last_hello_at TEXT NOT NULL
       )`,
    );
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insert(job: DispatchJob): void {
    this.db
      .prepare(
        "INSERT INTO jobs (id, kind, ref_id, status, created_at, updated_at, error) VALUES (?, ?, ?, 'queued', ?, ?, NULL)",
      )
      .run(job.id, job.kind, job.refId, job.createdAt, job.createdAt);
    this.db
      .prepare('INSERT INTO job_dispatch (job_id, job_type, payload_json) VALUES (?, ?, ?)')
      .run(job.id, job.jobType, job.payloadJson ?? null);
    this.save({ ...job, status: 'queued', error: undefined });
  }

  get(id: string): DispatchJob | undefined {
    const row = this.db.prepare(`${SELECT_DISPATCH} WHERE j.id = ?`).get(id) as
      DispatchRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  save(job: DispatchJob): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
      .run(job.status, job.updatedAt, job.error ?? null, job.id);
    this.db
      .prepare(
        `UPDATE job_dispatch SET job_type = ?, progress = ?, attempts = ?, worker_id = ?,
           lease_token = ?, lease_expires_at = ?, cancel_requested = ?,
           derivative_sha256 = ?, derivative_bytes = ?, derivative_mime = ?,
           derivative_path = ?, result_json = ?
         WHERE job_id = ?`,
      )
      .run(
        job.jobType,
        job.progress,
        job.attempts,
        job.workerId ?? null,
        job.leaseToken ?? null,
        job.leaseExpiresAt ?? null,
        job.cancelRequested ? 1 : 0,
        job.derivative?.sha256 ?? null,
        job.derivative?.bytes ?? null,
        job.derivative?.mimeType ?? null,
        job.derivative?.path ?? null,
        job.resultJson ?? null,
        job.id,
      );
  }

  nextQueued(jobTypes: readonly string[]): DispatchJob | undefined {
    if (jobTypes.length === 0) return undefined;
    const placeholders = jobTypes.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT j.id FROM jobs j JOIN job_dispatch d ON d.job_id = j.id
         WHERE j.status = 'queued' AND d.job_type IN (${placeholders})
         ORDER BY j.created_at ASC, j.id ASC LIMIT 1`,
      )
      .get(...jobTypes) as { readonly id: string } | undefined;
    return row === undefined ? undefined : this.get(row.id);
  }

  expiredRunning(now: string): readonly DispatchJob[] {
    const rows = this.db
      .prepare(
        `SELECT j.id FROM jobs j JOIN job_dispatch d ON d.job_id = j.id
         WHERE j.status = 'running' AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at < ?`,
      )
      .all(now) as unknown as readonly { readonly id: string }[];
    return rows.flatMap((row) => {
      const job = this.get(row.id);
      return job === undefined ? [] : [job];
    });
  }

  presence(): WorkerPresence | undefined {
    const row = this.db
      .prepare(
        'SELECT worker_id, capabilities_json, last_hello_at FROM worker_presence WHERE singleton = 1',
      )
      .get() as
      | {
          readonly worker_id: string;
          readonly capabilities_json: string;
          readonly last_hello_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      workerId: row.worker_id,
      capabilities: JSON.parse(row.capabilities_json) as string[],
      lastHelloAt: row.last_hello_at,
    };
  }

  savePresence(presence: WorkerPresence): void {
    this.db
      .prepare(
        `INSERT INTO worker_presence (singleton, worker_id, capabilities_json, last_hello_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           worker_id = excluded.worker_id,
           capabilities_json = excluded.capabilities_json,
           last_hello_at = excluded.last_hello_at`,
      )
      .run(presence.workerId, JSON.stringify(presence.capabilities), presence.lastHelloAt);
  }
}

function fromRow(row: DispatchRow): DispatchJob {
  return {
    id: row.id,
    kind: row.kind,
    jobType: row.job_type,
    refId: row.ref_id,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    progress: row.progress,
    attempts: row.attempts,
    workerId: row.worker_id ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    cancelRequested: row.cancel_requested === 1,
    derivative:
      row.derivative_sha256 === null ||
      row.derivative_bytes === null ||
      row.derivative_mime === null ||
      row.derivative_path === null
        ? undefined
        : {
            sha256: row.derivative_sha256,
            bytes: row.derivative_bytes,
            mimeType: row.derivative_mime,
            path: row.derivative_path,
          },
    resultJson: row.result_json ?? undefined,
    payloadJson: row.payload_json ?? undefined,
  };
}

/** Adds a column that an earlier build's table lacks. Rows already in the table keep their values. */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
    readonly name: string;
  }[];
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
