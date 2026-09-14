import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { POSTGRES_BASELINE_SCHEMA } from './postgres-baseline-schema.js';
import { POSTGRES_MIGRATIONS, runPostgresMigrations } from './postgres-migrations.js';

function createRecordingPool(appliedRows: readonly { id: string; checksum: string }[] = []) {
  const queries: string[] = [];
  const pool = {
    query: async <T>(text: string) => {
      queries.push(text);
      if (text === 'SELECT pg_advisory_xact_lock($1, $2)') return { rows: [] } as { rows: T[] };
      if (text.startsWith('SELECT id, checksum')) return { rows: appliedRows } as { rows: T[] };
      return { rows: [] } as { rows: T[] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function createConcurrentPool() {
  type MigrationRow = { id: string; checksum: string };
  const queries: string[] = [];
  let nextClientId = 0;
  let lockOwner: number | null = null;
  const waiting: Array<() => void> = [];
  const appliedRows: MigrationRow[] = [];
  let baselineRuns = 0;
  let workerLeaseRuns = 0;
  let projectAssetRuns = 0;
  let releaseCalls = 0;

  const wakeNext = () => {
    const next = waiting.shift();
    if (next !== undefined) next();
  };

  const createClient = () => {
    const clientId = ++nextClientId;
    return {
      query: async <T>(text: string, values?: readonly unknown[]) => {
        queries.push(`client-${clientId}:${text}`);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK')
          return { rows: [] } as { rows: T[] };
        if (text === 'SELECT pg_advisory_xact_lock($1, $2)') {
          if (lockOwner === null) {
            lockOwner = clientId;
            return { rows: [] } as { rows: T[] };
          }
          await new Promise<void>((resolve) => waiting.push(resolve));
          lockOwner = clientId;
          return { rows: [] } as { rows: T[] };
        }
        if (text.startsWith('CREATE TABLE IF NOT EXISTS joy_media_schema_migrations'))
          return { rows: [] } as { rows: T[] };
        if (text.startsWith('SELECT id, checksum FROM joy_media_schema_migrations'))
          return { rows: [...appliedRows] } as { rows: T[] };
        if (text.startsWith('INSERT INTO joy_media_schema_migrations')) {
          appliedRows.push({
            id: String(values?.[0] ?? ''),
            checksum: String(values?.[1] ?? ''),
          });
          return { rows: [] } as { rows: T[] };
        }
        if (text.includes("SELECT to_regclass('public.asset_revocation_audits')"))
          return { rows: [{ exists: false }] } as { rows: T[] };
        if (text.includes('CREATE TABLE IF NOT EXISTS projects')) {
          baselineRuns += 1;
          return { rows: [] } as { rows: T[] };
        }
        if (text.includes('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation')) {
          workerLeaseRuns += 1;
          return { rows: [] } as { rows: T[] };
        }
        if (text.includes('CREATE TABLE IF NOT EXISTS media_asset_access')) {
          projectAssetRuns += 1;
          return { rows: [] } as { rows: T[] };
        }
        return { rows: [] } as { rows: T[] };
      },
      release: () => {
        if (lockOwner === clientId) {
          lockOwner = null;
          wakeNext();
        }
        releaseCalls += 1;
      },
    };
  };

  const pool = {
    connect: async () => createClient(),
  } as unknown as Pool;

  return {
    pool,
    queries,
    get baselineRuns() {
      return baselineRuns;
    },
    get workerLeaseRuns() {
      return workerLeaseRuns;
    },
    get projectAssetRuns() {
      return projectAssetRuns;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    get appliedRows() {
      return [...appliedRows];
    },
  };
}

describe('ordered PostgreSQL migrations', () => {
  it('keeps the recorded baseline definition byte-for-byte stable', () => {
    expect(createHash('sha256').update(POSTGRES_BASELINE_SCHEMA).digest('hex')).toBe(
      '6044f0fbe21a3fb9ec46fc0a95f022842f1a0463fba94cdd53d4da844c4a23a1',
    );
    expect(POSTGRES_BASELINE_SCHEMA).not.toContain('lease_token');
    expect(POSTGRES_BASELINE_SCHEMA).not.toContain('media_asset_access');
  });

  it('creates the ledger, applies each migration once, and records checksums', async () => {
    const { pool, queries } = createRecordingPool();

    await runPostgresMigrations(pool);

    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
    expect(queries[2]).toContain('CREATE TABLE IF NOT EXISTS joy_media_schema_migrations');
    expect(
      queries.filter((query) => query.startsWith('INSERT INTO joy_media_schema_migrations')),
    ).toHaveLength(POSTGRES_MIGRATIONS.length);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS projects'))).toBe(
      true,
    );
    expect(
      queries.some((query) =>
        query.includes('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation'),
      ),
    ).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
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

  it('uses a dedicated transaction session and advisory lock when a pool can connect', async () => {
    const { pool, queries } = createConcurrentPool();

    await runPostgresMigrations(pool);

    expect(queries[0]).toBe('client-1:BEGIN');
    expect(queries[1]).toBe('client-1:SELECT pg_advisory_xact_lock($1, $2)');
    expect(queries.at(-1)).toBe('client-1:COMMIT');
  });

  it('serializes concurrent startup migrations and records each migration once', async () => {
    const concurrent = createConcurrentPool();

    await Promise.all([
      runPostgresMigrations(concurrent.pool),
      runPostgresMigrations(concurrent.pool),
    ]);

    expect(concurrent.baselineRuns).toBe(1);
    expect(concurrent.workerLeaseRuns).toBe(1);
    expect(concurrent.projectAssetRuns).toBe(1);
    expect(concurrent.appliedRows).toEqual(
      POSTGRES_MIGRATIONS.map(({ id, checksum }) => ({ id, checksum })),
    );
    expect(
      concurrent.queries.filter((query) => query.includes('SELECT pg_advisory_xact_lock($1, $2)')),
    ).toHaveLength(2);
    expect(concurrent.releaseCalls).toBe(2);
  });

  it('tolerates adapters that do not implement advisory locks', async () => {
    const queries: string[] = [];
    const pool = {
      query: async <T>(text: string) => {
        queries.push(text);
        if (text === 'SELECT pg_advisory_xact_lock($1, $2)')
          throw new Error('Unknown function pg_advisory_xact_lock');
        if (text.startsWith('SELECT id, checksum')) return { rows: [] } as { rows: T[] };
        return { rows: [] } as { rows: T[] };
      },
    } as unknown as Pool;

    await expect(runPostgresMigrations(pool)).resolves.toBeUndefined();
    expect(queries).toContain('SELECT pg_advisory_xact_lock($1, $2)');
    expect(
      queries.filter((query) => query.startsWith('INSERT INTO joy_media_schema_migrations')),
    ).toHaveLength(POSTGRES_MIGRATIONS.length);
  });

  it('does not attempt the legacy revocation repair on a fresh current schema', async () => {
    const { pool, queries } = createRecordingPool();
    await POSTGRES_MIGRATIONS[1]!.up(pool);
    expect(queries.some((query) => query.includes('ALTER TABLE asset_revocation_audits'))).toBe(
      false,
    );
  });

  it('adds the additive nullable look_instances column (006, R2 / GAP 1a)', async () => {
    const migration = POSTGRES_MIGRATIONS.find((m) => m.id === '006-look-instances');
    expect(migration).toBeDefined();
    const queries: string[] = [];
    await migration!.up({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });
    expect(
      queries.some((q) =>
        /ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS look_instances jsonb/i.test(q),
      ),
    ).toBe(true);
    // Additive + nullable — never NOT NULL, never a DROP.
    expect(queries.some((q) => /NOT NULL|DROP/i.test(q))).toBe(false);
  });

  it('creates the account devices/subscriptions/release-metadata tables (007)', async () => {
    const migration = POSTGRES_MIGRATIONS.find(
      (m) => m.id === '007-account-devices-subscriptions-entitlements',
    );
    expect(migration).toBeDefined();
    const queries: string[] = [];
    await migration!.up({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });
    const combined = queries.join('\n');
    expect(combined).toContain('CREATE TABLE IF NOT EXISTS account_devices');
    expect(combined).toContain('CREATE TABLE IF NOT EXISTS account_subscriptions');
    expect(combined).toContain('CREATE TABLE IF NOT EXISTS release_metadata');
  });

  it('creates the usdc_invoices table with its uniqueness indexes (008)', async () => {
    const migration = POSTGRES_MIGRATIONS.find((m) => m.id === '008-usdc-invoices');
    expect(migration).toBeDefined();
    const queries: string[] = [];
    await migration!.up({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });
    const combined = queries.join('\n');
    expect(combined).toContain('CREATE TABLE IF NOT EXISTS usdc_invoices');
    expect(combined).toContain('usdc_invoices_pending_amount_idx');
    expect(combined).toContain('usdc_invoices_txhash_logindex_idx');
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
