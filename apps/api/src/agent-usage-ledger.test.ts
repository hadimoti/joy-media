import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  MemoryAgentUsageLedger,
  PostgresAgentUsageLedger,
  SPEND_RESERVATION_TTL_MS,
} from './agent-usage-ledger.js';

describe('agent spend reservation expiry', () => {
  afterEach(() => vi.useRealTimers());

  it('ignores reservations older than the TTL using an injected clock', async () => {
    let now = 1_800_000_000_000;
    const ledger = new MemoryAgentUsageLedger(() => now);
    const day = new Date('2026-10-04T00:00:00Z');
    await ledger.reserveSpend('owner', day, 90n, 100n);
    now += SPEND_RESERVATION_TTL_MS + 1;
    await expect(ledger.reserveSpend('owner', day, 90n, 100n)).resolves.toBeTruthy();
  });

  it('sweeps Postgres reservations at startup and applies transaction timeouts and TTL filtering', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('AS reserved')) return { rows: [{ spent: '0', reserved: '0' }] };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const ledger = new PostgresAgentUsageLedger(pool);
    await ledger.reserveSpend('owner', new Date('2026-10-04T00:00:00Z'), 1n, 100n);
    await Promise.resolve();
    expect(
      queries.some((sql) =>
        sql.includes("created_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'"),
      ),
    ).toBe(true);
    expect(queries).toContain("SET LOCAL lock_timeout = '5s'");
    expect(queries).toContain("SET LOCAL statement_timeout = '5s'");
    expect(
      queries.some((sql) => sql.includes("created_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes'")),
    ).toBe(true);
  });

  it.each(['55P03', '57014'])('maps postgres timeout %s to SPEND_LEDGER_BUSY', async (code) => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock'))
          throw Object.assign(new Error('timeout'), { code });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const ledger = new PostgresAgentUsageLedger(pool);
    await expect(ledger.reserveSpend('owner', new Date(), 1n, 100n)).rejects.toThrow(
      'SPEND_LEDGER_BUSY',
    );
  });
});
