import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import type { PrivateObjectStore } from './private-object-store.js';
import { productionReadinessOptions } from './server-readiness.js';

const configuredPrivateObjectStore = {} as PrivateObjectStore;

describe('production readiness wiring', () => {
  it('probes PostgreSQL and the critical control-plane schema without reading rows', async () => {
    const queries: string[] = [];
    const readiness = productionReadinessOptions({
      pool: {
        async query(sql) {
          queries.push(sql);
          return {};
        },
      },
      durableControlPlane: new LocalControlPlane(),
      privateObjectStore: configuredPrivateObjectStore,
    });
    const checks = readiness.checks!;

    await expect(checks.database!()).resolves.toBe(true);
    await expect(checks.controlPlane!()).resolves.toBe(true);
    expect(checks.privateObjectStore!()).toBe(true);
    expect(queries).toEqual([
      'SELECT 1',
      'SELECT 1 FROM projects, project_documents, media_assets, jobs LIMIT 0',
    ]);
  });

  it('fails closed when production dependencies are not configured', async () => {
    const checks = productionReadinessOptions({
      pool: undefined,
      durableControlPlane: undefined,
      privateObjectStore: undefined,
    }).checks!;

    await expect(checks.database!()).resolves.toBe(false);
    await expect(checks.controlPlane!()).resolves.toBe(false);
    expect(checks.privateObjectStore!()).toBe(false);
  });

  it('propagates database and schema probe failures to the readiness boundary', async () => {
    const failure = new Error('database unavailable');
    const checks = productionReadinessOptions({
      pool: { query: async () => Promise.reject(failure) },
      durableControlPlane: new LocalControlPlane(),
      privateObjectStore: configuredPrivateObjectStore,
    }).checks!;

    await expect(checks.database!()).rejects.toBe(failure);
    await expect(checks.controlPlane!()).rejects.toBe(failure);
  });

  it('does not claim control-plane readiness from database connectivity alone', async () => {
    let queries = 0;
    const checks = productionReadinessOptions({
      pool: {
        async query() {
          queries++;
          return {};
        },
      },
      durableControlPlane: undefined,
      privateObjectStore: configuredPrivateObjectStore,
    }).checks!;

    await expect(checks.database!()).resolves.toBe(true);
    await expect(checks.controlPlane!()).resolves.toBe(false);
    expect(queries).toBe(1);
  });
});
