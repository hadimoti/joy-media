import type { Pool, PoolClient } from 'pg';
import { POSTGRES_BASELINE_SCHEMA } from './postgres-baseline-schema.js';

type MigrationDatabase = Pool | PoolClient;
type MigrationSession = Pick<PoolClient, 'query'>;
type MigrationQueryable = {
  readonly query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

export interface PostgresMigration {
  readonly id: string;
  readonly checksum: string;
  readonly up: (database: MigrationQueryable) => Promise<void>;
}

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS joy_media_schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);`;
const MIGRATION_LOCK_NAMESPACE = 0x4a4f59;
const MIGRATION_LOCK_KEY = 0x4d454449;

/**
 * The baseline is intentionally kept as a frozen source snapshot. New schema
 * changes must be appended as a new migration instead of editing an already
 * applied migration. The ledger checksum turns accidental edits into a
 * startup failure rather than silent schema drift.
 */
const BASELINE_MIGRATION: PostgresMigration = {
  id: '001-baseline',
  // This is the checksum recorded by the currently deployed JOY Media
  // release. Keep the baseline immutable; additive schema changes belong in
  // a new migration so an older release can still start during rollback.
  checksum: 'sha256:6044f0fbe21a3fb9ec46fc0a95f022842f1a0463fba94cdd53d4da844c4a23a1',
  up: async (database) => {
    await database.query(POSTGRES_BASELINE_SCHEMA);
  },
};

async function repairAssetRevocationPrimaryKey(database: MigrationQueryable): Promise<void> {
  // The current JOY Media schema does not create the historical revocation
  // audit table. Only repair it when it exists on a legacy installation;
  // otherwise a fresh install must not fail while altering a missing table.
  let tableExists = false;
  try {
    const result = await database.query(
      "SELECT to_regclass('public.asset_revocation_audits') IS NOT NULL AS exists",
    );
    tableExists = result.rows[0]?.['exists'] === true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/to_regclass|unsupported|pg_catalog/iu.test(message)) return;
    throw error;
  }
  if (!tableExists) return;

  // A legacy installation may have a composite primary key and rows created
  // before revoke_id existed. Allocate IDs before adding the new constraint.
  try {
    await database.query(
      `CREATE SEQUENCE IF NOT EXISTS asset_revocation_audits_revoke_id_seq;
       ALTER TABLE asset_revocation_audits
         ALTER COLUMN revoke_id SET DEFAULT nextval('asset_revocation_audits_revoke_id_seq');
       SELECT setval(
         'asset_revocation_audits_revoke_id_seq',
         COALESCE((SELECT MAX(revoke_id) FROM asset_revocation_audits), 0) + 1,
         false
       );
       UPDATE asset_revocation_audits
          SET revoke_id = nextval('asset_revocation_audits_revoke_id_seq')
        WHERE revoke_id IS NULL;`,
    );
  } catch (error) {
    // pg-mem does not expose all sequence/catalog behavior. Fresh emulator
    // schemas already have a non-null primary key, so tolerate only the
    // documented emulator limitation and surface real migration failures.
    const message = error instanceof Error ? error.message : String(error);
    if (!/(sequence|nextval|pg_catalog|unsupported)/iu.test(message)) throw error;
  }

  let result: { rows: readonly { indexname: string; indexdef: string }[] };
  try {
    result = (await database.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'asset_revocation_audits'`,
    )) as { rows: readonly { readonly indexname: string; readonly indexdef: string }[] };
  } catch (error) {
    // pg-mem does not expose PostgreSQL catalog views. Its fresh schema has
    // the correct primary key, so there is nothing to repair in that adapter.
    if (
      error instanceof Error &&
      /(relation|table) [^ ]*pg_indexes[^ ]* does not exist/iu.test(error.message)
    ) {
      return;
    }
    throw error;
  }

  const primaryIndexes = result.rows.filter((row) => /_pkey$/iu.test(row.indexname));
  const actual = primaryIndexes.find((row) => /revoke_id/iu.test(row.indexdef));
  const legacy = primaryIndexes.find((row) => !/revoke_id/iu.test(row.indexdef));
  if (legacy !== undefined) {
    await database.query(
      `ALTER TABLE asset_revocation_audits DROP CONSTRAINT "${legacy.indexname.replace(/"/g, '""')}"`,
    );
  }
  if (actual === undefined) {
    try {
      await database.query(
        'ALTER TABLE asset_revocation_audits ADD CONSTRAINT asset_revocation_audits_revoke_id_pkey PRIMARY KEY (revoke_id)',
      );
    } catch (error) {
      if (!(error instanceof Error) || !/already has a primary key/iu.test(error.message))
        throw error;
    }
  }
}

const ASSET_REVOCATION_PRIMARY_KEY_MIGRATION: PostgresMigration = {
  id: '002-asset-revocation-revoke-id-primary-key',
  checksum: 'sha256:asset-revocation-revoke-id-primary-key-2026-08-28',
  up: repairAssetRevocationPrimaryKey,
};

const WORKER_LEASE_GENERATION_MIGRATION: PostgresMigration = {
  id: '003-worker-lease-generation',
  checksum: 'sha256:worker-lease-generation-2026-08-29',
  up: async (database) => {
    await database.query(`
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token text;
      ALTER TABLE job_attempts ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;
    `);
  },
};

