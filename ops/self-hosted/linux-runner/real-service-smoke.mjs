/* global process, URL */

import { createRequire } from 'node:module';

// This smoke script lives outside the API package, while `pg` is intentionally
// scoped to that package in the pnpm workspace. Resolve it from the API package
// manifest so the check works from a clean runner without a root dependency.
const requireFromApi = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');

const connectionString = process.env.JOY_MEDIA_CI_DATABASE_URL;
if (!connectionString) throw new Error('JOY_MEDIA_CI_DATABASE_URL is required');

const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
try {
  const migrationModule = await import(
    new URL('../../../apps/api/dist/postgres-migrations.js', import.meta.url)
  );
  await migrationModule.runPostgresMigrations(pool);
  const ledger = await pool.query('SELECT id FROM joy_media_schema_migrations ORDER BY id');
  const ids = ledger.rows.map((row) => row.id);
  // Derive the expected ledger from the shipped migration list so this check
  // stays correct as migrations are added, rather than drifting behind a
  // hardcoded array.
  const expected = [...migrationModule.POSTGRES_MIGRATIONS].map((migration) => migration.id).sort();
  if (ids.join('\0') !== expected.join('\0')) {
    throw new Error(
      `migration ledger mismatch: ledger=[${ids.join(',')}] expected=[${expected.join(',')}]`,
    );
  }
  const tables = await pool.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('projects', 'jobs', 'media_asset_access')
      ORDER BY table_name`,
  );
  if (tables.rows.length !== 3) throw new Error('critical migrated tables are missing');
} finally {
  await pool.end();
}
