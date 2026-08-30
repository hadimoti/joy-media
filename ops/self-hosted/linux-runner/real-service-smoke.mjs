/* global process, URL */

import pg from 'pg';

const connectionString = process.env.JOY_MEDIA_CI_DATABASE_URL;
if (!connectionString) throw new Error('JOY_MEDIA_CI_DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
try {
  const migrationModule = await import(
    new URL('../../../apps/api/dist/postgres-migrations.js', import.meta.url)
  );
  await migrationModule.runPostgresMigrations(pool);
  const ledger = await pool.query('SELECT id FROM joy_media_schema_migrations ORDER BY id');
  const ids = ledger.rows.map((row) => row.id);
  const expected = [
    '001-baseline',
    '002-asset-revocation-revoke-id-primary-key',
    '003-worker-lease-generation',
    '004-project-asset-access',
  ];
  if (ids.join('\0') !== expected.join('\0')) {
    throw new Error(`migration ledger mismatch: ${ids.join(',')}`);
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
