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

/** Non-secret BYOK provider profile metadata. Field names mirror
 * `apps/editor-web/src/joy-agent/protocol.ts`'s `ByokSessionConfig` (`provider`, `baseUrl`,
 * `modelId`) so a future session handoff is a direct match, not a translation. The API key
 * itself never lives here — only `secretHandleId`, a pointer into the `secrets` table. */
export interface ProviderProfile {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly secretHandleId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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

interface ProviderProfileRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model_id: string;
  readonly secret_handle_id: string;
  readonly created_at: string;
  readonly updated_at: string;
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
    // Ciphertext only — encryption/decryption happens in main/secrets/electron-secret-store.ts
    // via Electron's `safeStorage` (OS-level DPAPI/Keychain/libsecret). This table never sees
    // a plaintext value.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS secrets (
         handle_id TEXT PRIMARY KEY,
         ciphertext_base64 TEXT NOT NULL
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS provider_profiles (
         id TEXT PRIMARY KEY,
         provider TEXT NOT NULL,
         base_url TEXT NOT NULL,
         model_id TEXT NOT NULL,
         secret_handle_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
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

  // ===== Encrypted secret ciphertext (see main/secrets/electron-secret-store.ts) =====

  setSecretCiphertext(handleId: string, ciphertextBase64: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO secrets (handle_id, ciphertext_base64) VALUES (?, ?)')
      .run(handleId, ciphertextBase64);
  }

  getSecretCiphertext(handleId: string): string | undefined {
    const row = this.db
      .prepare('SELECT ciphertext_base64 FROM secrets WHERE handle_id = ?')
      .get(handleId) as { readonly ciphertext_base64: string } | undefined;
    return row?.ciphertext_base64;
  }

  deleteSecretCiphertext(handleId: string): void {
    this.db.prepare('DELETE FROM secrets WHERE handle_id = ?').run(handleId);
  }

  // ===== BYOK provider profiles =====

  saveProviderProfile(profile: ProviderProfile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO provider_profiles
           (id, provider, base_url, model_id, secret_handle_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.provider,
        profile.baseUrl,
        profile.modelId,
        profile.secretHandleId,
        profile.createdAt,
        profile.updatedAt,
      );
  }

  getProviderProfile(id: string): ProviderProfile | undefined {
    const row = this.db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id) as
      ProviderProfileRow | undefined;
    return row === undefined ? undefined : providerProfileFromRow(row);
  }

  listProviderProfiles(): readonly ProviderProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_profiles ORDER BY created_at ASC')
      .all() as unknown as readonly ProviderProfileRow[];
    return rows.map(providerProfileFromRow);
  }

  deleteProviderProfile(id: string): void {
    this.db.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id);
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

function providerProfileFromRow(row: ProviderProfileRow): ProviderProfile {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    secretHandleId: row.secret_handle_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
