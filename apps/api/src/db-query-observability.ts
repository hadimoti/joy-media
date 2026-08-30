import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';

interface DbQueryContext {
  count: number;
}

const queryContext = new AsyncLocalStorage<DbQueryContext>();
const instrumentedPools = new WeakMap<object, Pool>();
const instrumentedPoolProxies = new WeakSet<object>();

/** Run one HTTP request inside a query-count context. */
export function withDbQueryContext<T>(operation: () => T | Promise<T>): T | Promise<T> {
  return queryContext.run({ count: 0 }, operation);
}

/** Number of SQL statements issued by the current request, or zero outside one. */
export function currentDbQueryCount(): number {
  return queryContext.getStore()?.count ?? 0;
}

function recordQuery(): void {
  const context = queryContext.getStore();
  if (context !== undefined) context.count += 1;
}

function instrumentClient(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (...args: Parameters<PoolClient['query']>) => {
          recordQuery();
          return target.query(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Wrap a pg pool once so both pool.query and transaction client.query calls are
 * counted. The counter is request-scoped, so concurrent requests never share
 * measurements and calls made during startup/migrations stay unreported.
 */
export function instrumentPostgresPool(pool: Pool): Pool {
  if (instrumentedPoolProxies.has(pool)) return pool;
  const existing = instrumentedPools.get(pool);
  if (existing !== undefined) return existing;
  const wrapped = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (...args: Parameters<Pool['query']>) => {
          recordQuery();
          return target.query(...args);
        };
      }
      if (property === 'connect') {
        return async () => instrumentClient(await target.connect());
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Pool;
  instrumentedPools.set(pool, wrapped);
  instrumentedPoolProxies.add(wrapped);
  return wrapped;
}

/** Install a numeric query-count header before either explicit or implicit headers are sent. */
export function attachDbQueryCountHeader(response: {
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): unknown;
  writeHead: ServerResponse['writeHead'];
}): void {
  const writeHead = response.writeHead.bind(response);
  response.writeHead = ((
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders,
  ) => {
    setHeader(response);
    if (typeof statusMessageOrHeaders === 'string') {
      return headers === undefined
        ? writeHead(statusCode, statusMessageOrHeaders)
        : writeHead(statusCode, statusMessageOrHeaders, headers);
    }
    return writeHead(statusCode, statusMessageOrHeaders);
  }) as typeof response.writeHead;
}

function setHeader(response: {
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): unknown;
}): void {
  if (!response.hasHeader('x-joy-db-query-count'))
    response.setHeader('x-joy-db-query-count', String(currentDbQueryCount()));
}
