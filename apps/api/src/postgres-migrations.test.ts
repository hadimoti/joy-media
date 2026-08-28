import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { POSTGRES_MIGRATIONS, runPostgresMigrations } from './postgres-migrations.js';

function createRecordingPool(appliedRows: readonly { id: string; checksum: string }[] = []) {
  const queries: string[] = [];
  const pool = {
    query: async <T>(text: string) => {
      queries.push(text);
      if (text.startsWith('SELECT id, checksum')) return { rows: appliedRows } as { rows: T[] };
      return { rows: [] } as { rows: T[] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe('ordered PostgreSQL migrations', () => {
  it('creates the ledger, applies each migration once, and records checksums', async () => {
    const { pool, queries } = createRecordingPool();

    await runPostgresMigrations(pool);

    expect(queries[0]).toContain('CREATE TABLE IF NOT EXISTS joy_media_schema_migrations');
    expect(
      queries.filter((query) => query.startsWith('INSERT INTO joy_media_schema_migrations')),
    ).toHaveLength(POSTGRES_MIGRATIONS.length);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS projects'))).toBe(
      true,
    );
  });

  it('does not rerun an already applied migration with the same checksum', async () => {
    const applied = POSTGRES_MIGRATIONS.map(({ id, checksum }) => ({ id, checksum }));
    const { pool, queries } = createRecordingPool(applied);

    await runPostgresMigrations(pool);

    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS projects'))).toBe(
      false,
    );
    expect(
      queries.some((query) => query.startsWith('INSERT INTO joy_media_schema_migrations')),
    ).toBe(false);
  });

  it('does not attempt the legacy revocation repair on a fresh current schema', async () => {
    const { pool, queries } = createRecordingPool();
    await POSTGRES_MIGRATIONS[1]!.up(pool);
    expect(queries.some((query) => query.includes('ALTER TABLE asset_revocation_audits'))).toBe(
      false,
    );
  });

  it('fails closed when an applied migration checksum has drifted', async () => {
    const { pool } = createRecordingPool([
      { id: POSTGRES_MIGRATIONS[0]!.id, checksum: 'sha256:unexpected' },
    ]);

    await expect(runPostgresMigrations(pool)).rejects.toThrow(
      'PostgreSQL migration checksum mismatch for 001-baseline',
    );
  });
});
