import { DatabaseSync } from 'node:sqlite';

export type MediaKind = 'video' | 'audio' | 'image' | 'other';

export interface MediaManifestEntry {
  readonly refId: string;
  readonly checksum: string;
  readonly kind: MediaKind;
  readonly byteSize: number;
  readonly lastVerifiedAt: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly refId: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface LocalDatabaseOptions {
  readonly filePath: string;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

interface MediaRow {
  readonly ref_id: string;
  readonly checksum: string;
  readonly kind: string;
  readonly byte_size: number;
  readonly last_verified_at: string;
}

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly ref_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error: string | null;
}

/**
 * Desktop-only local runtime database: media manifest + Worker job queue, one SQLite file per
 * user profile. Kept separate from `@joy-media/project-persistence`'s `SqliteProjectStore` (a
 * second connection to the same file is safe under WAL for one process) so project persistence
 * stays a reusable, package-level contract while media/job bookkeeping stays a desktop-host-only
 * concern — it is never reachable from the renderer or from `apps/editor-web`'s browser bundle.
 */
export class LocalDatabase {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: LocalDatabaseOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.db = new DatabaseSync(options.filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS media_manifest (
         ref_id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         kind TEXT NOT NULL,
         byte_size INTEGER NOT NULL,
         last_verified_at TEXT NOT NULL
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         ref_id TEXT NOT NULL,
         status TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         error TEXT
       )`,
    );
  }

  recordMedia(entry: MediaManifestEntry): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO media_manifest (ref_id, checksum, kind, byte_size, last_verified_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(entry.refId, entry.checksum, entry.kind, entry.byteSize, entry.lastVerifiedAt);
  }

  getMedia(refId: string): MediaManifestEntry | undefined {
    const row = this.db.prepare('SELECT * FROM media_manifest WHERE ref_id = ?').get(refId) as
      MediaRow | undefined;
    return row === undefined ? undefined : mediaFromRow(row);
  }

  listMedia(): readonly MediaManifestEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM media_manifest ORDER BY ref_id ASC')
      .all() as unknown as readonly MediaRow[];
    return rows.map(mediaFromRow);
  }

  removeMedia(refId: string): void {
    this.db.prepare('DELETE FROM media_manifest WHERE ref_id = ?').run(refId);
  }

  enqueueJob(kind: string, refId: string): JobRecord {
    const id = this.idFactory();
    const timestamp = this.now();
    this.db
      .prepare(
        "INSERT INTO jobs (id, kind, ref_id, status, created_at, updated_at, error) VALUES (?, ?, ?, 'queued', ?, ?, NULL)",
      )
      .run(id, kind, refId, timestamp, timestamp);
    return { id, kind, refId, status: 'queued', createdAt: timestamp, updatedAt: timestamp };
  }

  updateJobStatus(id: string, status: JobStatus, error?: string): JobRecord | undefined {
    const timestamp = this.now();
    this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
      .run(status, timestamp, error ?? null, id);
    return this.getJob(id);
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row === undefined ? undefined : jobFromRow(row);
  }

  listJobs(): readonly JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at ASC')
      .all() as unknown as readonly JobRow[];
    return rows.map(jobFromRow);
  }

  /**
   * Call once at startup, before accepting new job submissions. Any job still `queued` or
   * `running` means the process exited without a clean shutdown — the Worker child that would
   * have run it is gone — so it is marked `cancelled` rather than silently resumed against a
   * Worker that no longer exists. This is the desktop host's crash-recovery contract for jobs.
   */
  recoverInterrupted(): readonly JobRecord[] {
    const interrupted = this.listJobs().filter(
      (job) => job.status === 'queued' || job.status === 'running',
    );
    return interrupted.map((job) => {
      const updated = this.updateJobStatus(job.id, 'cancelled', 'interrupted by shutdown');
      if (updated === undefined) throw new Error(`job ${job.id} disappeared during recovery`);
      return updated;
    });
  }

  /** Releases the SQLite file handle. Call during crash-safe shutdown, not before. */
  close(): void {
    this.db.close();
  }
}

function mediaFromRow(row: MediaRow): MediaManifestEntry {
  return {
    refId: row.ref_id,
    checksum: row.checksum,
    kind: row.kind as MediaKind,
    byteSize: row.byte_size,
    lastVerifiedAt: row.last_verified_at,
  };
}

function jobFromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    refId: row.ref_id,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error !== null ? { error: row.error } : {}),
  };
}