const PROJECT_ASSET_ACCESS_MIGRATION: PostgresMigration = {
  id: '004-project-asset-access',
  checksum: 'sha256:project-asset-access-2026-08-29',
  up: async (database) => {
    await database.query(`
      CREATE TABLE IF NOT EXISTS media_asset_access (
        project_id text NOT NULL,
        asset_id text NOT NULL,
        source_project_id text NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (project_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS media_asset_access_source_idx
        ON media_asset_access (source_project_id, asset_id);
    `);
  },
};

const STOCK_VIDEO_MIGRATION: PostgresMigration = {
  id: '005-stock-video',
  checksum: 'sha256:stock-video-2026-09-04',
  up: async (database) => {
    await database.query(`
      CREATE TABLE IF NOT EXISTS stock_video_catalog (
        id text PRIMARY KEY, provider text NOT NULL, provider_asset_id text NOT NULL,
        category text NOT NULL, title text NOT NULL, creator text NOT NULL,
        source_page_url text NOT NULL, terms_url text NOT NULL, rendition_id text NOT NULL,
        media_url text NOT NULL, poster_url text NOT NULL, mime_type text NOT NULL,
        width integer NOT NULL, height integer NOT NULL, duration_seconds integer NOT NULL,
        orientation text NOT NULL, retrieved_at timestamptz NOT NULL, expires_at timestamptz,
        UNIQUE (provider, provider_asset_id, rendition_id)
      );
      CREATE INDEX IF NOT EXISTS stock_video_catalog_category_idx ON stock_video_catalog (category, retrieved_at DESC);
      CREATE TABLE IF NOT EXISTS stock_video_search_cache (
        cache_key text PRIMARY KEY, response_version integer NOT NULL, candidates jsonb NOT NULL,
        fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stock_video_imports (
        id text PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL, catalog_id text NOT NULL,
        provider text NOT NULL, provider_asset_id text NOT NULL, rendition_id text NOT NULL,
        state text NOT NULL, attempt integer NOT NULL DEFAULT 0, asset_id text,
        object_sha256 text, object_bytes bigint, error_code text, updated_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (owner_id, provider, provider_asset_id, rendition_id)
      );
      CREATE INDEX IF NOT EXISTS stock_video_imports_owner_project_idx ON stock_video_imports (owner_id, project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS media_asset_sources (
        asset_id text PRIMARY KEY, provider text NOT NULL, provider_asset_id text NOT NULL,
        creator text NOT NULL, source_page_url text NOT NULL, terms_url text NOT NULL,
        retrieved_at timestamptz NOT NULL, rendition_id text NOT NULL, sha256 text NOT NULL,
        bytes bigint NOT NULL, width integer NOT NULL, height integer NOT NULL, duration_seconds integer NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_asset_sources_provider_idx ON media_asset_sources (provider, provider_asset_id, rendition_id);
    `);
  },
};

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  BASELINE_MIGRATION,
  ASSET_REVOCATION_PRIMARY_KEY_MIGRATION,
  WORKER_LEASE_GENERATION_MIGRATION,
  PROJECT_ASSET_ACCESS_MIGRATION,
  STOCK_VIDEO_MIGRATION,
];

export async function runPostgresMigrations(database: MigrationDatabase): Promise<void> {
  await withMigrationSession(database, async (session) => {
    await session.query('BEGIN');
    try {
      await acquireMigrationLock(session);
      await session.query(MIGRATION_LEDGER_SQL);
      const applied = await session.query<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM joy_media_schema_migrations ORDER BY id',
      );
      const appliedById = new Map(applied.rows.map((row) => [row.id, row.checksum]));

      for (const migration of POSTGRES_MIGRATIONS) {
        const previous = appliedById.get(migration.id);
        if (previous !== undefined) {
          if (previous !== migration.checksum) {
            throw new Error(`PostgreSQL migration checksum mismatch for ${migration.id}`);
          }
          continue;
        }

        await migration.up(session);
        await session.query(
          'INSERT INTO joy_media_schema_migrations (id, checksum, applied_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
          [migration.id, migration.checksum],
        );
        appliedById.set(migration.id, migration.checksum);
      }

      await session.query('COMMIT');
    } catch (error) {
      try {
        await session.query('ROLLBACK');
      } catch {
        // Preserve the original migration failure if the transaction is already aborted.
      }
      throw error;
    }
  });
}

async function withMigrationSession(
  database: MigrationDatabase,
  action: (session: MigrationSession) => Promise<void>,
): Promise<void> {
  if (!hasConnect(database)) {
    await action(database);
    return;
  }
  const client = await database.connect();
  try {
    await action(client);
  } finally {
    client.release();
  }
}

async function acquireMigrationLock(session: MigrationSession): Promise<void> {
  try {
    await session.query('SELECT pg_advisory_xact_lock($1, $2)', [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_KEY,
    ]);
  } catch (error) {
    if (isUnsupportedAdvisoryLockError(error)) return;
    throw error;
  }
}

function hasConnect(database: MigrationDatabase): database is Pool {
  return typeof (database as Pool).connect === 'function';
}

function isUnsupportedAdvisoryLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(pg_advisory_xact_lock|unknown function|not supported|unsupported)/iu.test(error.message);
}
