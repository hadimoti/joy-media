import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_SCHEMA } from './postgres-schema.js';

type MigrationDatabase = Pool | PoolClient;

export interface PostgresMigration {
  readonly id: string;
  readonly checksum: string;
  readonly up: (database: MigrationDatabase) => Promise<void>;
}

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS joy_media_schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);`;

/**
 * The baseline is intentionally kept as a frozen source snapshot. New schema
 * changes must be appended as a new migration instead of editing an already
 * applied migration. The ledger checksum turns accidental edits into a
 * startup failure rather than silent schema drift.
 */
const BASELINE_MIGRATION: PostgresMigration = {
  id: '001-baseline',
  checksum: `sha256:${createHash('sha256').update(POSTGRES_SCHEMA).digest('hex')}`,
  up: async (database) => {
    await database.query(POSTGRES_SCHEMA);
  },
};

async function repairAssetRevocationPrimaryKey(database: MigrationDatabase): Promise<void> {
  // The current JOY Media schema does not create the historical revocation
  // audit table. Only repair it when it exists on a legacy installation;
  // otherwise a fresh install must not fail while altering a missing table.
  let tableExists = false;
  try {
    const result = await database.query<{ readonly exists: boolean }>(
      "SELECT to_regclass('public.asset_revocation_audits') IS NOT NULL AS exists",
    );
    tableExists = result.rows[0]?.exists === true;
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
    result = await database.query<{
      readonly indexname: string;
      readonly indexdef: string;
    }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'asset_revocation_audits'`,
    );
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

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  BASELINE_MIGRATION,
  ASSET_REVOCATION_PRIMARY_KEY_MIGRATION,
];

export async function runPostgresMigrations(database: MigrationDatabase): Promise<void> {
  await database.query(MIGRATION_LEDGER_SQL);
  const applied = await database.query<{ id: string; checksum: string }>(
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

    await migration.up(database);
    await database.query(
      'INSERT INTO joy_media_schema_migrations (id, checksum, applied_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [migration.id, migration.checksum],
    );
  }
}
