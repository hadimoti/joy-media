import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPostgresMigrations } from './postgres-migrations.js';
import { UsdcInvoiceLedger } from './usdc-invoice-ledger.js';

const databaseUrl = process.env.JOY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('UsdcInvoiceLedger with PostgreSQL', () => {
  let adminPool: Pool | undefined;
  let testPool: Pool | undefined;
  let schema: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('JOY_TEST_DATABASE_URL is required for this suite');

    adminPool = new Pool({ connectionString: databaseUrl });
    schema = `joy_media_test_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    testPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runPostgresMigrations(testPool);
  });

  afterAll(async () => {
    try {
      await testPool?.end();
    } finally {
      try {
        if (adminPool && schema) {
          await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
      } finally {
        await adminPool?.end();
      }
    }
  });

  it('serializes concurrent retries into one pending invoice', async () => {
    if (!testPool) throw new Error('PostgreSQL test pool was not initialized');

    let nextNudge = 0;
    let nextId = 0;
    const requestCount = 10;
    let initialLookups = 0;
    let releaseInitialLookups: () => void = () => {};
    const allInitialLookups = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });
    const query = testPool.query.bind(testPool);
    const concurrentPool = {
      query: async (text: string, values?: readonly unknown[]) => {
        const result = await query(text, values as never);
        if (text.includes('WHERE owner_id = $1 AND plan = $2') && initialLookups < requestCount) {
          initialLookups += 1;
          if (initialLookups === requestCount) releaseInitialLookups();
          await allInitialLookups;
        }
        return result;
      },
    } as unknown as Pool;
    const ledger = new UsdcInvoiceLedger({
      pool: concurrentPool,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      chainId: 1,
      catalog: [
        { plan: 'monthly', usd: '12.00' },
        { plan: 'yearly', usd: '120.00' },
      ],
      idFactory: () => `invoice-${++nextId}`,
      nudgeFactory: () => nextNudge++,
    });

    const invoices = await Promise.all(
      Array.from({ length: requestCount }, () =>
        ledger.createInvoice('owner@example.com', 'monthly'),
      ),
    );

    expect(new Set(invoices.map((invoice) => invoice.id))).toEqual(new Set([invoices[0]?.id]));
    const pending = await testPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM usdc_invoices WHERE owner_id = $1 AND plan = 'monthly' AND status = 'pending'",
      ['owner@example.com'],
    );
    expect(pending.rows[0]?.count).toBe('1');
  });
});
