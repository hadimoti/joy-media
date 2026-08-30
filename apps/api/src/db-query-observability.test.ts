import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  attachDbQueryCountHeader,
  currentDbQueryCount,
  instrumentPostgresPool,
  withDbQueryContext,
} from './db-query-observability.js';

function fakePool(): Pool {
  const client = {
    query: async () => ({ rows: [] }),
    release: () => undefined,
  };
  return {
    query: async () => ({ rows: [] }),
    connect: async () => client,
  } as unknown as Pool;
}

describe('db query observability', () => {
  it('counts pool and transaction-client statements only within the request context', async () => {
    const pool = instrumentPostgresPool(fakePool());
    expect(currentDbQueryCount()).toBe(0);

    await withDbQueryContext(async () => {
      await pool.query('select 1');
      expect(currentDbQueryCount()).toBe(1);
      const client = await pool.connect();
      await client.query('select 2');
      expect(currentDbQueryCount()).toBe(2);
      client.release();
    });

    expect(currentDbQueryCount()).toBe(0);
  });

  it('is idempotent when the shared pool is passed through multiple services', () => {
    const pool = fakePool();
    expect(instrumentPostgresPool(instrumentPostgresPool(pool))).toBe(instrumentPostgresPool(pool));
  });

  it('writes the count before explicit response headers are committed', async () => {
    const pool = instrumentPostgresPool(fakePool());
    const headers = new Map<string, string>();
    let headersSent = false;
    const response = {
      hasHeader: (name: string) => headers.has(name),
      setHeader: (name: string, value: string) => {
        headers.set(name, value);
        return response;
      },
      get headersSent() {
        return headersSent;
      },
      writeHead: (_status: number, _headers?: Record<string, string>) => {
        headersSent = true;
        return response;
      },
      end: (_chunk?: unknown) => response,
    } as unknown as Parameters<typeof attachDbQueryCountHeader>[0];
    attachDbQueryCountHeader(response);

    await withDbQueryContext(async () => {
      await pool.query('select 1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });

    expect(headers.get('x-joy-db-query-count')).toBe('1');
  });

  it('writes the count before implicit headers are committed by response.end', async () => {
    const pool = instrumentPostgresPool(fakePool());
    const headers = new Map<string, string>();
    const response = {
      hasHeader: (name: string) => headers.has(name),
      setHeader: (name: string, value: string) => {
        headers.set(name, value);
        return response;
      },
      writeHead: (_status: number, _headers?: Record<string, string>) => response,
      end: (_chunk?: unknown) => response,
    } as unknown as Parameters<typeof attachDbQueryCountHeader>[0];
    attachDbQueryCountHeader(response);

    await withDbQueryContext(async () => {
      await pool.query('select 1');
      response.end(JSON.stringify({ ok: true }));
    });

    expect(headers.get('x-joy-db-query-count')).toBe('1');
  });
});
