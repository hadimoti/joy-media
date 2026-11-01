import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteJobDispatchStore } from '../jobs/job-dispatch.js';
import { ensureLocalAssetSchema, SqliteLocalAssetStore } from './local-assets.js';
import { ensureProjectDocumentSchema, SqliteProjectDocumentStore } from './project-documents.js';
import { PROFILE_BINDING_TABLE_SQL, secretVersionDigest } from './profile-binding.js';
import {
  clearCredentialUnavailable,
  forgetProfileState,
  listProfileStates,
  markCredentialUnavailable,
  reconcileLegacyProfiles,
  recordLaterDecision,
  runMigrations,
  type MigrationOptions,
  type ProfileStateRecord,
} from './migrations.js';

export interface AssetLibraryInfo {
  readonly directory: string;
  readonly exists: boolean;
  readonly hasCatalog: boolean;
  readonly isDefault: boolean;
  readonly counts: {
    readonly total: number;
    readonly audio: number;
    readonly image: number;
  };
}

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
  readonly name?: string | undefined;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[] | undefined;
  readonly secretHandleId: string;
  /** Digest of (profile id, origin, base path) taken when the profile was saved (PLAN-v4 §6c). */
  readonly bindingDigest?: string | undefined;
  /** The version of the stored key when the binding was made. A different key no longer matches. */
  readonly bindingSecretDigest?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalDatabaseOptions {
  readonly filePath: string;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  /** Test hook for the migration steps (see store/migrations.ts). */
  readonly migration?: Pick<MigrationOptions, 'afterStepRow'>;
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
  readonly binding_digest?: string | null;
  readonly binding_secret_digest?: string | null;
  readonly name?: string | null;
  readonly provider: string;
  readonly base_url: string;
  readonly model_id: string;
  readonly cached_models?: string | null;
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
  /** Dispatch and Worker presence for the local job API (jobs/job-dispatch.ts). */
  readonly jobDispatch: SqliteJobDispatchStore;
  /** The project document the editor saves locally (store/project-documents.ts). */
  readonly projectDocuments: SqliteProjectDocumentStore;
  /** Assets registered for a local render, and where their originals are stored. */
  readonly localAssets: SqliteLocalAssetStore;

  constructor(options: LocalDatabaseOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.db = new DatabaseSync(options.filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.jobDispatch = new SqliteJobDispatchStore(this.db);
    ensureProjectDocumentSchema(this.db);
    ensureLocalAssetSchema(this.db);
    this.projectDocuments = new SqliteProjectDocumentStore(this.db, this.now);
    this.localAssets = new SqliteLocalAssetStore(this.db, this.now);
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
         name TEXT,
         provider TEXT NOT NULL,
         base_url TEXT NOT NULL,
         model_id TEXT NOT NULL,
         cached_models TEXT,
         secret_handle_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    try {
      this.db.exec('ALTER TABLE provider_profiles ADD COLUMN name TEXT;');
    } catch {
      // Column already exists
    }
    try {
      this.db.exec('ALTER TABLE provider_profiles ADD COLUMN cached_models TEXT;');
    } catch {
      // Column already exists
    }
    // Additive (PLAN-v4 §9c): the v1.0.x provider_profiles table is never altered. The endpoint
    // binding (§6c item 6) lives beside it, keyed by profile id.
    this.db.exec(PROFILE_BINDING_TABLE_SQL);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    // Additive v1.1.0 migrations (see store/migrations.ts). Each step is transactional.
    runMigrations(this.db, { now: this.now, ...(options.migration ?? {}) });
    // A key whose save never reached its profile row belongs to no profile. Nothing is saving while
    // the database opens, so those rows can go now (PLAN-v4 §6c).
    this.db
      .prepare(
        'DELETE FROM secrets WHERE handle_id NOT IN (SELECT secret_handle_id FROM provider_profiles)',
      )
      .run();
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

  /** The version of the stored key: the digest of its ciphertext (see secretVersionDigest). */
  secretVersion(handleId: string): string {
    return secretVersionDigest(this.getSecretCiphertext(handleId));
  }

  // ===== BYOK provider profiles =====

  /**
   * Writes the profile row and its binding in one transaction. If either write fails, both are rolled
   * back, so the stored profile still points at the key it had and that key is not removed.
   */
  saveProviderProfile(profile: ProviderProfile): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writeProviderProfile(profile);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private writeProviderProfile(profile: ProviderProfile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO provider_profiles
           (id, name, provider, base_url, model_id, cached_models, secret_handle_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name ?? null,
        profile.provider,
        profile.baseUrl,
        profile.modelId,
        profile.cachedModels ? JSON.stringify(profile.cachedModels) : null,
        profile.secretHandleId,
        profile.createdAt,
        profile.updatedAt,
      );
    if (profile.bindingDigest === undefined || profile.bindingSecretDigest === undefined) {
      this.db.prepare('DELETE FROM profile_binding WHERE profile_id = ?').run(profile.id);
    } else {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO profile_binding (profile_id, binding_digest, secret_digest, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(profile.id, profile.bindingDigest, profile.bindingSecretDigest, this.now());
    }
  }

  getProviderProfile(id: string): ProviderProfile | undefined {
    const row = this.db.prepare(PROFILE_SELECT + ' WHERE p.id = ?').get(id) as
      ProviderProfileRow | undefined;
    return row === undefined ? undefined : providerProfileFromRow(row);
  }

  listProviderProfiles(): readonly ProviderProfile[] {
    const rows = this.db
      .prepare(PROFILE_SELECT + ' ORDER BY p.created_at ASC')
      .all() as unknown as readonly ProviderProfileRow[];
    return rows.map(providerProfileFromRow);
  }

  deleteProviderProfile(id: string): void {
    this.db.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM profile_binding WHERE profile_id = ?').run(id);
    forgetProfileState(this.db, id);
  }

  /** Every recorded profile state. A profile without a row is `active`. */
  listProfileStates(): readonly ProfileStateRecord[] {
    return listProfileStates(this.db);
  }

  /** Marks legacy profiles that have no state yet. Runs on every start; safe to repeat. */
  markLegacyProfiles(): readonly string[] {
    return reconcileLegacyProfiles(this.db, { now: this.now });
  }

  /** "Later" on a legacy profile: it stays disabled, and the choice survives restarts. */
  recordProfileLater(profileId: string): void {
    recordLaterDecision(this.db, profileId, this.now());
  }

  /** The secret store could not return this profile's key. The profile is kept, not deleted. */
  markProfileCredentialUnavailable(profileId: string): void {
    markCredentialUnavailable(this.db, profileId, this.now());
  }

  /** Clears the credential mark once the key reads again, or the profile is saved again. */
  clearProfileCredentialUnavailable(profileId: string): void {
    clearCredentialUnavailable(this.db, profileId);
  }

  /**
   * Records the version of a key this build wrote itself, such as a refreshed ChatGPT token. The profile's endpoint
   * binding is unchanged; only the key version it is confirmed against moves (PLAN-v4 §6c item 6).
   */
  rebindProfileSecret(profileId: string, secretDigest: string): void {
    this.db
      .prepare('UPDATE profile_binding SET secret_digest = ?, updated_at = ? WHERE profile_id = ?')
      .run(secretDigest, this.now(), profileId);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, this.now());
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  getDefaultAssetLibraryDirectory(): string {
    return path.join(os.homedir(), 'joy-media-assets');
  }

  getAssetLibraryDirectory(): string {
    const custom = this.getSetting('asset_library_directory');
    if (custom !== undefined && custom.trim().length > 0) {
      return custom.trim();
    }
    return this.getDefaultAssetLibraryDirectory();
  }

  setAssetLibraryDirectory(dir: string): void {
    this.setSetting('asset_library_directory', dir);
  }

  resetAssetLibraryDirectory(): void {
    this.deleteSetting('asset_library_directory');
  }

  getAssetLibraryInfo(overrideDir?: string): AssetLibraryInfo {
    const dir = overrideDir ?? this.getAssetLibraryDirectory();
    const defaultDir = this.getDefaultAssetLibraryDirectory();
    const isDefault = path.normalize(dir) === path.normalize(defaultDir);
    const exists = fs.existsSync(dir);
    const catalogPath = path.join(dir, 'catalog.json');
    const hasCatalog = fs.existsSync(catalogPath);
    let counts = { total: 0, audio: 0, image: 0 };
    if (hasCatalog) {
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.counts) {
          counts = {
            total: Number(parsed.counts.total ?? 0),
            audio: Number(parsed.counts.audio ?? 0),
            image: Number(parsed.counts.image ?? 0),
          };
        } else if (Array.isArray(parsed.assets)) {
          let audio = 0;
          let image = 0;
          for (const a of parsed.assets) {
            if (a.kind === 'audio') audio++;
            else if (a.kind === 'image') image++;
          }
          counts = { total: parsed.assets.length, audio, image };
        }
      } catch {
        // ignore read error
      }
    }
    return {
      directory: dir,
      exists,
      hasCatalog,
      isDefault,
      counts,
    };
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

/** A profile row with its endpoint binding, if one was recorded. */
const PROFILE_SELECT =
  'SELECT p.*, b.binding_digest AS binding_digest, b.secret_digest AS binding_secret_digest FROM provider_profiles p LEFT JOIN profile_binding b ON b.profile_id = p.id';

function providerProfileFromRow(row: ProviderProfileRow): ProviderProfile {
  let cachedModels: readonly string[] | undefined;
  if (row.cached_models) {
    try {
      cachedModels = JSON.parse(row.cached_models);
    } catch {
      cachedModels = undefined;
    }
  }
  return {
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    ...(cachedModels !== undefined ? { cachedModels } : {}),
    secretHandleId: row.secret_handle_id,
    ...(row.binding_digest && row.binding_secret_digest
      ? { bindingDigest: row.binding_digest, bindingSecretDigest: row.binding_secret_digest }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
